import type { ElementHandle, Locator, Page } from 'playwright-core';

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
import { CHATGPT_SELECTORS } from './selectors.ts';
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
    } else {
      await waitForProviderPageReady({ page: this.#page, provider: this.provider, pageKey: this.pageKey });
    }
    this.#requireExactPage();
    await assertNoHumanVerification({ page: this.#page, provider: this.provider, pageKey: this.pageKey });
    await assertChatGptAuthenticated(this.#page);
    await assertChatOnlySurface(this.#page);
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
        interactive: false,
        compact: true,
        maxNodes: 5_000,
      });
      const matches = snapshot.nodes.filter((node) => matchesPreparationTarget(node, target));
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

  async #hasSelectedPreparationTarget(target: PreparationTarget): Promise<boolean> {
    const binding = this.#registry.refreshPage(this.pageKey);
    const snapshot = await this.#preparationRefs.capture({
      pageKey: this.pageKey,
      bindingEpoch: binding.bindingEpoch,
      page: this.#page,
      interactive: false,
      compact: true,
      maxNodes: 5_000,
    });
    return !snapshot.nodesTruncated && hasPreparationSelectionEvidence(snapshot.nodes, target);
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
      throw new ProviderSubmissionError('provider.preparation-required', 'Choose the observed composer before continuation');
    }
    for (const purpose of ['model', 'effort'] as const) {
      const intent = this.#request[purpose];
      const choice = choices[purpose];
      if (intent == null) continue;
      if (choice === undefined) {
        throw new ProviderSubmissionError('provider.preparation-required',
          `No ${purpose} choice is recorded for ${JSON.stringify(intent)}. Choose a matching observed selection; reveal only opens options. Continue this requestRef.`);
      }
      if (!(await this.#hasSelectedPreparationTarget(choice))) {
        throw new ProviderSubmissionError('provider.preparation-required',
          `Recorded ${purpose} choice ${JSON.stringify(choice.name || choice.text)} is no longer verified on the current page. Reopen its chooser and choose current evidence matching ${JSON.stringify(intent)}. Another model/effort choice may have changed the same control. Continue this requestRef; cancelling and resending does not repair the selection.`);
      }
    }
    const composer = await this.#resolvePreparationTarget(choices.composer, COMPOSER_READY_TIMEOUT_MS);
    if (composer === null) {
      throw new ProviderSubmissionError('provider.preparation-required', 'The chosen composer is no longer available');
    }
    if (!(await writeExactComposerValue(this.#page, composer, this.#request.prompt,
      () => this.#resolvePreparationTarget(choices.composer!, 0)))) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        'ChatGPT composer value did not match the requested prompt',
      );
    }

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
    if (attachments.length > 0) await uploadAttachments(this.#page, attachments);

    const sendButton = await this.#waitForEnabledPreparationTarget(choices.submit, 60_000);
    if (sendButton === null) {
      throw new ProviderSubmissionError('provider.composer-unavailable', 'The chosen send control is unavailable after composer preparation');
    }
    this.#sendButton = sendButton;
    this.#requireExactPage();
  }

  abandon(): void {
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
    await this.#sendButton.click({ timeout: 5_000 });
  }

  async captureAcknowledgement(): Promise<ProviderSubmissionAcknowledgement | null> {
    let deadline = Date.now() + this.#acknowledgementTimeoutMs;
    let hydrationGraceApplied = false;
    const hydrationGraceMs = acknowledgementHydrationGraceMs(this.#acknowledgementTimeoutMs);
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
      for (let index = Math.max(0, messages.length - 8); index < messages.length; index += 1) {
        const message = messages[index]!;
        if (normalizeLineEndings(message.text) !== normalizeLineEndings(this.#request.prompt) &&
          !(await messageHasExactPrompt(this.#page.locator(CHATGPT_SELECTORS.userMessages).nth(index), this.#request.prompt))) {
          continue;
        }
        const identity = userIdentity(message);
        if (identity !== null && this.#baselineUserIds.has(identity.identityKey)) {
          continue;
        }
        if (identity === null || conversationId === null) {
          if (hydrationGraceApplied === false) {
            deadline = Math.max(deadline, Date.now() + hydrationGraceMs);
            hydrationGraceApplied = true;
          }
          continue;
        }
        return {
          conversationId,
          submittedUserMessageId: identity.messageId,
          submittedUserTurnId: identity.turnId,
        };
      }
      await this.#page.waitForTimeout(100);
    }
    return null;
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

export async function recoverChatGptAcknowledgement(
  page: Page,
  prompt: string,
  expectedConversationId: string,
): Promise<ProviderSubmissionAcknowledgement | null> {
  const conversationId = parseChatGptConversationId(page.url());
  if (conversationId !== expectedConversationId) return null;

  const messages = (await readChatGptMessages(page)).filter((message) => message.role === 'user');
  const matches = new Map<
    string,
    { readonly messageId: string; readonly turnId: string }
  >();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (normalizeLineEndings(message.text) !== normalizeLineEndings(prompt) &&
      !(await messageHasExactPrompt(page.locator(CHATGPT_SELECTORS.userMessages).nth(index), prompt))) continue;
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
    if (await attachmentsAcknowledged(page, attachments)) return;
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

async function attachmentsAcknowledged(
  page: Page,
  attachments: readonly ProviderAttachment[],
): Promise<boolean> {
  const expected = attachments.map((attachment) => normalizeLabel(attachment.name));
  const body = normalizeLabel((await page.locator('body').innerText().catch(() => '')) ?? '');
  if (expected.every((name) => body.includes(name))) return true;

  const evidence: string[] = [];
  for (const selector of CHATGPT_SELECTORS.attachmentEvidence) {
    const values = await page
      .locator(selector)
      .evaluateAll((elements) =>
        elements.map((element) =>
          [
            element.textContent ?? '',
            element.getAttribute('aria-label') ?? '',
            element.getAttribute('title') ?? '',
          ].join(' '),
        ),
      )
      .catch(() => [] as string[]);
    evidence.push(...values);
  }
  const normalizedEvidence = normalizeLabel(evidence.join(' '));
  return expected.every((name) => normalizedEvidence.includes(name));
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

async function readExactTextCandidates(locator: PreparationElement): Promise<readonly string[]> {
  return await (locator as Locator)
    .evaluate(
      (element: Element) => {
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
          const blockChildren = Array.from(element.childNodes);
          if (
            blockChildren.length > 0 &&
            blockChildren.every(
              (node) =>
                (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() === '') ||
                (node instanceof HTMLElement &&
                  (node.tagName === 'P' || node.tagName === 'DIV')),
            )
          ) {
            values.push(
              blockChildren
                .filter((node): node is HTMLElement => node instanceof HTMLElement)
                .map((node) => node.textContent ?? '')
                .join('\n'),
            );
          }
        }
        return values;
      },
      undefined,
      { timeout: COMPOSER_READ_TIMEOUT_MS },
    )
    .catch(() => [] as string[]);
}

async function composerHasExactValue(
  composer: PreparationElement,
  expected: string,
): Promise<boolean> {
  const normalizedExpected = normalizeLineEndings(expected);
  const values = await readExactTextCandidates(composer);
  return values.some((value) => normalizeLineEndings(value) === normalizedExpected);
}

async function messageHasExactPrompt(message: Locator, expected: string): Promise<boolean> {
  const normalizedExpected = normalizeLineEndings(expected);
  const matchesExactPrompt = async (): Promise<boolean> => {
    for (const selector of CHATGPT_SELECTORS.userMessageContent) {
      const content = message.locator(selector).first();
      if ((await content.count().catch(() => 0)) === 0) continue;
      const values = await readExactTextCandidates(content);
      if (values.some((value) => normalizeLineEndings(value) === normalizedExpected)) {
        return true;
      }
    }
    const fallbackValues = await readExactTextCandidates(message);
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
