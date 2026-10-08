import { createHash } from 'node:crypto';
import type { ElementHandle, Locator, Page, Request, Response } from 'playwright-core';

import type { PageRegistry } from '../../browser/page-registry.ts';
import { parseChatGptConversationId } from '../../browser/page-binding.ts';
import { BrowserRefSnapshotStore, hasPreparationSelectionEvidence, matchesPreparationTarget } from '../../browser/ref-snapshot.ts';
import {
  ProviderSubmissionError,
  type ProviderAttachment,
  type ProviderSubmission,
  type ProviderSubmissionAcknowledgement,
  type ProviderSubmissionRequest,
  type PreparationChoices,
  type PreparationTarget,
} from '../provider-adapter.ts';
import {
  assertNoHumanVerification,
  navigateProviderPage,
  waitForProviderPageReady,
} from '../human-verification.ts';
import { attachmentsAcknowledged } from '../attachment-evidence.ts';
import { CHATGPT_SELECTORS, CHATGPT_PREPARATION_SNAPSHOT, CHATGPT_COMPOSER_SELECTOR } from './selectors.ts';
import { readChatGptMessages, type ChatGptMessage } from './message-dom.ts';

const COMPOSER_HYDRATION_TIMEOUT_MS = 3_000;
const COMPOSER_READY_TIMEOUT_MS = 10_000;
const COMPOSER_COMMIT_TIMEOUT_MS = 3_000;
const COMPOSER_COMMIT_POLL_MS = 50;
const COMPOSER_READ_TIMEOUT_MS = 500;
const COMPOSER_STABLE_WINDOW_MS = 250;
const COMPOSER_WRITE_ATTEMPTS = 2;
const VISIBLE_SELECTOR_TIMEOUT_MS = 5_000;
const VISIBLE_SELECTOR_POLL_MS = 50;
type PreparationElement = Locator | ElementHandle<Element>;

export interface ChatGptSubmissionOptions {
  readonly page: Page;
  readonly pageKey: string;
  readonly pageRegistry: PageRegistry;
  readonly request: ProviderSubmissionRequest;
  readonly acknowledgementTimeoutMs: number;
  readonly initialUrl?: string;
}

