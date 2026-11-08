import { createHash, randomUUID } from 'node:crypto';
import type { ElementHandle, Page, Request } from 'playwright-core';

import { PageOperationGate } from '../../browser/page-operation-gate.ts';
import type { OwnedPageIdentity } from '../../browser/owned-page-lifecycle.ts';
import type {
  SemanticActRequest, SemanticActResult, SemanticActionCandidate,
  SemanticActionPurpose, SemanticDispatchEvidence, SemanticExactQuery, SemanticObservation,
  SemanticProviderAdapter, SemanticTaskContext, SemanticVerification,
} from '../semantic-adapter.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from './backend-recovery.ts';
import { observeChatGptDialog } from './dialog-observer.ts';
import { observeChatGptDom, observeChatGptAlerts } from './dom-observer.ts';
import { inspectChatGptQuestion, answerChatGptQuestion } from './question.ts';
import { inspectChatGptFreeTextQuestion, answerChatGptFreeTextQuestion } from './semantic-free-text-question.ts';
import { observeChatGptSurface } from './surface.ts';

const EDITORS = 'main :is(#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea, [role="textbox"])';
const BUTTONS = 'main :is(button, [role="button"])';
const MAX_PACKET_BYTES = 12 * 1024;
const MAX_DRAFT = 16_000;
const REF_TTL_MS = 30_000;
const SEND_LABEL = /^(send|send message|submit|전송|보내기|메시지 전송)$/i;

interface Control {
  readonly index: number;
  readonly signature: string;
  readonly value: string;
  readonly enabled: boolean;
}
interface UiSnapshot {
  readonly editors: readonly Control[];
  readonly buttons: readonly Control[];
  readonly draftSha256: string | null;
  readonly fingerprint: string;
}
interface CachedAction {
  readonly purpose: SemanticActionPurpose;
  readonly evidenceHash: string;
  readonly uiFingerprint: string;
  readonly contextKey: string;
  readonly expiresAtMs: number;
  readonly questionHash: string | null;
}
interface ActiveSnapshot {
  readonly snapshotId: string;
  readonly actions: Map<string, CachedAction>;
}
export interface ChatGptSemanticAdapterOptions {
  /** Exact Task/slot/page lease from the Core, including binding epoch. */
  readonly isExactLease: (identity: OwnedPageIdentity) => boolean;
  readonly resolvePage: (identity: OwnedPageIdentity) => Promise<Page> | Page;
  /** Production accepts only ChatGPT's trusted HTTPS origins. Test overrides are isolated fixtures. */
  readonly allowedPageOrigins?: readonly string[];
  readonly backendOrigin?: string;
  readonly backendClient?: BackendJsonClient;
  readonly backendRecovery?: ChatGptBackendRecovery;
  /** Must check the Core's journaled attempt and exact task/slot authorization. */
  readonly isAuthorizedAttempt?: (input: {
    context: SemanticTaskContext; purpose: SemanticActionPurpose;
    attemptId: string; contentSha256: string | null; input: string | null;
  }) => boolean | Promise<boolean>;
}

/**
 * B-first semantic port. All selectors and DOM fallbacks stay here; the
 * DurableTaskKernel sees only semantic choices. Existing canonical backend
 * parsers prove ACK/FINAL. An act receipt is never an ACK.
 */
export class ChatGptSemanticAdapter implements SemanticProviderAdapter {
  readonly providerKey = 'chatgpt';
  readonly capabilities = Object.freeze({
    providerKey: 'chatgpt', browserRequired: true, contractVersion: 1 as const,
    supports: ['conversation', 'question', 'continuation'] as const,
  });
  readonly #options: ChatGptSemanticAdapterOptions;
  readonly #gate: PageOperationGate;
  readonly #backend: ChatGptBackendRecovery;
  readonly #latest = new Map<string, ActiveSnapshot>();

