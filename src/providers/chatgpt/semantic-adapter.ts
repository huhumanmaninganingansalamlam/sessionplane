import { createHash, randomUUID } from 'node:crypto';
import type { APIRequestContext, ElementHandle, Page, Request } from 'playwright-core';

import { PageOperationGate } from '../../browser/page-operation-gate.ts';
import type { PageMutationMutex } from '../../browser/page-mutex.ts';
import type { OwnedPageIdentity } from '../../browser/owned-page-lifecycle.ts';
import type {
  SemanticActRequest, SemanticActResult, SemanticActionCandidate,
  SemanticActionPurpose, SemanticCapabilityIssue, SemanticDispatchEvidence,
  SemanticRootPostEvidence, SemanticExactQuery, SemanticObservation, SemanticProviderAdapter,
  SemanticTaskContext, SemanticVerification,
} from '../semantic-adapter.ts';
import { semanticConfigurationIntent, semanticConfigurationMatches } from '../semantic-adapter.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from './backend-recovery.ts';
import { observeChatGptDialog } from './dialog-observer.ts';
import { observeChatGptDom, observeChatGptAlerts } from './dom-observer.ts';
import { hasMountedChatGptStream } from './message-dom.ts';
import { inspectChatGptQuestion, answerChatGptQuestion } from './question.ts';
import { inspectChatGptFreeTextQuestion, answerChatGptFreeTextQuestion } from './semantic-free-text-question.ts';
import { inspectSemanticHostSpanPermission } from './semantic-hostspan-permission.ts';
import { inspectSemanticChatGptModelMenu, openExactChatGptModelMenu,
  closeExactChatGptModelMenu, selectExactChatGptProReasoningLevel,
  selectExactChatGptModelMenu } from './semantic-model-menu.ts';
import { observeChatGptSurface } from './surface.ts';
import { streamRetrySurface } from './stream-retry.ts';

const EDITORS = 'main :is(#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea, [role="textbox"])';
const BUTTONS = 'main :is(button, [role="button"])';
const EMPTY_PROSEMIRROR_MARKER = ':scope > p.placeholder:only-child > br.ProseMirror-trailingBreak:only-child';
const MAX_PACKET_BYTES = 12 * 1024;
const MAX_DRAFT = 16_000;
const REF_TTL_MS = 30_000;
const SEND_LABEL = /^(send|send message|submit|전송|보내기|메시지 전송)$/i;