export class ChatGptSubmission implements ProviderSubmission {
  readonly provider = 'chatgpt';
  readonly pageKey: string;
  readonly #page: Page;
  readonly #registry: PageRegistry;
  readonly #request: ProviderSubmissionRequest;
  readonly #acknowledgementTimeoutMs: number;
  readonly #initialUrl: string | null;
  readonly #preparationRefs = new BrowserRefSnapshotStore();
  #sendButton: PreparationElement | null = null;
  #baselineConversationId: string | null = null;
  #baselineUserIds = new Set<string>();
  readonly #preparedPromptHashes = new Set<string>();
  readonly #sentMessageIds = new Set<string>();
  readonly #sentRequests = new Map<Request, Set<string>>();
  readonly #acceptedMessageIds = new Set<string>();
  readonly #captureSentIdentity = (request: Request): void => {
    if (request.method() !== 'POST' || new URL(request.url()).origin !== new URL(this.#page.url()).origin) return;
    try {
      const body: unknown = request.postDataJSON();
      if (body === null || typeof body !== 'object' || !('messages' in body) || !Array.isArray(body.messages)) return;
      if (this.#baselineConversationId !== null && 'conversation_id' in body && body.conversation_id != null && body.conversation_id !== this.#baselineConversationId) return;
      // Preserve exact dispatch correlation before the DOM ACK deadline expires.
      // Only the real continuation POST on this prepared page can supply it.
      const users = body.messages.filter((m: unknown) => m !== null && typeof m === 'object' &&
        'author' in m && m.author !== null && typeof m.author === 'object' &&
        'role' in m.author && m.author.role === 'user');
      if (/^\/backend-api\/(?:f\/)?conversation$/.test(new URL(request.url()).pathname) &&
          'action' in body && body.action === 'next' && users.length === 1 &&
          'conversation_id' in body && body.conversation_id === this.#baselineConversationId &&
          typeof body.conversation_id === 'string' && 'parent_message_id' in body &&
          typeof body.parent_message_id === 'string' && body.parent_message_id !== '') {
        const message = users[0] as Record<string, unknown>;
        const content = message.content as { content_type?: unknown; parts?: unknown } | undefined;
        if (typeof message.id === 'string' && message.id !== '' &&
            ![...this.#baselineUserIds].some(id => id.startsWith(`${message.id}\u0000`)) &&
            content?.content_type === 'text' && Array.isArray(content.parts) &&
            content.parts.every((part: unknown) => typeof part === 'string')) {
          const textHash = createHash('sha256').update(content.parts.join('\n').replaceAll('\r\n', '\n')).digest('hex');
          if (this.#preparedPromptHashes.has(textHash)) {
            this.#request.onSubmissionAttempt?.({ conversationId: body.conversation_id,
              messageId: message.id, parentMessageId: body.parent_message_id,
              textHash, observedAt: new Date().toISOString() });
          }
        }
      }
      for (const message of body.messages as unknown[]) {
        if (message === null || typeof message !== 'object' || !('id' in message) ||
            typeof message.id !== 'string' || message.id === '' || !('author' in message)) continue;
        const author = message.author;
        if (author !== null && typeof author === 'object' && 'role' in author && author.role === 'user') {
          this.#sentMessageIds.add(message.id);
          const ids = this.#sentRequests.get(request) ?? new Set<string>();
          ids.add(message.id);
          this.#sentRequests.set(request, ids);
        }
      }
    } catch { /* Unrelated non-JSON browser requests do not carry message identities. */ }
  };

  readonly #captureAcceptance = (response: Response): void => {
    // Outgoing IDs prove an attempt only. Also observe the provider accepting
    // that exact request; optimistic DOM alone must never confirm submission.
    if (!response.ok()) return;
    for (const id of this.#sentRequests.get(response.request()) ?? []) this.#acceptedMessageIds.add(id);
  };
  readonly #captureFailedRequest = (request: Request): void => {
    for (const id of this.#sentRequests.get(request) ?? []) this.#acceptedMessageIds.delete(id);
  };

  constructor(options: ChatGptSubmissionOptions) {
    this.#page = options.page;
    this.pageKey = options.pageKey;
    this.#registry = options.pageRegistry;
    this.#request = options.request;
    this.#acknowledgementTimeoutMs = options.acknowledgementTimeoutMs;
    this.#initialUrl = options.initialUrl ?? null;
  }

  async prepareForObservation(): Promise<void> {
    if (this.#initialUrl !== null) {
      await navigateProviderPage({ page: this.#page, provider: this.provider, pageKey: this.pageKey, url: this.#initialUrl, timeoutMs: 30_000 });
      this.#registry.refreshPage(this.pageKey);
    }
    this.#requireExactPage();
    await prepareChatGptObservation(this.#page, this.pageKey);
  }

  async #resolvePreparationTarget(
    target: PreparationTarget,
    timeoutMs: number,
  ): Promise<ElementHandle<Element> | null> {
    const deadline = Date.now() + timeoutMs;
    do {
      const binding = this.#registry.refreshPage(this.pageKey);
      const snapshot = await this.#preparationRefs.capture({
        pageKey: this.pageKey,
        bindingEpoch: binding.bindingEpoch,
        page: this.#page,
        ...CHATGPT_PREPARATION_SNAPSHOT,
        maxNodes: 5_000,
      });
      const matches = snapshot.nodes.filter((node) => matchesPreparationTarget(node, target) &&
        (target.purpose !== 'submit' || node.submitControl === true));
      if (snapshot.nodesTruncated || matches.length > 1) return null;
      const match = matches[0];
      if (match !== undefined) {
        const element = await this.#preparationRefs.resolve({
          pageKey: this.pageKey,
          bindingEpoch: binding.bindingEpoch,
          page: this.#page,
          ref: match.ref,
          snapshotId: snapshot.snapshotId,
        });
        if (target.purpose !== 'composer' || await element.isEditable().catch(() => false)) return element;
        await element.dispose();
        return null;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.#page.waitForTimeout(Math.min(100, remaining));
    } while (Date.now() < deadline);
    return null;
  }

  async #waitForEnabledPreparationTarget(target: PreparationTarget, timeoutMs: number): Promise<ElementHandle<Element> | null> {
    const deadline = Date.now() + timeoutMs;
    do {
      const element = await this.#resolvePreparationTarget(target, 0);
      if (element !== null) {
        if (await element.isEnabled().catch(() => false)) return element;
        await element.dispose();
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.#page.waitForTimeout(Math.min(100, remaining));
    } while (Date.now() < deadline);
    return null;
  }