  constructor(options: ChatGptSemanticAdapterOptions) {
    this.#options = options;
    this.#gate = new PageOperationGate(options.isExactLease);
    this.#backend = options.backendRecovery ?? new ChatGptBackendRecovery({
      requestTimeoutMs: 15_000, tokenCacheTtlMs: 60_000,
    });
  }

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    const { lease, page } = await this.#exactPage(context);
    const observedAt = new Date().toISOString();
    const snapshotId = randomUUID();
    const actions: SemanticActionCandidate[] = [];
    const cached = new Map<string, CachedAction>();
    let blocker: SemanticObservation['blocker'] = 'none';
    let reason: string | null = null;
    let progress: SemanticObservation['progress'] = 'unknown';
    let turn: SemanticObservation['turn'] = {
      submittedUserFound: false, laterUserFound: false,
      submittedUserMessageId: context.submittedUserMessageId,
      answerMessageId: null, partialAnswer: null,
    };

    const surface = await observeChatGptSurface(page);
    const dialog = await observeChatGptDialog(page);
    const ui = await captureUi(page);
    if (context.submittedUserMessageId !== null || context.submittedUserTurnId !== null) {
      const dom = await observeChatGptDom(page, {
        submittedUserMessageId: context.submittedUserMessageId,
        submittedUserTurnId: context.submittedUserTurnId,
      });
      turn = {
        ...turn,
        submittedUserFound: dom.submittedUserFound,
        laterUserFound: dom.laterUserFound,
        answerMessageId: dom.candidate?.responseMessageId ?? null,
        partialAnswer: dom.candidate?.answerText.slice(0, 3_000) ?? null,
      };
      progress = dom.candidate?.streamingMarker ? 'streaming'
        : dom.candidate?.terminalMarker ? 'idle' : dom.submittedUserFound ? 'idle' : 'unknown';
    }
    if (surface.mode !== 'chat') {
      blocker = 'unsupported';
      reason = surface.mode === 'work' ? 'work-surface-observation-only' : 'chat-surface-unverified';
    } else if (dialog.kind !== null) {
      blocker = dialog.kind === 'rate_limit' ? 'rate_limit' : 'human_verification';
      reason = dialog.reason;
    } else if (turn.laterUserFound) {
      blocker = 'unsupported';
      reason = 'later-user-boundary';
    }

    const alerts = blocker === 'none' && (context.submittedUserMessageId !== null ||
      context.submittedUserTurnId !== null)
      ? await observeChatGptAlerts(page, {
          submittedUserMessageId: context.submittedUserMessageId,
          submittedUserTurnId: context.submittedUserTurnId,
        }) : [];
    if (alerts.some(alert => /^hostspan(?:-[a-z0-9_-]+)?\b/i.test(alert))) {
      blocker = 'provider_permission';
      reason = 'scoped-tool-permission-requires-reviewed-effect-and-arguments';
    }
    const radioQuestion = blocker === 'none' ? await inspectChatGptQuestion(page) : null;
    const freeTextQuestion = blocker === 'none' && radioQuestion === null
      ? await inspectChatGptFreeTextQuestion(page) : null;
    const question = radioQuestion ?? freeTextQuestion;
    if (question !== null) {
      blocker = 'provider_question';
      reason = question.available ? 'provider-question-requires-decision' : 'question-evidence-incomplete-or-draft';
    } else if (blocker === 'none' && ui.editors.length !== 1) {
      blocker = 'unsupported';
      reason = ui.editors.length === 0 ? 'composer-not-found' : 'composer-ambiguous';
    }

    const issue = (purpose: SemanticActionPurpose, effect: string,
      risk: SemanticActionCandidate['risk'], input: SemanticActionCandidate['input'],
      fingerprint: string, questionHash: string | null = null): void => {
      const evidenceHash = sha(JSON.stringify({
        identity: lease, context: contextKey(context), purpose, fingerprint,
      }));
      const actionRef = randomUUID();
      const expiresAtMs = Date.now() + REF_TTL_MS;
      const option = {
        actionRef, purpose, effect, risk, input, evidenceHash,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      actions.push(option);
      cached.set(actionRef, {
        purpose, evidenceHash, uiFingerprint: fingerprint,
        contextKey: contextKey(context), expiresAtMs, questionHash,
      });
    };

    if (blocker === 'provider_question' && question?.available) {
      const input = radioQuestion !== null
        ? { kind: 'option' as const, options: radioQuestion.options.map(option => ({
          value: option.answer, enabled: !option.disabled,
        })) }
        : { kind: 'text' as const, maxLength: 2_000 };
      issue('answer_question', 'Answer the exact current provider question once',
        'send_once', input, ui.fingerprint, question.evidenceHash);
    } else if (blocker === 'none') {
      // A retained human/provider draft is not disposable. Only an empty
      // editor may be filled; an existing draft can be submitted solely when
      // the journaled exact content hash matches at dispatch time.
      if (ui.editors[0]!.value.length === 0) {
        issue('compose', 'Set the empty exact chat draft', 'draft_only',
          { kind: 'text', maxLength: MAX_DRAFT }, ui.fingerprint);
      }
      if (ui.buttons.length === 1 && ui.buttons[0]!.enabled &&
        ui.editors[0]!.value.trim().length > 0) {
        const continuation = ui.editors[0]!.value === '계속';
        issue(continuation ? 'continue' : 'submit',
          continuation ? 'Submit the existing exact continuation draft once' : 'Submit the existing exact chat draft once',
          'send_once', { kind: 'none' }, ui.fingerprint);
      }
      if (ui.buttons.length > 1) {
        blocker = 'unsupported'; reason = 'submit-control-ambiguous';
        actions.length = 0; cached.clear();
      }
    }

    let observation: SemanticObservation = {
      providerKey: this.providerKey, surface: surface.mode, snapshotId, observedAt,
      capabilityManifest: this.capabilities, progress, blocker, reason, turn,
      questionText: question?.text ?? null, actions, evidenceBytes: 0,
    };
    let bytes = Buffer.byteLength(JSON.stringify(observation));
    if (bytes > MAX_PACKET_BYTES) {
      // Never truncate a material question/option and accidentally authorize it.
      actions.length = 0; cached.clear();
      observation = { ...observation, blocker: 'unsupported',
        reason: 'semantic-packet-overflow-requires-bounded-expansion', actions: [] };
      bytes = Buffer.byteLength(JSON.stringify(observation));
    }
    observation = { ...observation, evidenceBytes: bytes };
    this.#latest.set(lease.pageKey, { snapshotId, actions: cached });
    return observation;
  }

  async act(request: SemanticActRequest): Promise<SemanticActResult> {
    const lease = request.context.pageLease;
    if (lease === null || !exactContext(request.context, lease) ||
      !this.#options.isExactLease(lease)) return { kind: 'stale', reason: 'page-lease-unverified' };
    const snapshot = this.#latest.get(lease.pageKey);
    const action = snapshot?.snapshotId === request.snapshotId
      ? snapshot.actions.get(request.actionRef) : undefined;
    if (!action || action.contextKey !== contextKey(request.context) ||
      action.evidenceHash !== request.evidenceHash || Date.now() > action.expiresAtMs) {
      return { kind: 'stale', reason: 'action-ref-stale-or-foreign' };
    }
    if (action.purpose !== 'compose' && !(await this.#authorized(request, action.purpose))) {
      return { kind: 'authorization_required', reason: 'journaled-attempt-authorization-unverified' };
    }
    if (action.purpose === 'compose' && (!request.input || request.input.length > MAX_DRAFT)) {
      return { kind: 'unsupported', reason: 'invalid-draft-input' };
    }
    if (action.purpose === 'answer_question' && (!request.input || request.input.length > 2_000)) {
      return { kind: 'unsupported', reason: 'question-option-required' };
    }
    if ((action.purpose === 'submit' || action.purpose === 'continue') &&
      (!request.expectedContentSha256 || !/^[a-f0-9]{64}$/.test(request.expectedContentSha256))) {
      return { kind: 'authorization_required', reason: 'exact-committed-content-hash-required' };
    }
    let capturedAttempts: SemanticDispatchEvidence[] = [];
    // One consumption even if the renderer returns late. No replay of an
    // uncertain external side effect via this actionRef or another requestId.
    snapshot!.actions.delete(request.actionRef);
    this.#latest.delete(lease.pageKey);
    const result = await this.#gate.run(lease, 'mutate', async () => {
      const page = await this.#options.resolvePage(lease);
      this.#checkOrigin(page);
      const surface = await observeChatGptSurface(page);
      if (surface.mode !== 'chat' || (await observeChatGptDialog(page)).kind !== null) {
        return 'stale' as const;
      }
      const fresh = await captureUi(page);
      if (fresh.fingerprint !== action.uiFingerprint) return 'stale' as const;
      if (action.purpose === 'answer_question') {
        const radio = await inspectChatGptQuestion(page);
        const freeText = radio === null ? await inspectChatGptFreeTextQuestion(page) : null;
        if (radio !== null) {
          if (!radio.available || radio.evidenceHash !== action.questionHash ||
            !radio.options.some(o => o.answer === request.input && !o.disabled)) {
            return 'stale' as const;
          }
        } else if (!freeText?.available || freeText.evidenceHash !== action.questionHash ||
          request.input!.length > 2_000) {
          return 'stale' as const;
        }
        if (!(await this.#authorized(request, action.purpose))) return 'stale' as const;
        const checkLease = () => {
          if (!this.#options.isExactLease(lease)) throw new Error('Question lease expired');
        };
        if (radio !== null) {
          await answerChatGptQuestion(page, {
            answer: request.input!, evidenceHash: action.questionHash!,
          }, checkLease);
        } else {
          await answerChatGptFreeTextQuestion(page, {
            answer: request.input!, evidenceHash: action.questionHash!,
          }, checkLease);
        }
        return 'question_answered' as const;
      }
      if (fresh.editors.length !== 1) return 'stale' as const;
      if (action.purpose === 'compose') {
        if (fresh.editors[0]!.value.length !== 0) return 'stale' as const;
        const editor = await exactHandle(page, EDITORS, fresh.editors[0]!);
        try {
          const existing = await editor.evaluate(element => element instanceof HTMLTextAreaElement
            ? element.value : element.innerText);
          if (existing.length !== 0) return 'stale' as const;
          await editor.fill(request.input!, { timeout: 5_000 });
        } finally { await editor.dispose(); }
        return 'draft_updated' as const;
      }
      if (action.purpose !== 'submit' && action.purpose !== 'continue') return 'stale' as const;
      if (fresh.buttons.length !== 1 || !fresh.buttons[0]!.enabled ||
        fresh.draftSha256 !== request.expectedContentSha256 ||
        (action.purpose === 'continue' && fresh.editors[0]!.value !== '계속')) {
        return 'stale' as const;
      }
      if (!(await this.#authorized(request, action.purpose))) return 'stale' as const;
      const watch = watchExactDispatch(page, request.context.providerConversationId!,
        request.expectedContentSha256!);
      try {
        const button = await exactHandle(page, BUTTONS, fresh.buttons[0]!);
        try {
          const currentDraft = await page.locator(EDITORS).nth(fresh.editors[0]!.index)
            .evaluate(element => element instanceof HTMLTextAreaElement
              ? element.value : (element as HTMLElement).innerText);
          if (sha(currentDraft.replaceAll('\r\n', '\n')) !== request.expectedContentSha256) {
            return 'stale' as const;
          }
          await button.click({ timeout: 5_000 });
        } finally { await button.dispose(); }
        capturedAttempts = await watch.collect(350);
      } finally {
        capturedAttempts = watch.snapshot();
        watch.stop();
      }
      return 'send' as const;
    }, 8_000);
    if (result.kind === 'stale') return { kind: 'stale', reason: 'lease-revoked' };
    if (result.kind === 'busy') return { kind: 'busy', reason: 'page-operation-in-flight' };
    if (result.kind !== 'ok') return { kind: 'uncertain', reason: result.reason,
      attempts: capturedAttempts };
    if (result.value === 'stale') return { kind: 'stale', reason: 'semantic-evidence-changed-before-action' };
    if (result.value === 'send') return { kind: 'dispatched_unverified', effect: 'send',
      attempts: capturedAttempts };
    return { kind: 'performed', effect: result.value };
  }

  async #authorized(request: SemanticActRequest, purpose: SemanticActionPurpose): Promise<boolean> {
    if (purpose === 'compose') return true;
    if (!request.authorizedAttemptId || !this.#options.isAuthorizedAttempt) return false;
    try {
      return await this.#options.isAuthorizedAttempt({
        context: request.context, purpose, attemptId: request.authorizedAttemptId,
        contentSha256: request.expectedContentSha256 ?? null, input: request.input ?? null,
      });
    } catch { return false; }
  }

  async verify(query: SemanticExactQuery): Promise<SemanticVerification> {
    return await this.recover(query);
  }

  async recover(query: SemanticExactQuery): Promise<SemanticVerification> {
    const id = query.context;
    const conversationId = id.providerConversationId;
    if (conversationId === null || conversationId.length === 0) {
      return { kind: 'unavailable', reason: 'exact-conversation-id-required' };
    }
    if (query.kind === 'ack' && (!query.prompt || query.attempts?.length !== 1 ||
      query.attempts[0]!.conversationId !== conversationId)) {
      return { kind: 'unavailable', reason: 'exact-dispatch-correlation-required' };
    }
    let client: BackendJsonClient;
    let origin: string;
    try {
      client = this.#options.backendClient ?? await this.#pageBackendClient(id);
      origin = this.#options.backendOrigin ??
        (this.#options.backendClient ? 'https://chatgpt.com'
          : new URL((await this.#exactPage(id)).page.url()).origin);
    } catch {
      return { kind: 'unavailable', reason: 'backend-transport-unavailable' };
    }
    if (query.kind === 'ack') {
      let latestReason: string | null = null;
      const ack = await this.#backend.recoverAcknowledgement(conversationId, query.prompt!,
        client, origin, query.attempts, evidence => { latestReason = evidence.reason; });
      return ack === null
        ? { kind: 'pending', reason: latestReason ?? 'canonical-ack-not-observed' }
        : { kind: 'verified_ack', externalTurnId: ack.submittedUserTurnId,
          messageId: ack.submittedUserMessageId };
    }
    const final = await this.#backend.recoverExactTurn({
      conversationId,
      submittedUserMessageId: id.submittedUserMessageId,
      submittedUserTurnId: id.submittedUserTurnId,
    }, client, origin);
    if (final.kind === 'complete' && final.answerText !== null) {
      return {
        kind: 'exact_final',
        externalTurnId: id.submittedUserTurnId ?? id.submittedUserMessageId!,
        answerText: final.answerText,
      };
    }
    return final.kind === 'pending'
      ? { kind: 'pending', reason: final.reason }
      : { kind: 'unavailable', reason: final.reason };
  }

  async #exactPage(context: SemanticTaskContext): Promise<{ lease: OwnedPageIdentity; page: Page }> {
    const lease = context.pageLease;
    if (lease === null || !exactContext(context, lease) ||
      !this.#options.isExactLease(lease)) throw new Error('Stale exact Task/page lease');
    const page = await this.#options.resolvePage(lease);
    this.#checkOrigin(page);
    if (!this.#options.isExactLease(lease)) throw new Error('Lease changed during page resolution');
    return { lease, page };
  }

  #checkOrigin(page: Page): void {
    const allowed = this.#options.allowedPageOrigins ?? [
      'https://chatgpt.com', 'https://chat.openai.com',
    ];
    let origin: string;
    try { origin = new URL(page.url()).origin; }
    catch { throw new Error('ChatGPT page URL unavailable'); }
    if (!allowed.includes(origin)) throw new Error('Foreign or unverified ChatGPT page origin');
  }

  async #pageBackendClient(context: SemanticTaskContext): Promise<BackendJsonClient> {
    const { page } = await this.#exactPage(context);
    return {
      async get(url, options) {
        const response = await page.context().request.get(url, {
          failOnStatusCode: false,
          ...(options.headers ? { headers: { ...options.headers } } : {}),
          timeout: options.timeoutMs,
        });
        try {
          return { status: response.status(), headers: response.headers(),
            body: await response.json().catch(() => null) };
        } finally { await response.dispose(); }
      },
    };
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function contextKey(context: SemanticTaskContext): string {
  return JSON.stringify(context);
}
function exactContext(context: SemanticTaskContext, lease: OwnedPageIdentity): boolean {
  return context.projectId === lease.projectId && context.slotId === lease.slotId &&
    context.slotRevision === lease.slotRevision && context.taskId === lease.taskId;
}

/** One bounded read in the page. Structural/testid drift can still resolve a
 * unique accessible editor and the one semantic send control. Never expose
 * indexes/selectors/DOM in the observation or actionRef.
 */
async function captureUi(page: Page): Promise<UiSnapshot> {
  const ui = await page.evaluate(({ editorsSelector, buttonSelector, sendPattern }) => {
    const visible = (element: Element) =>
      !element.closest('nav, aside, article, [role="navigation"], [role="search"], [aria-hidden="true"], [inert], [data-message-author-role], [data-chatgpt-search-message-ids], .markdown') &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      element.getBoundingClientRect().width > 0;
    const enabled = (element: Element) => !element.matches(
      ':disabled, [aria-disabled="true"], [readonly]');
    const signature = (e: Element) => [
      e.tagName.toLowerCase(), e.id, e.getAttribute('data-testid'),
      e.getAttribute('role'), e.getAttribute('aria-label'),
      e.getAttribute('placeholder'), e.getAttribute('type'),
    ].join('|');
    const allEditors = [...document.querySelectorAll<HTMLElement>(editorsSelector)];
    const editors = allEditors.flatMap((e, index) => {
      if (!visible(e) || !enabled(e) || !(e.isContentEditable || e instanceof HTMLTextAreaElement)) return [];
      const value = e instanceof HTMLTextAreaElement ? e.value : e.innerText;
      return [{ index, signature: signature(e), value, enabled: true }];
    });
    const editor = editors.length === 1 ? allEditors[editors[0]!.index] ?? null : null;
    const allButtons = [...document.querySelectorAll<HTMLElement>(buttonSelector)];
    const buttons = allButtons.flatMap((e, index) => {
      if (!visible(e)) return [];
      const label = (e.getAttribute('aria-label') ?? e.innerText ?? '').replace(/\s+/g, ' ').trim();
      const known = e.id === 'composer-submit-button' || e.getAttribute('data-testid') === 'send-button';
      const nativeSubmit = e.getAttribute('type') === 'submit' && editor !== null &&
        e.closest('form') !== null && e.closest('form') === editor.closest('form');
      if (!known && !nativeSubmit && !(new RegExp(sendPattern, 'i')).test(label)) return [];
      return [{ index, signature: signature(e), value: label, enabled: enabled(e) }];
    });
    return { editors, buttons };
  }, { editorsSelector: EDITORS, buttonSelector: BUTTONS, sendPattern: SEND_LABEL.source });
  const editor = ui.editors.length === 1 ? ui.editors[0]! : null;
  const draftSha256 = editor === null ? null : sha(editor.value.replaceAll('\r\n', '\n'));
  return {
    ...ui, draftSha256,
    fingerprint: sha(JSON.stringify({ editor: ui.editors, buttons: ui.buttons, draftSha256 })),
  };
}

async function exactHandle(page: Page, selector: string, expected: Control): Promise<ElementHandle<HTMLElement>> {
  const handle = await page.locator(selector).nth(expected.index).elementHandle({ timeout: 2_000 });
  if (handle === null) throw new Error('Exact semantic control disappeared');
  const actual = await handle.evaluate(e => [
    e.tagName.toLowerCase(), e.id, e.getAttribute('data-testid'),
    e.getAttribute('role'), e.getAttribute('aria-label'),
    e.getAttribute('placeholder'), e.getAttribute('type'),
  ].join('|')).catch(() => null);
  if (actual !== expected.signature) {
    await handle.dispose();
    throw new Error('Semantic control was replaced during action');
  }
  return handle as ElementHandle<HTMLElement>;
}

/** Capture only the exact outgoing user POST identity; this is attempt
 * provenance, NEVER a provider ACK. Missing/multiple requests stay uncertain.
 */
function watchExactDispatch(page: Page, conversationId: string, expectedSha256: string) {
  const attempts: SemanticDispatchEvidence[] = [];
  let wake: (() => void) | null = null;
  const onRequest = (request: Request) => {
    if (request.method() !== 'POST') return;
    try {
      const url = new URL(request.url());
      if (url.origin !== new URL(page.url()).origin ||
        !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
      const body: unknown = request.postDataJSON();
      if (!isRecord(body) || body.action !== 'next' ||
        body.conversation_id !== conversationId ||
        typeof body.parent_message_id !== 'string' || !body.parent_message_id) return;
      if (!Array.isArray(body.messages)) return;
      const users = body.messages.filter(message => isRecord(message) &&
        isRecord(message.author) && message.author.role === 'user');
      if (users.length !== 1) return;
      const user = users[0];
      if (!isRecord(user) || typeof user.id !== 'string' || !user.id ||
        !isRecord(user.content) || user.content.content_type !== 'text' ||
        !Array.isArray(user.content.parts) ||
        !user.content.parts.every(part => typeof part === 'string')) return;
      const text = user.content.parts.join('\n').replaceAll('\r\n', '\n');
      const textHash = sha(text);
      if (textHash !== expectedSha256) return;
      attempts.push({
        conversationId, messageId: user.id, parentMessageId: body.parent_message_id,
        textHash, observedAt: new Date().toISOString(),
      });
      wake?.();
    } catch { /* Unrelated/malformed requests confer no dispatch evidence. */ }
  };
  page.on('request', onRequest);
  return {
    snapshot: () => [...attempts],
    stop: () => page.off('request', onRequest),
    async collect(timeoutMs: number): Promise<SemanticDispatchEvidence[]> {
      if (attempts.length === 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>(resolve => {
          wake = resolve;
          timer = setTimeout(resolve, timeoutMs);
        });
        clearTimeout(timer);
        wake = null;
      }
      return this.snapshot();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