/** JSON byte count includes the width of its own evidenceBytes number. */
function observationBytes(packet: SemanticObservation): number {
  let bytes = Buffer.byteLength(JSON.stringify(packet));
  while (true) {
    const actual = Buffer.byteLength(JSON.stringify({ ...packet, evidenceBytes: bytes }));
    if (actual === bytes) return bytes;
    bytes = actual;
  }
}

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
  readonly modelHash: string | null;
  readonly retryHash: string | null;
}
interface ActiveSnapshot {
  readonly snapshotId: string;
  readonly actions: Map<string, CachedAction>;
}
export interface ChatGptSemanticAdapterOptions {
  /** Exact Task/slot/page lease from the Core, including binding epoch. */
  readonly isExactLease: (identity: OwnedPageIdentity) => boolean;
  readonly resolvePage: (identity: OwnedPageIdentity) => Promise<Page> | Page;
  /** Share the same Core-owned page mutex as the legacy runtime during cutover. */
  readonly pageMutationMutex?: PageMutationMutex;
  /** Production accepts only ChatGPT's trusted HTTPS origins. Test overrides are isolated fixtures. */
  readonly allowedPageOrigins?: readonly string[];
  readonly backendOrigin?: string;
  readonly backendClient?: BackendJsonClient;
  /** Rebind to the current Core-owned auth context when a page is missing. */
  readonly backendClientProvider?: () => BackendJsonClient | Promise<BackendJsonClient>;
  readonly backendRecovery?: ChatGptBackendRecovery;
  /** Synchronous durable callback on the exact page POST, before an ACK probe.
   * It must never send, modify the UI, or log the message content.
   */
  readonly onDispatchObserved?: (input: {
    context: SemanticTaskContext; attemptId: string;
    evidence: SemanticDispatchEvidence;
  }) => void;
  /** Root POST identity is durable before a canonical conversation is known. */
  readonly onRootDispatchObserved?: (input: {
    context: SemanticTaskContext; attemptId: string;
    evidence: SemanticRootPostEvidence;
  }) => void;
  /** Accept the root page's one expected identity transition only after the
   * exact observed POST has been committed durably by the Core.
   */
  readonly isRootDispatchTransition?: (input: {
    context: SemanticTaskContext; attemptId: string; lease: OwnedPageIdentity;
  }) => boolean;
  /** Consume one exact journaled model/question/stream-retry decision before its effect. */
  readonly isAuthorizedDecision?: (input: {
    context: SemanticTaskContext;
    purpose: 'open_model_chooser' | 'close_model_chooser' |
      'choose_model' | 'choose_reasoning_effort' | 'answer_question' | 'retry';
    decisionId: string; snapshotId: string; actionRef: string; evidenceHash: string; input: string | null;
  }) => boolean | Promise<boolean>;
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
    supports: ['conversation', 'question', 'permission', 'continuation', 'model_choice'] as const,
  });
  readonly #options: ChatGptSemanticAdapterOptions;
  readonly #gate: PageOperationGate;
  readonly #backend: ChatGptBackendRecovery;
  readonly #latest = new Map<string, ActiveSnapshot>();
  /** Monotonic identity token: a published+consumed snapshot cannot ABA to absent. */
  readonly #revision = new Map<string, object>();

  constructor(options: ChatGptSemanticAdapterOptions) {
    this.#options = options;
    this.#gate = new PageOperationGate(options.isExactLease, options.pageMutationMutex);
    this.#backend = options.backendRecovery ?? new ChatGptBackendRecovery({
      requestTimeoutMs: 15_000, tokenCacheTtlMs: 60_000,
    });
  }

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    const snapshotAtStart = context.pageLease === null ? undefined
      : this.#latest.get(context.pageLease.pageKey);
    const revisionAtStart = context.pageLease === null ? undefined
      : this.#revision.get(context.pageLease.pageKey);
    const { lease, page } = await this.#exactPage(context);
    const observedAt = new Date().toISOString();
    const snapshotId = randomUUID();
    const actions: SemanticActionCandidate[] = [];
    const capabilityIssues: SemanticCapabilityIssue[] = [];
    const cached = new Map<string, CachedAction>();
    let blocker: SemanticObservation['blocker'] = 'none';
    let reason: string | null = null;
    let progress: SemanticObservation['progress'] = 'unknown';
    let verifiedModel: string | null = null;
    let verifiedReasoningLevel: string | null = null;
    const unverifiedTurn: SemanticObservation['turn'] = {
      submittedUserFound: false, laterUserFound: false,
      submittedUserMessageId: context.submittedUserMessageId,
      answerMessageId: null, partialAnswer: null,
    };
    let turn = unverifiedTurn;
    const deniedObservation = (denialReason: string,
      deniedSurface: SemanticObservation['surface'] = 'unknown'): SemanticObservation => {
      const deniedTurn: SemanticObservation['turn'] = {
        submittedUserFound: false, laterUserFound: false,
        submittedUserMessageId: null, answerMessageId: null, partialAnswer: null,
      };
      const denied: SemanticObservation = {
        providerKey: this.providerKey, surface: deniedSurface, snapshotId, observedAt,
        capabilityManifest: this.capabilities, progress: 'unknown', blocker: 'unsupported',
        reason: denialReason, turn: deniedTurn, questionText: null, permission: null,
        actions: [], evidenceBytes: 0,
      };
      return { ...denied, evidenceBytes: observationBytes(denied) };
    };

    // Compare-and-revoke: a slow denied observation can invalidate only the
    // snapshot it saw at entry, never a newer observation for the same page.
    const revokeStartSnapshot = (): void => {
      if (this.#latest.get(lease.pageKey) === snapshotAtStart &&
          this.#latest.delete(lease.pageKey)) this.#revision.set(lease.pageKey, {});
    };

    const conversationError = conversationBindingProblem(page, context);
    if (conversationError !== null) {
      // Page ownership alone does not prove that this tab still points to the
      // bound ChatGPT conversation. Do not inspect a foreign transcript.
      revokeStartSnapshot();
      return deniedObservation(conversationError);
    }
    const surface = await observeChatGptSurface(page);
    if (surface.mode !== 'chat') {
      revokeStartSnapshot();
      return deniedObservation(surface.mode === 'work'
        ? 'work-surface-observation-only' : 'chat-surface-unverified', surface.mode);
    }
    const dialog = await observeChatGptDialog(page);
    const ui = await captureUi(page);
    const unboundStream = surface.mode === 'chat' &&
      context.submittedUserMessageId === null && context.submittedUserTurnId === null &&
      await hasMountedChatGptStream(page);
    if (unboundStream) progress = 'streaming';
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
    if (dialog.kind !== null) {
      blocker = dialog.kind === 'rate_limit' ? 'rate_limit' : 'human_verification';
      reason = dialog.reason;
    } else if (unboundStream) {
      blocker = 'unsupported';
      reason = 'generation-active-preserve-current-turn';
    } else if (turn.laterUserFound) {
      blocker = 'unsupported';
      reason = 'later-user-boundary';
    } else if ((context.submittedUserMessageId !== null ||
      context.submittedUserTurnId !== null) && !turn.submittedUserFound) {
      blocker = 'unsupported';
      reason = 'submitted-user-boundary-unverified';
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
    const permission = (blocker === 'none' || blocker === 'provider_permission') &&
      context.submittedUserMessageId !== null
      ? await inspectSemanticHostSpanPermission(page, context.submittedUserMessageId) : null;
    if (permission !== null) {
      blocker = 'provider_permission';
      reason = permission.detailState === 'visible_unverified'
        ? 'scoped-permission-details-still-require-reviewed-authorization'
        : 'scoped-permission-arguments-missing-or-protected';
    }
    const retry = blocker === 'none' ? await inspectExactChatGptRetry(page, context) : null;
    if (retry !== null) {
      blocker = retry.available ? 'provider_retry' : 'unsupported';
      reason = retry.available ? 'exact-stream-retry-requires-journaled-attempt'
        : `stream-retry-${retry.reason}`;
    }
    const radioQuestion = blocker === 'none' ? await inspectChatGptQuestion(page) : null;
    const freeTextQuestion = blocker === 'none' && radioQuestion === null
      ? await inspectChatGptFreeTextQuestion(page) : null;
    const question = radioQuestion ?? freeTextQuestion;
    if (question !== null) {
      blocker = turn.submittedUserFound ? 'provider_question' : 'unsupported';
      reason = !turn.submittedUserFound ? 'provider-question-turn-unverified'
        : question.available ? 'provider-question-requires-decision' : 'question-evidence-incomplete-or-draft';
    } else if (blocker === 'none' && progress === 'streaming') {
      blocker = 'unsupported';
      reason = 'generation-active-preserve-current-turn';
    } else if (blocker === 'none' && ui.editors.length !== 1) {
      blocker = 'unsupported';
      reason = ui.editors.length === 0 ? 'composer-not-found' : 'composer-ambiguous';
    }

    const issue = (purpose: SemanticActionPurpose, effect: string,
      risk: SemanticActionCandidate['risk'], input: SemanticActionCandidate['input'],
      fingerprint: string, questionHash: string | null = null,
      modelHash: string | null = null, retryHash: string | null = null): void => {
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
        contextKey: contextKey(context), expiresAtMs, questionHash, modelHash, retryHash,
      });
    };

    if (blocker === 'provider_retry' && retry?.available) {
      issue('retry', 'Retry one exact failed provider stream, with no prompt replay',
        'retry_once', { kind: 'none' }, ui.fingerprint, null, null, retry.evidenceHash);
    } else if (blocker === 'provider_question' && question?.available) {
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
      if (context.providerConversationId !== null && ui.editors[0]!.value.length === 0) {
        issue('compose', 'Set the empty exact chat draft', 'draft_only',
          { kind: 'text', maxLength: MAX_DRAFT }, ui.fingerprint);
      }
      if (context.providerConversationId !== null &&
        ui.buttons.length === 1 && ui.buttons[0]!.enabled &&
        ui.editors[0]!.value.trim().length > 0) {
        // Draft text is not Task intent. An initial user prompt can itself be
        // exactly "계속"; only the durable attempt kind authorizes the click.
        issue('submit', 'Submit the existing exact chat draft once',
          'send_once', { kind: 'none' }, ui.fingerprint);
        if (ui.editors[0]!.value === '계속' &&
            context.submittedUserMessageId !== null &&
            context.submittedUserTurnId !== null) {
          issue('continue', 'Submit the existing exact continuation draft once',
            'send_once', { kind: 'none' }, ui.fingerprint);
        }
      }
      if (ui.buttons.length > 1) {
        blocker = 'unsupported'; reason = 'submit-control-ambiguous';
        actions.length = 0; cached.clear();
      }
      // Model/effort configuration is an explicit agent decision. Read-only
      // observe never opens either the root menu or a linked Pro submenu.
      if (blocker === 'none') {
        const model = await inspectSemanticChatGptModelMenu(page);
        const requiredEffort = context.requiredModel != null &&
          semanticConfigurationIntent(this.providerKey, context.requiredModel).kind === 'reasoning_effort';
        if (model?.status === 'closed' || model?.status === 'nested') {
          // A trusted closed composer label is an effort level, not a model
          // radio. Opening a menu is configuration-only, never send permission.
          verifiedReasoningLevel = model.status === 'closed'
            ? model.verifiedReasoningLevel : null;
          if (requiredEffort && model.status === 'nested') {
            if (model.strategy === 'composer-radix' &&
                model.verifiedReasoningLevel === 'Pro') {
              // No send while the chooser remains open, even after Pro proof.
              issue('close_model_chooser', 'Close verified Pro composer chooser',
                'configuration_only', { kind: 'none' }, ui.fingerprint,
                null, model.evidenceHash);
            } else if (model.strategy === 'composer-radix' &&
                       model.reasoningControlState === 'enabled' &&
                       model.fiveLevelPowerScaleVerified) {
              // One verified five-step pointer control; final proof is
              // the literal Pro trigger, never a guessed numeric thumb.
              issue('choose_reasoning_effort', 'Select and verify Pro effort',
                'configuration_only', { kind: 'none' }, ui.fingerprint,
                null, model.evidenceHash);
            } else {
              const why = model.reasoningControlState === 'disabled'
                ? 'reasoning-effort-control-disabled'
                : 'reasoning-effort-pro-target-unverified';
              capabilityIssues.push({ capability: 'model_choice', reason: why });
              reason = why;
            }
          } else if (!requiredEffort || verifiedReasoningLevel !== 'Pro') {
            issue('open_model_chooser', 'Inspect currently offered model controls',
              'configuration_only', { kind: 'none' }, ui.fingerprint,
              null, model.evidenceHash);
          }
        } else if (model?.status === 'open') {
          const checked = model.options.filter(option => option.selected && option.enabled);
          verifiedModel = checked.length === 1 ? checked[0]!.value : null;
          if (requiredEffort) {
            // The model-radio view must first close; radio names cannot
            // substitute for a Pro reasoning-level selection.
            if (model.strategy === 'composer-radix') {
              issue('close_model_chooser', 'Return to exact composer effort selector',
                'configuration_only', { kind: 'none' }, ui.fingerprint,
                null, model.evidenceHash);
            } else {
              capabilityIssues.push({ capability: 'model_choice',
                reason: 'reasoning-effort-pro-target-unverified' });
              reason = 'reasoning-effort-pro-target-unverified';
            }
          } else {
            issue('choose_model', 'Select one verified model menu option',
              'configuration_only', { kind: 'option', options: model.options.map(o => ({
                value: o.value, enabled: o.enabled,
              })) }, ui.fingerprint, null, model.evidenceHash);
          }
        } else if (model?.status === 'unsupported') {
          capabilityIssues.push({
            capability: 'model_choice', reason: model.reason ?? 'model-menu-unverified',
          });
        }
      }
      // First-root send is separately journaled and cannot be offered until
      // the exact project model is visibly selected. No unrelated Task may
      // borrow this root lease or mutate its draft.
      if (blocker === 'none' && context.providerConversationId === null &&
          context.requiredModel && semanticConfigurationMatches(
            this.providerKey, context.requiredModel,
            { verifiedModel, verifiedReasoningLevel })) {
        if (ui.editors[0]!.value.length === 0) {
          issue('compose', 'Prepare exact first public prompt on new chat root',
            'draft_only', { kind: 'text', maxLength: MAX_DRAFT }, ui.fingerprint);
        }
        if (ui.buttons.length === 1 && ui.buttons[0]!.enabled &&
            ui.editors[0]!.value.trim().length > 0) {
          issue('submit', 'Create one exact root conversation from committed Task prompt',
            'send_once', { kind: 'none' }, ui.fingerprint);
        }
      }
    }

    // Every fact attributed to a previously verified user turn must still
    // belong to that turn after asynchronous inspection. A permission or a
    // blocked question has no actionRef but can still contain stale evidence.
    if (turn.submittedUserFound && !turn.laterUserFound &&
        (context.submittedUserMessageId !== null ||
         context.submittedUserTurnId !== null)) {
      const boundary = await observeChatGptDom(page, {
        submittedUserMessageId: context.submittedUserMessageId,
        submittedUserTurnId: context.submittedUserTurnId,
      });
      if (!boundary.submittedUserFound || boundary.laterUserFound) {
        revokeStartSnapshot();
        return deniedObservation('semantic-turn-boundary-changed-during-observation');
      }
    }
    // Chat-only is a property of the published packet, not just the initial
    // read. A slow question/model/permission inspection can cross a mode switch.
    const finalSurface = await observeChatGptSurface(page);
    if (finalSurface.mode !== 'chat') {
      revokeStartSnapshot();
      return deniedObservation(finalSurface.mode === 'work'
        ? 'work-surface-changed-during-observation'
        : 'chat-surface-changed-during-observation', finalSurface.mode);
    }
    // Ownership and conversation may change across asynchronous DOM reads.
    let changedBinding: string | null = null;
    if (!this.#options.isExactLease(lease)) {
      changedBinding = 'page-lease-revoked-during-observation';
    } else {
      try {
        this.#checkOrigin(page);
        changedBinding = conversationBindingProblem(page, context);
      } catch {
        changedBinding = 'page-origin-changed-during-observation';
      }
    }
    if (changedBinding !== null) {
      revokeStartSnapshot();
      return deniedObservation(changedBinding);
    }
    // An overlapping act consumes its old snapshot. An older observe must
    // not republish actionable evidence after that mutation.
    if (this.#revision.get(lease.pageKey) !== revisionAtStart ||
        this.#latest.get(lease.pageKey) !== snapshotAtStart ||
        this.#gate.isBusy(lease.pageKey)) {
      return deniedObservation('semantic-observation-superseded-by-page-operation');
    }
    let observation: SemanticObservation = {
      providerKey: this.providerKey, surface: surface.mode, snapshotId, observedAt,
      capabilityManifest: this.capabilities, progress, blocker, reason, turn,
      questionText: blocker === 'provider_question' ? question?.text ?? null : null,
      permission, actions, verifiedModel, verifiedReasoningLevel, evidenceBytes: 0,
      ...(capabilityIssues.length > 0 ? { capabilityIssues } : {}),
    };
    let bytes = observationBytes(observation);
    if (bytes > MAX_PACKET_BYTES) {
      // Never truncate a material question/option and accidentally authorize it.
      actions.length = 0; cached.clear();
      observation = { ...observation, blocker: 'unsupported',
        reason: 'semantic-packet-overflow-requires-bounded-expansion', actions: [],
        turn: { ...observation.turn, partialAnswer: null } };
      bytes = observationBytes(observation);
      if (bytes > MAX_PACKET_BYTES) {
        // The question/permission cannot fit intact. Require a separate
        // bounded evidence inspection; expose neither a partial grant nor ref.
        observation = { ...observation, questionText: null, permission: null,
          turn: { submittedUserFound: false, laterUserFound: false,
            submittedUserMessageId: null, answerMessageId: null, partialAnswer: null },
          capabilityIssues: [] };
        bytes = observationBytes(observation);
      }
    }
    observation = { ...observation, evidenceBytes: bytes };
    this.#latest.set(lease.pageKey, { snapshotId, actions: cached });
    this.#revision.set(lease.pageKey, {});
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
    // Validate input before consuming a durable one-shot decision.
    if (action.purpose === 'compose' && (!request.input || request.input.length > MAX_DRAFT)) {
      return { kind: 'unsupported', reason: 'invalid-draft-input' };
    }
    if (action.purpose === 'choose_model' && request.context.requiredModel &&
        semanticConfigurationIntent(this.providerKey, request.context.requiredModel).kind ===
          'reasoning_effort') {
      return { kind: 'unsupported', reason: 'reasoning-effort-is-not-model-radio' };
    }
    if ((action.purpose === 'choose_reasoning_effort' ||
         action.purpose === 'close_model_chooser') &&
        (!request.context.requiredModel ||
         semanticConfigurationIntent(this.providerKey, request.context.requiredModel).kind !==
           'reasoning_effort' || request.input !== undefined)) {
      return { kind: 'unsupported', reason: 'exact-reasoning-effort-decision-required' };
    }
    if (action.purpose === 'choose_model' && (!request.input || request.input.length > 160)) {
      return { kind: 'unsupported', reason: 'exact-model-option-required' };
    }
    if (action.purpose === 'answer_question' && (!request.input || request.input.length > 2_000)) {
      return { kind: 'unsupported', reason: 'question-option-required' };
    }
    if ((action.purpose === 'submit' || action.purpose === 'continue') &&
      (!request.expectedContentSha256 || !/^[a-f0-9]{64}$/.test(request.expectedContentSha256))) {
      return { kind: 'authorization_required', reason: 'exact-committed-content-hash-required' };
    }
    // A model/question decision is consumed once before the UI effect; a
    // stale or failed click never grants permission to replay the decision.
    if (action.purpose !== 'compose' && !(await this.#authorized(request, action.purpose))) {
      return { kind: 'authorization_required', reason: 'journaled-action-authorization-unverified' };
    }
    // Journal authorization can await I/O. Another caller or new observation
    // may have consumed/superseded this ref while that check was pending.
    if (this.#latest.get(lease.pageKey) !== snapshot ||
      snapshot?.actions.get(request.actionRef) !== action) {
      return { kind: 'stale', reason: 'action-ref-stale-or-foreign' };
    }
    let capturedAttempts: SemanticDispatchEvidence[] = [];
    let capturedRootPosts: SemanticRootPostEvidence[] = [];
    let dispatchSinkFailed = false;
    // One consumption even if the renderer returns late. No replay of an
    // uncertain external side effect via this actionRef or another requestId.
    snapshot!.actions.delete(request.actionRef);
    this.#latest.delete(lease.pageKey);
    this.#revision.set(lease.pageKey, {});
    const acceptRootDispatchTransition =
      request.context.providerConversationId === null && action.purpose === 'submit' &&
      request.authorizedAttemptId && this.#options.isRootDispatchTransition
        ? () => this.#options.isRootDispatchTransition!({
            context: request.context, attemptId: request.authorizedAttemptId!, lease,
          })
        : undefined;
    const result = await this.#gate.run(lease, 'mutate', async () => {
      const page = await this.#options.resolvePage(lease);
      this.#checkOrigin(page);
      if (conversationBindingProblem(page, request.context) !== null) return 'stale' as const;
      const requireExactMutationIdentity = () => {
        if (!this.#options.isExactLease(lease)) {
          throw new Error('Page lease revoked before semantic mutation');
        }
        this.#checkOrigin(page);
        if (conversationBindingProblem(page, request.context) !== null) {
          throw new Error('Conversation changed before semantic mutation');
        }
      };
      const surface = await observeChatGptSurface(page);
      if (surface.mode !== 'chat' || (await observeChatGptDialog(page)).kind !== null) {
        return 'stale' as const;
      }
      if (request.context.submittedUserMessageId === null &&
          request.context.submittedUserTurnId === null &&
          await hasMountedChatGptStream(page)) return 'stale' as const;
      // The composer may stay unchanged while its exact user anchor is
      // unmounted or followed by another user. Recheck before any mutation.
      if (request.context.submittedUserMessageId !== null ||
          request.context.submittedUserTurnId !== null) {
        const boundary = await observeChatGptDom(page, {
          submittedUserMessageId: request.context.submittedUserMessageId,
          submittedUserTurnId: request.context.submittedUserTurnId,
        });
        if (!boundary.submittedUserFound || boundary.laterUserFound ||
            (boundary.candidate?.streamingMarker === true && action.purpose !== 'answer_question')) {
          return 'stale' as const;
        }
      }
      // An intervening provider-owned question, permission card or exact retry
      // invalidates a prior draft/send/configuration action. Composer-only
      // fingerprints cannot detect these independent UI surfaces.
      if (request.context.submittedUserMessageId !== null ||
          request.context.submittedUserTurnId !== null) {
        const alerts = await observeChatGptAlerts(page, {
          submittedUserMessageId: request.context.submittedUserMessageId,
          submittedUserTurnId: request.context.submittedUserTurnId,
        });
        if (alerts.some(alert => /^hostspan(?:-[a-z0-9_-]+)?\b/i.test(alert))) return 'stale' as const;
        if (request.context.submittedUserMessageId !== null &&
            await inspectSemanticHostSpanPermission(page, request.context.submittedUserMessageId) !== null) {
          return 'stale' as const;
        }
      }
      if (action.purpose !== 'retry' &&
          (await inspectExactChatGptRetry(page, request.context)) !== null) return 'stale' as const;
      if (action.purpose !== 'answer_question' &&
          ((await inspectChatGptQuestion(page)) !== null ||
            (await inspectChatGptFreeTextQuestion(page)) !== null)) return 'stale' as const;
      const fresh = await captureUi(page);
      if (fresh.fingerprint !== action.uiFingerprint) return 'stale' as const;
      if (action.purpose === 'open_model_chooser' ||
          action.purpose === 'close_model_chooser' ||
          action.purpose === 'choose_reasoning_effort' ||
          action.purpose === 'choose_model') {
        const model = await inspectSemanticChatGptModelMenu(page);
        if (!model || model.evidenceHash !== action.modelHash) return 'stale' as const;
        const requireExactModelTurn = async () => {
          requireExactMutationIdentity();
          if (request.context.submittedUserMessageId !== null ||
              request.context.submittedUserTurnId !== null) {
            const boundary = await observeChatGptDom(page, {
              submittedUserMessageId: request.context.submittedUserMessageId,
              submittedUserTurnId: request.context.submittedUserTurnId,
            });
            if (!boundary.submittedUserFound || boundary.laterUserFound ||
                boundary.candidate?.streamingMarker === true) {
              throw new Error('Model decision turn changed before mutation');
            }
          }
          requireExactMutationIdentity();
        };
        try { await requireExactModelTurn(); }
        catch { return 'stale' as const; }
        if (action.purpose === 'open_model_chooser') {
          if (model.status !== 'closed' && model.status !== 'nested') return 'stale' as const;
          await openExactChatGptModelMenu(page, model.evidenceHash, requireExactModelTurn);
          return 'model_menu_opened' as const;
        }
        if (action.purpose === 'close_model_chooser') {
          if (model.strategy !== 'composer-radix' ||
              !['open', 'nested'].includes(model.status)) return 'stale' as const;
          await closeExactChatGptModelMenu(page, model.evidenceHash, requireExactModelTurn);
          return 'model_menu_closed' as const;
        }
        if (action.purpose === 'choose_reasoning_effort') {
          if (model.strategy !== 'composer-radix' || model.status !== 'nested' ||
              model.reasoningControlState !== 'enabled' ||
              !model.fiveLevelPowerScaleVerified) return 'stale' as const;
          await selectExactChatGptProReasoningLevel(
            page, model.evidenceHash, requireExactModelTurn);
          return 'reasoning_effort_selected' as const;
        }
        if (model.status !== 'open' ||
          !model.options.some(option => option.value === request.input && option.enabled)) {
          return 'stale' as const;
        }
        await selectExactChatGptModelMenu(page, model.evidenceHash, request.input!,
          requireExactModelTurn);
        return 'model_selected' as const;
      }
      if (action.purpose === 'retry') {
        const retry = await inspectExactChatGptRetry(page, request.context);
        if (!retry?.available || retry.evidenceHash !== action.retryHash) {
          return 'stale' as const;
        }
        requireExactMutationIdentity();
        const clicked = await page.evaluate(streamRetrySurface, {
          origin: new URL(page.url()).origin,
          conversationId: request.context.providerConversationId!,
          anchor: request.context.submittedUserMessageId!,
          click: true, expiresAt: Date.now() + 5_000,
        });
        return clicked.reason === 'exact-stream-retry' && clicked.clicked
          ? 'retry_clicked_unverified' as const : 'stale' as const;
      }
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
        const requireExactQuestionTurn = async () => {
          requireExactMutationIdentity();
          const boundary = await observeChatGptDom(page, {
            submittedUserMessageId: request.context.submittedUserMessageId,
            submittedUserTurnId: request.context.submittedUserTurnId,
          });
          if (!boundary.submittedUserFound || boundary.laterUserFound) {
            throw new Error('Exact question user turn changed before mutation');
          }
          requireExactMutationIdentity();
        };
        try { await requireExactQuestionTurn(); }
        catch { return 'stale' as const; }
        if (radio !== null) {
          await answerChatGptQuestion(page, {
            answer: request.input!, evidenceHash: action.questionHash!,
          }, requireExactQuestionTurn);
        } else {
          await answerChatGptFreeTextQuestion(page, {
            answer: request.input!, evidenceHash: action.questionHash!,
          }, requireExactQuestionTurn);
        }
        return 'question_answered' as const;
      }
      if (fresh.editors.length !== 1) return 'stale' as const;
      if (action.purpose === 'compose') {
        if (fresh.editors[0]!.value.length !== 0) return 'stale' as const;
        const editor = await exactHandle(page, EDITORS, fresh.editors[0]!);
        try {
          if (await readExactEditorValue(editor, fresh.editors[0]!) !== '') {
            return 'stale' as const;
          }
          // A human may have advanced the transcript since the earlier UI
          // fingerprint. The empty editor is not evidence of the old turn.
          if (request.context.submittedUserMessageId !== null ||
              request.context.submittedUserTurnId !== null) {
            const boundary = await observeChatGptDom(page, {
              submittedUserMessageId: request.context.submittedUserMessageId,
              submittedUserTurnId: request.context.submittedUserTurnId,
            });
            if (!boundary.submittedUserFound || boundary.laterUserFound ||
                boundary.candidate?.streamingMarker === true) return 'stale' as const;
          }
          // The exact-turn read can await while a human types into the same
          // editor. Recheck the pinned control immediately before fill.
          if (await readExactEditorValue(editor, fresh.editors[0]!) !== '' ||
              (await captureUi(page)).fingerprint !== fresh.fingerprint) {
            return 'stale' as const;
          }
          requireExactMutationIdentity();
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
      if (request.context.requiredModel) {
        // The model selected at inspection may have changed before Submit.
        // Re-read exact current configuration immediately inside the same
        // owned-page mutation, rather than treating an earlier decision as proof.
        const currentModel = await inspectSemanticChatGptModelMenu(page);
        const selected = currentModel?.status === 'open'
          ? currentModel.options.filter(option => option.selected && option.enabled) : [];
        if (!semanticConfigurationMatches(this.providerKey, request.context.requiredModel, {
          verifiedModel: selected.length === 1 ? selected[0]!.value : null,
          // A closed, uniquely linked trigger is the only durable proof
          // of an applied Pro effort level immediately before Submit.
          verifiedReasoningLevel: currentModel?.status === 'closed'
            ? currentModel.verifiedReasoningLevel : null,
        })) {
          return 'stale' as const;
        }
      }
      const isRoot = request.context.providerConversationId === null;
      const watch = !isRoot ? watchExactDispatch(page, request.context.providerConversationId!,
        request.expectedContentSha256!, evidence => {
          if (!this.#options.onDispatchObserved) return;
          try {
            this.#options.onDispatchObserved({
              context: request.context, attemptId: request.authorizedAttemptId!, evidence,
            });
          } catch {
            dispatchSinkFailed = true;
          }
        }) : null;
      const rootWatch = isRoot ? watchExactRootDispatch(
        page, request.expectedContentSha256!, evidence => {
          if (!this.#options.onRootDispatchObserved) {
            dispatchSinkFailed = true;
            return;
          }
          try {
            this.#options.onRootDispatchObserved({
              context: request.context, attemptId: request.authorizedAttemptId!, evidence,
            });
          } catch {
            dispatchSinkFailed = true;
          }
        }) : null;
      try {
        const editor = await exactHandle(page, EDITORS, fresh.editors[0]!);
        let button: ElementHandle<HTMLElement> | null = null;
        try {
          button = await exactHandle(page, BUTTONS, fresh.buttons[0]!);
          const currentDraft = await readExactEditorValue(editor, fresh.editors[0]!);
          if (currentDraft === null ||
            sha(currentDraft.replaceAll('\r\n', '\n')) !== request.expectedContentSha256) {
            return 'stale' as const;
          }
          // The journal can authorize a continuation just before a human
          // adds another user turn. The draft hash alone is not turn identity.
          if (request.context.submittedUserMessageId !== null ||
              request.context.submittedUserTurnId !== null) {
            const boundary = await observeChatGptDom(page, {
              submittedUserMessageId: request.context.submittedUserMessageId,
              submittedUserTurnId: request.context.submittedUserTurnId,
            });
            if (!boundary.submittedUserFound || boundary.laterUserFound ||
                boundary.candidate?.streamingMarker === true) return 'stale' as const;
          }
          // The boundary read can await while the exact editor or Send control
          // changes. Never click a committed hash from an earlier UI state.
          const finalDraft = await readExactEditorValue(editor, fresh.editors[0]!);
          if (finalDraft === null ||
            sha(finalDraft.replaceAll('\r\n', '\n')) !== request.expectedContentSha256 ||
            !(await exactControlReady(button, fresh.buttons[0]!)) ||
            (await captureUi(page)).fingerprint !== fresh.fingerprint) {
            return 'stale' as const;
          }
          const hiddenClick = await clickExactChatGptSend(
            page, button, fresh.buttons[0]!, requireExactMutationIdentity);
          // Hidden root composition may schedule its network POST after the
          // CDP input is acknowledged. The watcher, not click success, is the
          // only source of durable root dispatch evidence.
          const settleMs = hiddenClick ? 1_800 : 350;
          capturedAttempts = watch ? await watch.collect(settleMs) : [];
          capturedRootPosts = rootWatch ? await rootWatch.collect(settleMs) : [];
        } finally {
          await editor.dispose();
          await button?.dispose();
        }
      } finally {
        capturedAttempts = watch?.snapshot() ?? [];
        capturedRootPosts = rootWatch?.snapshot() ?? [];
        watch?.stop();
        rootWatch?.stop();
      }
      return isRoot ? 'root_send' as const : 'send' as const;
    }, 8_000, acceptRootDispatchTransition);
    if (result.kind === 'stale') return { kind: 'stale', reason: 'lease-revoked' };
    if (result.kind === 'busy') return { kind: 'busy', reason: 'page-operation-in-flight' };
    if (result.kind !== 'ok') return { kind: 'uncertain', reason: result.reason,
      attempts: capturedAttempts };
    if (result.value === 'stale') return { kind: 'stale', reason: 'semantic-evidence-changed-before-action' };
    if (result.value === 'retry_clicked_unverified') return {
      kind: 'uncertain', reason: 'retry-clicked-provider-progress-unverified',
    };
    if ((result.value === 'send' || result.value === 'root_send') &&
        dispatchSinkFailed) return {
      kind: 'uncertain', reason: 'durable-dispatch-evidence-write-failed',
      attempts: capturedAttempts,
    };
    if (result.value === 'root_send') return {
      kind: 'root_dispatched_unverified', effect: 'send', rootPosts: capturedRootPosts,
    };
    if (result.value === 'send') return { kind: 'dispatched_unverified', effect: 'send',
      attempts: capturedAttempts };
    return { kind: 'performed', effect: result.value };
  }

  async #authorized(request: SemanticActRequest, purpose: SemanticActionPurpose): Promise<boolean> {
    if (purpose === 'compose') return true;
    if (purpose === 'open_model_chooser' || purpose === 'close_model_chooser' ||
        purpose === 'choose_model' || purpose === 'choose_reasoning_effort' ||
        purpose === 'answer_question' || purpose === 'retry') {
      if (!request.authorizedDecisionId || !this.#options.isAuthorizedDecision) return false;
      try {
        return await this.#options.isAuthorizedDecision({
          context: request.context, purpose, decisionId: request.authorizedDecisionId,
          snapshotId: request.snapshotId, actionRef: request.actionRef, evidenceHash: request.evidenceHash,
          input: request.input ?? null,
        });
      } catch { return false; }
    }
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
    const rootAck = query.kind === 'ack' && id.providerConversationId === null;
    const conversationId = rootAck
      ? query.candidateConversationId ?? null : id.providerConversationId;
    if (conversationId === null || !/^[A-Za-z0-9_-]{1,160}$/.test(conversationId)) {
      return { kind: 'unavailable', reason: rootAck
        ? 'root-conversation-candidate-required' : 'exact-conversation-id-required' };
    }
    if (rootAck) {
      const root = query.rootPost;
      if (!query.prompt || !root || query.attempts !== undefined ||
          id.submittedUserMessageId !== null || id.submittedUserTurnId !== null ||
          root.textHash !== sha(query.prompt.replaceAll('\r\n', '\n')) ||
          (root.requestConversationId !== null &&
            root.requestConversationId !== conversationId)) {
        return { kind: 'unavailable', reason: 'exact-root-dispatch-correlation-required' };
      }
    } else if (query.kind === 'ack' && (!query.prompt || query.attempts?.length !== 1 ||
      query.attempts[0]!.conversationId !== conversationId)) {
      return { kind: 'unavailable', reason: 'exact-dispatch-correlation-required' };
    }
    if (!rootAck && query.kind === 'ack' &&
      query.attempts![0]!.textHash !== sha(query.prompt!.replaceAll('\r\n', '\n'))) {
      return { kind: 'unavailable', reason: 'canonical-ack-prompt-hash-mismatch' };
    }
    if (!rootAck && query.kind === 'ack' && id.submittedUserMessageId !== null &&
      id.submittedUserMessageId !== query.attempts![0]!.messageId) {
      return { kind: 'unavailable', reason: 'canonical-ack-bound-message-mismatch' };
    }
    if (query.kind === 'final' && !id.submittedUserTurnId) {
      return { kind: 'unavailable', reason: 'exact-submitted-user-turn-required' };
    }
    let client: BackendJsonClient;
    let origin: string;
    try {
      client = this.#options.backendClient ??
        (this.#options.backendClientProvider
          ? await this.#options.backendClientProvider() : await this.#pageBackendClient(id));
      origin = this.#options.backendOrigin ??
        (this.#options.backendClient || this.#options.backendClientProvider ? 'https://chatgpt.com'
          : new URL((await this.#exactPage(id)).page.url()).origin);
    } catch {
      return { kind: 'unavailable', reason: 'backend-transport-unavailable' };
    }
    if (query.kind === 'ack') {
      const root = rootAck ? query.rootPost! : null;
      const attempts = root === null ? query.attempts : [{
        conversationId,
        messageId: root.messageId,
        parentMessageId: root.parentMessageId,
        textHash: root.textHash,
        observedAt: root.observedAt,
      }];
      let latestReason: string | null = null;
      const ack = await this.#backend.recoverAcknowledgement(conversationId, query.prompt!,
        client, origin, attempts, evidence => { latestReason = evidence.reason; },
        root?.messageId);
      if (ack !== null && id.submittedUserTurnId !== null &&
        ack.submittedUserTurnId !== id.submittedUserTurnId) {
        return { kind: 'unavailable', reason: 'canonical-ack-bound-turn-mismatch' };
      }
      if (ack === null) {
        return { kind: 'pending', reason: latestReason ?? 'canonical-ack-not-observed' };
      }
      if (root !== null) {
        if (ack.conversationId !== conversationId ||
            ack.submittedUserMessageId !== root.messageId ||
            ack.dispatchParent?.matches !== true) {
          return { kind: 'unavailable', reason: 'canonical-root-ack-identity-mismatch' };
        }
        return { kind: 'verified_root_ack', conversationId,
          externalTurnId: ack.submittedUserTurnId,
          messageId: ack.submittedUserMessageId };
      }
      return { kind: 'verified_ack', externalTurnId: ack.submittedUserTurnId,
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
        externalTurnId: id.submittedUserTurnId!,
        answerText: final.answerText,
      };
    }
    // A rate-limited canonical GET is deferred, not absent. Preserve its
    // nonterminal state while backend recovery enforces Retry-After.
    return final.kind === 'pending' || final.kind === 'deferred'
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
    return chatGptBackendJsonClient(page.context().request);
  }
}

/** GET-only transport bound to the current authenticated BrowserContext.
 * A replaced request context gets a different auth scope without any Page.
 */
export function chatGptBackendJsonClient(request: APIRequestContext): BackendJsonClient {
  return {
    authScope: request,
    async get(url, options) {
      const response = await request.get(url, {
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

/** Uses the existing exact stream-error guard in read-only mode. It checks
 * URL, latest owned user message, no competing dialog/generation, draft and
 * the sole visible retry hit target; it does not alter the page.
 */
async function inspectExactChatGptRetry(page: Page, context: SemanticTaskContext) {
  if (!context.providerConversationId || !context.submittedUserMessageId) return null;
  const observed = await page.evaluate(streamRetrySurface, {
    origin: new URL(page.url()).origin,
    conversationId: context.providerConversationId,
    anchor: context.submittedUserMessageId,
    click: false,
  });
  if (!observed.present) return null;
  return {
    available: observed.reason === 'exact-stream-retry',
    reason: observed.reason,
    evidenceHash: sha(JSON.stringify({
      url: page.url(), context: contextKey(context), reason: observed.reason,
      centerHit: observed.geometry?.centerHit ?? null,
    })),
  };
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
/** A reserved, precisely-owned new-chat root may inspect/configure the model,
 * but cannot expose compose/submit until the first POST has its own
 * root-dispatch/ACK identity protocol. Bound conversations retain the exact
 * canonical conversation URL requirement.
 */
function conversationBindingProblem(page: Page, context: SemanticTaskContext): string | null {
  const id = context.providerConversationId;
  const current = new URL(page.url());
  if (id === null) {
    if (context.submittedUserMessageId !== null || context.submittedUserTurnId !== null) {
      return 'unbound-root-cannot-have-a-submitted-turn';
    }
    return current.pathname === '/' && current.search === '' && current.hash === ''
      ? null : 'conversation-binding-required';
  }
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) return 'conversation-binding-required';
  const expected = `/c/${encodeURIComponent(id)}`;
  return current.pathname === expected ? null : 'conversation-url-mismatch';
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
  const ui = await page.evaluate(async ({ editorsSelector, buttonSelector, sendPattern, emptyEditorMarker }) => {
    const visible = (element: Element) =>
      !element.closest('nav, aside, article, [role="navigation"], [role="search"], [role="dialog"], [role="alertdialog"], [aria-hidden="true"], [inert], [data-message-author-role], [data-chatgpt-search-message-ids], .markdown') &&
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
      const raw = e instanceof HTMLTextAreaElement ? e.value : e.innerText;
      const structuralPlaceholder = !(e instanceof HTMLTextAreaElement) && e.classList.contains('ProseMirror') &&
        raw === '\n' && e.textContent === '' && e.querySelector(emptyEditorMarker) !== null;
      // innerText may collapse a human-entered whitespace-only paragraph to an
      // empty string. textContent is the final guard against overwriting it.
      const value = structuralPlaceholder ? '' : raw === '' && e.textContent !== '' ? e.textContent : raw;
      return [{ index, signature: signature(e), value, enabled: true }];
    });
    const editor = editors.length === 1 ? allEditors[editors[0]!.index] ?? null : null;
    const composer = editor?.closest('[data-chatgpt-composer]') ?? null;
    const allButtons = [...document.querySelectorAll<HTMLElement>(buttonSelector)];
    const buttons = allButtons.flatMap((e, index) => {
      if (!visible(e)) return [];
      const label = (e.getAttribute('aria-label') ?? e.innerText ?? '').replace(/\s+/g, ' ').trim();
      const known = (e.id === 'composer-submit-button' || e.getAttribute('data-testid') === 'send-button') &&
        (composer === null || e.closest('[data-chatgpt-composer]') === composer);
      const nativeSubmit = e.getAttribute('type') === 'submit' && editor !== null &&
        e.closest('form') !== null && e.closest('form') === editor.closest('form');
      const labelledSubmit = composer !== null &&
        e.closest('[data-chatgpt-composer]') === composer && (new RegExp(sendPattern, 'i')).test(label);
      if (!known && !nativeSubmit && !labelledSubmit) return [];
      return [{ index, signature: signature(e), value: label, enabled: enabled(e) }];
    });
    // A not-yet-submitted Task has no canonical user ID. Pin its existing
    // transcript boundary along with the composer, so a new human turn
    // cannot inherit an old compose/submit actionRef. Keep user text inside
    // the renderer and return only its digest.
    const userNodes = [...document.querySelectorAll<HTMLElement>(
      'main [data-message-author-role="user"], main [data-user-message-bubble]',
    )].filter(node => node.parentElement?.closest(
      '[data-message-author-role="user"], [data-user-message-bubble]') === null);
    const userBoundary = JSON.stringify(userNodes.map(node => [
      node.getAttribute('data-message-id'), node.getAttribute('data-turn-id'),
      node.getAttribute('data-dil-message-id'),
      node.closest('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids'),
      node.textContent,
    ]));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userBoundary));
    const userBoundarySha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return { editors, buttons, userBoundarySha256 };
  }, { editorsSelector: EDITORS, buttonSelector: BUTTONS, sendPattern: SEND_LABEL.source,
    emptyEditorMarker: EMPTY_PROSEMIRROR_MARKER });
  const editor = ui.editors.length === 1 ? ui.editors[0]! : null;
  const draftSha256 = editor === null ? null : sha(editor.value.replaceAll('\r\n', '\n'));
  return {
    ...ui, draftSha256,
    fingerprint: sha(JSON.stringify({ editor: ui.editors, buttons: ui.buttons,
      draftSha256, userBoundarySha256: ui.userBoundarySha256 })),
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

async function readExactEditorValue(handle: ElementHandle<HTMLElement>,
  expected: Control): Promise<string | null> {
  return await handle.evaluate((element, input) => {
    const signature = [
      element.tagName.toLowerCase(), element.id, element.getAttribute('data-testid'),
      element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('type'),
    ].join('|');
    if (!element.isConnected || signature !== input.signature ||
      element.matches(':disabled, [aria-disabled="true"], [readonly]')) return null;
    if (element instanceof HTMLTextAreaElement) return element.value;
    if (!element.isContentEditable) return null;
    const raw = element.innerText;
    const structuralPlaceholder = element.classList.contains('ProseMirror') && raw === '\n' &&
      element.textContent === '' && element.querySelector(input.emptyEditorMarker) !== null;
    return structuralPlaceholder ? '' :
      raw === '' && element.textContent !== '' ? element.textContent : raw;
  }, {
    signature: expected.signature,
    emptyEditorMarker: EMPTY_PROSEMIRROR_MARKER,
  }).catch(() => null);
}

async function exactControlReady(handle: ElementHandle<HTMLElement>,
  expected: Control): Promise<boolean> {
  return await handle.evaluate((element, signature) =>
    element.isConnected &&
    !element.matches(':disabled, [aria-disabled="true"], [readonly]') &&
    [
      element.tagName.toLowerCase(), element.id, element.getAttribute('data-testid'),
      element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('type'),
    ].join('|') === signature,
  expected.signature).catch(() => false);
}

/**
 * Headed Chrome can suppress CDP Input mouse and key events on a background
 * tab even when its DOM send button remains visible, enabled and hit-testable.
 * Keep normal visible-tab Playwright clicks unchanged. In the exact hidden
 * owned target, dispatch one native DOM button click (which reaches React's
 * composer/form handler) after rechecking the pinned control, hit target and
 * lease. Never retry an ambiguous action or equate a click with provider POST.
 */
async function clickExactChatGptSend(
  page: Page, handle: ElementHandle<HTMLElement>, expected: Control,
  beforeMutation: () => void,
): Promise<boolean> {
  const hidden = await page.evaluate(() => document.visibilityState === 'hidden');
  if (!hidden) {
    beforeMutation();
    await handle.click({ timeout: 5_000 });
    return false;
  }
  const point = await handle.evaluate((element, signature) => {
    const actual = [
      element.tagName.toLowerCase(), element.id, element.getAttribute('data-testid'),
      element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('type'),
    ].join('|');
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return element.isConnected && actual === signature &&
      element.closest('main') !== null &&
      element.closest('[aria-hidden="true"], [inert]') === null &&
      !element.matches(':disabled, [aria-disabled="true"], [readonly]') &&
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      rect.width > 0 && rect.height > 0 &&
      Number.isFinite(x) && Number.isFinite(y) &&
      x >= 0 && y >= 0 && x < innerWidth && y < innerHeight &&
      (hit === element || element.contains(hit)) ? { x, y } : null;
  }, expected.signature);
  if (!point) throw new Error('Exact hidden send target failed hit test');
  beforeMutation();
  const stillPinned = await handle.evaluate((element, previous) => {
    const actual = [
      element.tagName.toLowerCase(), element.id, element.getAttribute('data-testid'),
      element.getAttribute('role'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('type'),
    ].join('|');
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(previous.x, previous.y);
    return element.isConnected && actual === previous.signature &&
      !element.matches(':disabled, [aria-disabled="true"], [readonly]') &&
      element.closest('[aria-hidden="true"], [inert]') === null &&
      Math.abs(rect.x + rect.width / 2 - previous.x) < 1 &&
      Math.abs(rect.y + rect.height / 2 - previous.y) < 1 &&
      (hit === element || element.contains(hit));
  }, { ...point, signature: expected.signature });
  if (!stillPinned) throw new Error('Hidden send target changed before input');
  beforeMutation();
  // A CDP Input.dispatchMouseEvent can be silently ignored by the inactive
  // renderer. HTMLElement.click() dispatches the *same exact button's* click
  // inside its DOM, including the browser's native submit event for a form.
  // This may be untrusted to the provider. The caller still requires one
  // independently witnessed canonical POST; it never retries this invocation.
  await handle.evaluate(element => {
    if (!element.isConnected || element.matches(':disabled, [aria-disabled="true"]')) {
      throw new Error('Exact hidden submit control changed');
    }
    element.click();
  });
  return true;
}

/** One exact root request before provider conversation binding. The POST
 * identity is never an ACK; incoming provider URL/body must be reconciled by
 * a separate authenticated canonical GET.
 */
function watchExactRootDispatch(page: Page, expectedSha256: string,
  onObserved?: (evidence: SemanticRootPostEvidence) => void) {
  const posts: SemanticRootPostEvidence[] = [];
  let wake: (() => void) | null = null;
  const onRequest = (request: Request) => {
    if (request.method() !== 'POST') return;
    try {
      const url = new URL(request.url());
      if (url.origin !== new URL(page.url()).origin ||
          !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
      const body: unknown = request.postDataJSON();
      if (!isRecord(body) || body.action !== 'next' ||
          (body.conversation_id !== null && body.conversation_id !== undefined &&
            (typeof body.conversation_id !== 'string' ||
              !/^[A-Za-z0-9_-]{1,160}$/.test(body.conversation_id))) ||
          typeof body.parent_message_id !== 'string' || !body.parent_message_id ||
          !Array.isArray(body.messages)) return;
      const users = body.messages.filter(message => isRecord(message) &&
        isRecord(message.author) && message.author.role === 'user');
      if (users.length !== 1) return;
      const user = users[0];
      if (!isRecord(user) || typeof user.id !== 'string' || !user.id ||
          !isRecord(user.content) || user.content.content_type !== 'text' ||
          !Array.isArray(user.content.parts) ||
          !user.content.parts.every(part => typeof part === 'string')) return;
      const textHash = sha(user.content.parts.join('\n').replaceAll('\r\n', '\n'));
      if (textHash !== expectedSha256) return;
      const evidence: SemanticRootPostEvidence = {
        requestConversationId: typeof body.conversation_id === 'string'
          ? body.conversation_id : null,
        messageId: user.id, parentMessageId: body.parent_message_id,
        textHash, observedAt: new Date().toISOString(),
      };
      posts.push(evidence);
      onObserved?.(evidence);
      wake?.();
    } catch { /* Malformed/foreign requests never authorize a root send. */ }
  };
  page.on('request', onRequest);
  return {
    snapshot: () => [...posts],
    stop: () => page.off('request', onRequest),
    async collect(timeoutMs: number): Promise<SemanticRootPostEvidence[]> {
      if (posts.length === 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await new Promise<void>(resolve => {
          wake = resolve; timer = setTimeout(resolve, timeoutMs);
        });
        clearTimeout(timer);
        wake = null;
      }
      return this.snapshot();
    },
  };
}

/** Capture only the exact outgoing user POST identity; this is attempt
 * provenance, NEVER a provider ACK. Missing/multiple requests stay uncertain.
 */
function watchExactDispatch(page: Page, conversationId: string, expectedSha256: string,
  onObserved?: (evidence: SemanticDispatchEvidence) => void) {
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
      const attempt = {
        conversationId, messageId: user.id, parentMessageId: body.parent_message_id,
        textHash, observedAt: new Date().toISOString(),
      };
      attempts.push(attempt);
      // Persistence is invoked during the request event, not after the
      // Playwright click/ACK wait. A failed callback marks the result uncertain.
      onObserved?.(attempt);
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