  async #verifyConfiguration(choices?: PreparationChoices): Promise<void> {
    const configuration = choices?.model ?? choices?.effort;
    if (configuration !== undefined || this.#request.model != null || this.#request.effort != null) {
      const snapshot = await this.#preparationRefs.capture({
        pageKey: this.pageKey,
        bindingEpoch: this.#registry.refreshPage(this.pageKey).bindingEpoch,
        page: this.#page,
        ...CHATGPT_PREPARATION_SNAPSHOT,
        maxNodes: 5_000,
      });
      if (configuration === undefined || snapshot.nodesTruncated || !hasPreparationSelectionEvidence(snapshot.nodes, configuration)) {
        throw new ProviderSubmissionError('provider.preparation-required',
          'Configuration must be verified before submission. Choose a matching configurationCatalog option with decide configure and configurationId. ' +
          'After a click timeout, the original Coordinator must first team_get this same requestRef and check promptSubmitted, submissionState, terminal and saved choices. ' +
          'Only while still prepared/unsubmitted, native choose/model can verify a fresh current combined model/version/effort summary matching the user intent; otherwise discover or report the evidence gap. ' +
          'Reinspect after menu/composer changes. A saved Submit choice may resume on a later raw choose.');
      }
    }
  }

  async prepare(choices?: PreparationChoices): Promise<void> {
    await this.prepareForObservation();
    const surface = normalizeLabel(this.#request.surface ?? '');
    if (surface === 'work') {
      throw new ProviderSubmissionError(
        'capability.unsupported',
        'SessionPlane supports the Chat surface only; ChatGPT Work is not supported',
      );
    }
    if (surface !== '' && surface !== 'chat' && surface !== 'normal') {
      throw new ProviderSubmissionError('capability.unsupported', 'Named-mode automatic selection is not supported');
    }
    if (choices?.composer === undefined) {
      throw new ProviderSubmissionError('provider.preparation-required', 'Choose the composer on this exact owned page to replace any provider-restored draft with this request prompt; select the requested configuration from configurationCatalog before submitting');
    }
    const composer = await this.#resolvePreparationTarget(choices.composer, COMPOSER_READY_TIMEOUT_MS);
    if (composer === null) {
      throw new ProviderSubmissionError('provider.preparation-required', 'The chosen composer is no longer available');
    }
    if (!(await writeExactComposerValue(this.#page, composer, this.#request.prompt,
      () => this.#resolvePreparationTarget(choices.composer!, 0)))) {
      throw new ProviderSubmissionError(
        'provider.preparation-required',
        'The composer did not retain the exact prompt. Inspect the current editor and choose the composer again on this request.',
      );
    }

    await this.#verifyConfiguration(choices);

    if (choices.submit === undefined) {
      throw new ProviderSubmissionError('provider.preparation-required', 'Prompt is prepared; inspect and choose the current submit control');
    }
    const submit = await this.#resolvePreparationTarget(choices.submit, 0);
    if (submit === null) {
      throw new ProviderSubmissionError('provider.preparation-required', 'The chosen submit control is no longer available');
    }
    await submit.dispose();
    this.#baselineConversationId = parseChatGptConversationId(this.#page.url());
    this.#baselineUserIds = await captureUserIdentitySet(this.#page);
    const attachments = this.#request.attachments ?? [];
    if (attachments.length > 0) {
      const currentComposer = await this.#resolvePreparationTarget(choices.composer, 0);
      if (currentComposer === null) throw new ProviderSubmissionError('provider.preparation-required', 'The chosen composer is no longer available');
      try { await uploadAttachments(this.#page, attachments, currentComposer); }
      finally { await currentComposer.dispose(); }
    }

    const sendButton = await this.#waitForEnabledPreparationTarget(choices.submit, 60_000);
    if (sendButton === null) {
      throw new ProviderSubmissionError('provider.preparation-required', 'The chosen send control is unavailable. Inspect the current page and choose the submit control again on this request.');
    }
    try {
      await this.#verifyConfiguration(choices);
      this.#requireExactPage();
      this.#sendButton = sendButton;
    } catch (error) {
      await sendButton.dispose();
      throw error;
    }
  }

  abandon(): void {
    this.#page.off('request', this.#captureSentIdentity);
    this.#page.off('response', this.#captureAcceptance);
    this.#page.off('requestfailed', this.#captureFailedRequest);
    void this.#page.close().catch(() => undefined);
  }

  async submitOnce(): Promise<void> {
    if (this.#sendButton === null) {
      throw new ProviderSubmissionError(
        'internal.invariant-violation',
        'Submission was not prepared before submit',
        { promptSubmitted: true },
      );
    }
    this.#requireExactPage();
    const composers = this.#page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    if (await composers.count() === 1) {
      const values = await readExactTextCandidates(composers.first());
      if (values.some(value => normalizeLineEndings(value) === normalizeLineEndings(this.#request.prompt))) {
        for (const value of values) this.#preparedPromptHashes.add(createHash('sha256').update(normalizeLineEndings(value)).digest('hex'));
      }
    }
    this.#page.on('request', this.#captureSentIdentity);
    this.#page.on('response', this.#captureAcceptance);
    this.#page.on('requestfailed', this.#captureFailedRequest);
    await this.#sendButton.click({ timeout: 5_000 });
  }

  async captureAcknowledgement(): Promise<ProviderSubmissionAcknowledgement | null> {
    try {
      let deadline = Date.now() + this.#acknowledgementTimeoutMs;
      let hydrationGraceApplied = false;
      const hydrationGraceMs = acknowledgementHydrationGraceMs(this.#acknowledgementTimeoutMs);
      let candidateKey: string | null = null;
      let candidateSince = 0;
      let confirmationGraceApplied = false;
      while (Date.now() < deadline) {
        const conversationId = parseChatGptConversationId(this.#page.url());
        if (
          hydrationGraceApplied === false &&
          conversationId !== null &&
          conversationId !== this.#baselineConversationId
        ) {
          deadline = Math.max(deadline, Date.now() + hydrationGraceMs);
          hydrationGraceApplied = true;
        }
        const messages = (await readChatGptMessages(this.#page)).filter((message) => message.role === 'user');
        let candidate: ProviderSubmissionAcknowledgement | null = null;
        for (let index = Math.max(0, messages.length - 8); index < messages.length; index += 1) {
          const message = messages[index]!;
          if (!(message.messageId !== null && this.#sentMessageIds.has(message.messageId)) &&
            normalizeLineEndings(message.text) !== normalizeLineEndings(this.#request.prompt) &&
            !(await messageHasExactPrompt(this.#page, message, this.#request.prompt))) {
            continue;
          }
          const identity = userIdentity(message);
          if (identity !== null && this.#baselineUserIds.has(identity.identityKey)) {
            continue;
          }
          if (identity === null || conversationId === null || !this.#acceptedMessageIds.has(identity.messageId)) {
            if (hydrationGraceApplied === false) {
              deadline = Math.max(deadline, Date.now() + hydrationGraceMs);
              hydrationGraceApplied = true;
            }
            continue;
          }
          if (this.#baselineConversationId !== null && conversationId !== this.#baselineConversationId) continue;
          candidate = {
            conversationId,
            submittedUserMessageId: identity.messageId,
            submittedUserTurnId: identity.turnId,
          };
          break;
        }
        if ([...this.#sentMessageIds].filter(id =>
          ![...this.#baselineUserIds].some(baseline => baseline.startsWith(`${id}\u0000`))).length !== 1) candidate = null;
        // A single optimistic user node is not acknowledgement. Require the same
        // exact anchor AND an observed empty composer across the commit window.
        const key = candidate !== null && await hasClearedComposer(this.#page)
          ? JSON.stringify(candidate) : null;
        if (key === null || key !== candidateKey) {
          candidateKey = key;
          candidateSince = Date.now();
        } else if (Date.now() - candidateSince >= COMPOSER_STABLE_WINDOW_MS) {
          return { ...candidate!, evidence: 'accepted-request-stable-anchor-cleared-composer' };
        }
        if (key !== null && !confirmationGraceApplied) {
          deadline = Math.max(deadline, Date.now() + COMPOSER_STABLE_WINDOW_MS + 200);
          confirmationGraceApplied = true;
        }
        await this.#page.waitForTimeout(100);
      }
      return null;
    } finally {
      this.#page.off('request', this.#captureSentIdentity);
      this.#page.off('response', this.#captureAcceptance);
      this.#page.off('requestfailed', this.#captureFailedRequest);
    }
  }

  bindAcknowledgement(acknowledgement: ProviderSubmissionAcknowledgement): void {
    const binding = this.#registry.bindPage(this.pageKey, {
      sessionId: this.#request.session.sessionId,
      generation: this.#request.generation,
      conversationId: acknowledgement.conversationId,
    });
    if (binding.state !== 'owned') {
      throw new ProviderSubmissionError(
        'session.page-identity-unverified',
        `ChatGPT acknowledgement did not establish exact ownership for ${this.pageKey}`,
        { promptSubmitted: true },
      );
    }
  }

  #requireExactPage(): void {
    this.#registry.requireSessionPage(this.pageKey, {
      sessionId: this.#request.session.sessionId,
      generation: this.#request.generation,
      conversationId: this.#request.session.conversationId,
    });
  }

}

// Read-only confirmation: a failed/rolled-back submit may leave its full draft
// alongside an optimistic user node. Missing/ambiguous composers fail closed.
async function hasClearedComposer(page: Page): Promise<boolean> {
  const editors = page.locator(CHATGPT_COMPOSER_SELECTOR);
  let visible = 0;
  for (let index = 0; index < await editors.count(); index += 1) {
    const editor = editors.nth(index);
    if (!(await editor.isVisible())) continue;
    visible += 1;
    const cleared = await editor.evaluate((element) => {
      // textarea textContent is its default value, not the current draft.
      if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return element.value.trim() === '';
      return element instanceof HTMLElement && element.innerText.trim() === '' && (element.textContent ?? '').trim() === '';
    }, undefined, { timeout: COMPOSER_READ_TIMEOUT_MS }).catch(() => false);
    if (!cleared) return false;
  }
  return visible === 1;
}

export async function recoverChatGptAcknowledgement(
  page: Page,
  prompt: string,
  expectedConversationId: string,
  selection?: { readonly messageId: string; readonly evidenceHash: string },
): Promise<ProviderSubmissionAcknowledgement | null> {
  const first = await readChatGptAcknowledgement(page, prompt, expectedConversationId, selection);
  if (first === null || !(await hasClearedComposer(page))) return null;
  await page.waitForTimeout(COMPOSER_STABLE_WINDOW_MS);
  const second = await readChatGptAcknowledgement(page, prompt, expectedConversationId, selection);
  if (second === null || JSON.stringify(first) !== JSON.stringify(second) || !(await hasClearedComposer(page))) return null;
  return { ...second, evidence: 'stable-anchor-cleared-composer' };
}

async function readChatGptAcknowledgement(
  page: Page,
  prompt: string,
  expectedConversationId: string,
  selection?: { readonly messageId: string; readonly evidenceHash: string },
): Promise<ProviderSubmissionAcknowledgement | null> {
  const conversationId = parseChatGptConversationId(page.url());
  if (conversationId !== expectedConversationId) return null;

  const messages = (await readChatGptMessages(page)).filter((message) => message.role === 'user');
  if (selection !== undefined) {
    const candidates = messages.filter((message) => userIdentity(message)?.messageId === selection.messageId &&
      submissionEvidenceHash(conversationId, message) === selection.evidenceHash);
    if (candidates.length !== 1) return null;
    const identity = userIdentity(candidates[0]!);
    return identity === null ? null : { conversationId, submittedUserMessageId: identity.messageId, submittedUserTurnId: identity.turnId };
  }
  const matches = new Map<
    string,
    { readonly messageId: string; readonly turnId: string }
  >();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (normalizeLineEndings(message.text) !== normalizeLineEndings(prompt) &&
      !(await messageHasExactPrompt(page, message, prompt))) continue;
    const identity = userIdentity(message);
    if (identity === null) continue;
    matches.set(identity.identityKey, {
      messageId: identity.messageId,
      turnId: identity.turnId,
    });
  }
  if (matches.size !== 1) return null;
  const identity = matches.values().next().value;
  if (identity === undefined) return null;
  return {
    conversationId,
    submittedUserMessageId: identity.messageId,
    submittedUserTurnId: identity.turnId,
  };
}

export async function inspectChatGptSubmissionCandidates(page: Page, conversationId: string) {
  if (parseChatGptConversationId(page.url()) !== conversationId) return [];
  return (await readChatGptMessages(page)).filter((message) => message.role === 'user').flatMap((message) => {
    const identity = userIdentity(message);
    return identity === null ? [] : [{ messageId: identity.messageId,
      evidenceHash: submissionEvidenceHash(conversationId, message),
      text: message.text, textTruncated: false }];
  });
}

function submissionEvidenceHash(conversationId: string, message: ChatGptMessage): string {
  return createHash('sha256').update(JSON.stringify([conversationId, message.messageId, message.turnId, message.text])).digest('hex');
}

/** Passive readiness/security checks on an existing page; no authentication request. */
export async function inspectChatGptPageReady(page: Page, pageKey: string): Promise<void> {
  await waitForProviderPageReady({ page, provider: 'chatgpt', pageKey });
  await assertNoHumanVerification({ page, provider: 'chatgpt', pageKey });
  await assertChatOnlySurface(page);
}

export async function prepareChatGptObservation(page: Page, pageKey: string): Promise<void> {
  await inspectChatGptPageReady(page, pageKey);
  await assertChatGptAuthenticated(page);
}

async function assertChatGptAuthenticated(page: Page): Promise<void> {
  const state = await page
    .evaluate(async () => {
      const response = await fetch('/api/auth/session', { credentials: 'include' }).catch(
        () => null,
      );
      if (response === null || !response.ok) return 'unknown';
      const body = (await response.json().catch(() => null)) as unknown;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return 'unknown';
      }
      const session = body as Record<string, unknown>;
      const accessToken =
        typeof session.accessToken === 'string' ? session.accessToken.trim() : '';
      if (accessToken.length >= 8) return 'authenticated';

      const user = session.user;
      if (
        user !== null &&
        typeof user === 'object' &&
        !Array.isArray(user) &&
        Object.keys(user as Record<string, unknown>).length > 0
      ) {
        return 'authenticated';
      }
      return 'unauthenticated';
    })
    .catch(() => 'unknown');
  if (state !== 'unauthenticated') return;
  throw new ProviderSubmissionError(
    'provider.authentication-required',
    'The dedicated ChatGPT profile is not authenticated',
  );
}

async function assertChatOnlySurface(page: Page): Promise<void> {
  const selectedSurfaceRadios = page.locator(CHATGPT_SELECTORS.chatSurfaceRadios);
  const selectedCount = await selectedSurfaceRadios.count().catch(() => 0);
  for (let index = 0; index < selectedCount; index += 1) {
    const radio = selectedSurfaceRadios.nth(index);
    if (!(await radio.isVisible().catch(() => false))) continue;
    const label = normalizeLabel(
      (await radio.getAttribute('aria-label').catch(() => null)) ??
        (await radio.textContent().catch(() => null)) ??
        '',
    );
    if (/(?:^|[\s()[\]{}:;,!.?·•])work(?=$|[\s()[\]{}:;,!.?·•])/.test(label)) {
      throw new ProviderSubmissionError(
        'capability.unsupported',
        'The active ChatGPT composer is Work; SessionPlane supports Chat only',
      );
    }
    if (label === 'normal' || /(?:^|[\s()[\]{}:;,!.?·•])chat(?=$|[\s()[\]{}:;,!.?·•])/.test(label)) {
      return;
    }
  }

  const selectedRadios = page.locator(
    '[role="radio"][aria-checked="true"], [role="radio"][data-state="checked"]',
  );
  const count = await selectedRadios.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const radio = selectedRadios.nth(index);
    if (!(await radio.isVisible().catch(() => false))) continue;
    const label = normalizeLabel(
      (await radio.getAttribute('aria-label').catch(() => null)) ??
        (await radio.textContent().catch(() => null)) ??
        '',
    );
    if (/(?:^|[\s()[\]{}:;,!.?·•])work(?=$|[\s()[\]{}:;,!.?·•])/.test(label)) {
      throw new ProviderSubmissionError(
        'capability.unsupported',
        'The active ChatGPT composer is Work; SessionPlane supports Chat only',
      );
    }
  }
}

async function uploadAttachments(
  page: Page,
  attachments: readonly ProviderAttachment[],
  composer: PreparationElement,
): Promise<void> {
  const paths = attachments.map((attachment) => attachment.path);
  const directInput = await firstExisting(page, CHATGPT_SELECTORS.fileInputs);
  if (directInput !== null) {
    await directInput.setInputFiles(paths);
  } else {
    const trigger = await firstVisible(page, CHATGPT_SELECTORS.uploadTriggers);
    if (trigger === null) {
      throw new ProviderSubmissionError(
        'provider.attachment-surface-unavailable',
        'ChatGPT file upload surface is unavailable',
      );
    }
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
    await trigger.click({ timeout: 5_000 });
    let chooser = await chooserPromise;
    if (chooser === null) {
      const menuItem = await firstVisible(page, CHATGPT_SELECTORS.uploadMenuItems);
      if (menuItem !== null) {
        const secondChooser = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
        await menuItem.click({ timeout: 5_000 });
        chooser = await secondChooser;
      }
    }
    if (chooser !== null) {
      await chooser.setFiles(paths);
    } else {
      const lateInput = await firstExisting(page, CHATGPT_SELECTORS.fileInputs);
      if (lateInput === null) {
        throw new ProviderSubmissionError(
          'provider.attachment-surface-unavailable',
          'ChatGPT upload control did not expose a file chooser',
        );
      }
      await lateInput.setInputFiles(paths);
    }
  }

  const deadline = Date.now() + 20_000;
  do {
    if (await attachmentsAcknowledged(composer, attachments, CHATGPT_SELECTORS.attachmentEvidence, [CHATGPT_SELECTORS.messages])) return;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new ProviderSubmissionError(
    'provider.attachment-evidence-missing',
    'ChatGPT did not acknowledge the selected attachment files',
  );
}

async function firstExisting(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if ((await candidate.count().catch(() => 0)) > 0) return candidate;
  }
  return null;
}

async function firstVisible(
  page: Page,
  selectors: readonly string[],
  timeoutMs = VISIBLE_SELECTOR_TIMEOUT_MS,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const candidate = page.locator(selector).filter({ visible: true }).first();
      if ((await candidate.count().catch(() => 0)) > 0) {
        return candidate;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(VISIBLE_SELECTOR_POLL_MS, remaining));
  }
  return null;
}

async function readExactTextCandidates(locator: PreparationElement, messageContent = false): Promise<readonly string[]> {
  return await (locator as Locator)
    .evaluate(
      (element: Element, messageContent: boolean) => {
        const values: string[] = [];
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          values.push(element.value);
        }
        if (element instanceof HTMLElement) {
          values.push(element.innerText, element.textContent ?? '');
          const inlineCode = Array.from(element.querySelectorAll('code'));
          if (
            inlineCode.length > 0 &&
            inlineCode.every((code) => code.closest('pre') === null && code.parentElement?.closest('code') === null)
          ) {
            const renderedText = element.innerText;
            const codeRanges: Array<{ start: number; end: number }> = [];
            for (const code of inlineCode) {
              const contentRange = document.createRange();
              contentRange.selectNodeContents(code);
              const codeText = contentRange.toString();
              if (codeText.length === 0 || codeText.includes('`')) {
                codeRanges.length = 0;
                break;
              }

              const prefixRange = document.createRange();
              prefixRange.selectNodeContents(element);
              prefixRange.setEndBefore(code);
              const start = prefixRange.toString().length;
              const end = start + codeText.length;
              if (renderedText.slice(start, end) !== codeText) {
                codeRanges.length = 0;
                break;
              }
              codeRanges.push({ start, end });
            }
            if (codeRanges.length === inlineCode.length) {
              let markdownText = renderedText;
              for (const { start, end } of codeRanges.sort((left, right) => right.start - left.start)) {
                markdownText = `${markdownText.slice(0, start)}\`${markdownText.slice(start, end)}\`${markdownText.slice(end)}`;
              }
              values.push(markdownText);
            }
          }
          // Provider controls are not authored message content. Detached DOM text
          // also avoids layout-only line breaks inside inline links.
          let blockRoot = element;
          if (messageContent) {
            blockRoot = element.cloneNode(true) as HTMLElement;
            blockRoot.querySelectorAll('button, [role="button"], svg, [data-thread-find-skip]').forEach((control) => control.remove());
            blockRoot.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
            values.push(blockRoot.textContent ?? '');
            while (blockRoot.children.length === 1 &&
                Array.from(blockRoot.childNodes).every((node) => node.nodeType !== Node.TEXT_NODE || (node.textContent ?? '').trim() === '') &&
                blockRoot.firstElementChild instanceof HTMLElement && blockRoot.firstElementChild.tagName === 'DIV') {
              blockRoot = blockRoot.firstElementChild;
            }
          }
          const blockChildren = Array.from(blockRoot.childNodes);
          if (
            blockChildren.length > 0 &&
            blockChildren.every(
              (node) =>
                (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') ||
                (node instanceof HTMLElement &&
                  (node.tagName === 'P' || node.tagName === 'DIV')),
            )
          ) {
            const blocks = blockChildren.filter((node): node is HTMLElement => node instanceof HTMLElement)
              .map((node) => node.textContent ?? '');
            values.push(blocks.join('\n'));
            if (messageContent) values.push(blocks.join('\n\n'));

          }
        }
        return values;
      },
      messageContent,
      { timeout: COMPOSER_READ_TIMEOUT_MS },
    )
    .catch(() => [] as string[]);
}

export async function composerHasExactValue(
  composer: PreparationElement,
  expected: string,
): Promise<boolean> {
  const normalizedExpected = normalizeLineEndings(expected);
  const values = await readExactTextCandidates(composer);
  return values.some((value) => normalizeLineEndings(value) === normalizedExpected);
}

async function messageHasExactPrompt(page: Page, identity: ChatGptMessage, expected: string): Promise<boolean> {
  const id = identity.messageId ?? identity.turnId;
  if (id === null) return false;
  const escaped = await page.evaluate((value) => CSS.escape(value), id);
  const identitySelector = identity.messageId !== null
    ? `[data-message-id="${escaped}"], [data-chatgpt-search-message-ids~="${escaped}"]`
    : `[data-turn-id="${escaped}"]`;
  const message = page.locator(`:is(${identitySelector}):is(${CHATGPT_SELECTORS.userMessages}), :is(${identitySelector}) :is(${CHATGPT_SELECTORS.userMessages})`).first();
  if (await message.count() === 0) return false;
  const normalizedExpected = normalizeLineEndings(expected);
  const matchesExactPrompt = async (): Promise<boolean> => {
    for (const selector of CHATGPT_SELECTORS.userMessageContent) {
      const content = message.locator(selector).first();
      if ((await content.count().catch(() => 0)) === 0) continue;
      const values = await readExactTextCandidates(content, true);
      if (values.some((value) => normalizeLineEndings(value) === normalizedExpected)) {
        return true;
      }
    }
    const fallbackValues = await readExactTextCandidates(message, true);
    return fallbackValues.some(
      (value) => normalizeLineEndings(value) === normalizedExpected,
    );
  };

  if (await matchesExactPrompt()) return true;

  const collapsedControl = message.locator(CHATGPT_SELECTORS.userMessageExpansionControls);
  if ((await collapsedControl.count().catch(() => 0)) !== 1) return false;
  await collapsedControl.click({ timeout: 1_000 }).catch(() => undefined);
  return await matchesExactPrompt();
}

async function writeExactComposerValue(
  page: Page,
  composer: PreparationElement,
  expected: string,
  resolveComposer: () => Promise<ElementHandle<Element> | null>,
): Promise<boolean> {
  await waitForComposerStability(page, composer, COMPOSER_HYDRATION_TIMEOUT_MS);
  for (let attempt = 0; attempt < COMPOSER_WRITE_ATTEMPTS; attempt += 1) {
    if (await composerHasExactValue(composer, expected)) {
      return true;
    }
    if (!(await clearComposerValue(page, composer))) {
      continue;
    }
    await composer.focus().catch(() => undefined);
    await page.keyboard.insertText(expected).catch(async () => {
      await composer.fill(expected);
    });
    const current = await resolveComposer();
    if (current === null) return false;
    if ('dispose' in composer) await composer.dispose();
    composer = current;
    if (await waitForComposerValue(page, composer, expected)) {
      return true;
    }
  }
  return await waitForComposerValue(page, composer, expected);
}

async function clearComposerValue(page: Page, composer: PreparationElement): Promise<boolean> {
  await composer.click({ timeout: 5_000 }).catch(() => undefined);
  await composer.focus().catch(() => undefined);
  const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
  await page.keyboard.press(selectAll).catch(() => undefined);
  await page.keyboard.press('Backspace').catch(() => undefined);
  if (await waitForComposerValue(page, composer, '')) {
    return true;
  }
  await composer.fill('').catch(() => undefined);
  return await waitForComposerValue(page, composer, '');
}

async function waitForComposerStability(
  page: Page,
  composer: PreparationElement,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    const values = await readExactTextCandidates(composer);
    if (values.length === 0) {
      previous = '';
      stableSince = 0;
      await page.waitForTimeout(COMPOSER_COMMIT_POLL_MS);
      continue;
    }
    const signature = values.map(normalizeLineEndings).join('\u0000');
    const now = Date.now();
    if (signature === previous) {
      if (stableSince === 0) stableSince = now;
      if (now - stableSince >= COMPOSER_STABLE_WINDOW_MS) return;
    } else {
      previous = signature;
      stableSince = now;
    }
    await page.waitForTimeout(COMPOSER_COMMIT_POLL_MS);
  }
}

async function waitForComposerValue(
  page: Page,
  composer: PreparationElement,
  expected: string,
): Promise<boolean> {
  const normalizedExpected = normalizeLineEndings(expected);
  let deadline = Date.now() + COMPOSER_COMMIT_TIMEOUT_MS;
  let matchingSince = 0;
  for (;;) {
    const values = await readExactTextCandidates(composer);
    const now = Date.now();
    if (values.some((value) => normalizeLineEndings(value) === normalizedExpected)) {
      if (matchingSince === 0) {
        matchingSince = now;
        deadline = Math.max(deadline, now + COMPOSER_STABLE_WINDOW_MS);
      }
      if (now - matchingSince >= COMPOSER_STABLE_WINDOW_MS) return true;
    } else {
      matchingSince = 0;
    }
    const remaining = deadline - now;
    if (remaining <= 0) {
      return false;
    }
    await page.waitForTimeout(Math.min(COMPOSER_COMMIT_POLL_MS, remaining));
  }
}

async function captureUserIdentitySet(page: Page): Promise<Set<string>> {
  const identities = new Set<string>();
  for (const message of await readChatGptMessages(page)) {
    if (message.role !== 'user') continue;
    const identity = userIdentity(message);
    if (identity !== null) {
      identities.add(identity.identityKey);
    }
  }
  return identities;
}

function userIdentity(message: ChatGptMessage): {
  readonly messageId: string;
  readonly turnId: string;
  readonly identityKey: string;
} | null {
  const messageId = message.messageId ?? message.turnId;
  const turnId = message.turnId ?? message.messageId;
  if (messageId === null || turnId === null) {
    return null;
  }
  return { messageId, turnId, identityKey: `${messageId}\u0000${turnId}` };
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

function acknowledgementHydrationGraceMs(acknowledgementTimeoutMs: number): number {
  return Math.min(30_000, Math.max(500, acknowledgementTimeoutMs));
}

function normalizeLabel(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}
