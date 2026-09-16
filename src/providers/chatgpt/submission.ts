import type { Locator, Page } from 'playwright-core';

import type { PageRegistry } from '../../browser/page-registry.ts';
import { parseChatGptConversationId } from '../../browser/page-binding.ts';
import {
  ProviderSubmissionError,
  type ProviderSubmission,
  type ProviderSubmissionAcknowledgement,
  type ProviderSubmissionRequest,
} from '../provider-adapter.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

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
  #sendButton: Locator | null = null;
  #baselineUserIds = new Set<string>();

  constructor(options: ChatGptSubmissionOptions) {
    this.#page = options.page;
    this.pageKey = options.pageKey;
    this.#registry = options.pageRegistry;
    this.#request = options.request;
    this.#acknowledgementTimeoutMs = options.acknowledgementTimeoutMs;
    this.#initialUrl = options.initialUrl ?? null;
  }

  async prepare(): Promise<void> {
    if (this.#initialUrl !== null) {
      await this.#page.goto(this.#initialUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
      this.#registry.refreshPage(this.pageKey);
    }
    this.#requireExactPage();
    if (this.#request.model !== null) {
      await this.#selectModel(this.#request.model);
    }

    const composer = await firstVisible(this.#page, CHATGPT_SELECTORS.composer);
    if (composer === null || !(await composer.isEditable().catch(() => false))) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        'The exact ChatGPT composer is not editable',
      );
    }

    this.#baselineUserIds = await captureUserIdentitySet(this.#page);
    await composer.fill(this.#request.prompt);
    const actual = await readComposerValue(composer);
    if (normalizeLineEndings(actual) !== normalizeLineEndings(this.#request.prompt)) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        'ChatGPT composer value did not match the requested prompt',
      );
    }

    const sendButton = await firstVisible(this.#page, CHATGPT_SELECTORS.sendButton);
    if (
      sendButton === null ||
      (await sendButton.isDisabled().catch(() => true)) ||
      !(await sendButton.isEnabled().catch(() => false))
    ) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        'The exact ChatGPT send control is unavailable',
      );
    }
    this.#sendButton = sendButton;
    this.#requireExactPage();
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
    const deadline = Date.now() + this.#acknowledgementTimeoutMs;
    while (Date.now() < deadline) {
      const conversationId = parseChatGptConversationId(this.#page.url());
      const messages = this.#page.locator(CHATGPT_SELECTORS.userMessages);
      const count = await messages.count().catch(() => 0);
      for (let index = Math.max(0, count - 8); index < count; index += 1) {
        const message = messages.nth(index);
        const identity = await readUserIdentity(message);
        if (identity === null || this.#baselineUserIds.has(identity.identityKey)) {
          continue;
        }
        const text = normalizeLineEndings((await message.textContent().catch(() => null)) ?? '');
        if (text !== normalizeLineEndings(this.#request.prompt) || conversationId === null) {
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

  async #selectModel(requestedModel: string): Promise<void> {
    const switcher = await firstVisible(this.#page, CHATGPT_SELECTORS.modelSwitcher);
    if (switcher === null) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        `Requested model is unavailable: ${requestedModel}`,
      );
    }
    if (
      (await switcher.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
      (await switcher.isDisabled().catch(() => false))
    ) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        `Requested model is unavailable: ${requestedModel}`,
      );
    }
    const currentText = normalizeLabel((await switcher.textContent().catch(() => null)) ?? '');
    if (modelLabelMatches(currentText, requestedModel)) {
      return;
    }

    await switcher.click({ timeout: 5_000 });
    const options = this.#page.locator(CHATGPT_SELECTORS.modelOptions);
    const optionCount = await options.count();
    let exactOption: Locator | null = null;
    for (let index = 0; index < optionCount; index += 1) {
      const candidate = options.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) {
        continue;
      }
      const label = normalizeLabel((await candidate.textContent().catch(() => null)) ?? '');
      if (label === normalizeLabel(requestedModel)) {
        exactOption = candidate;
        break;
      }
    }
    if (
      exactOption === null ||
      (await exactOption.getAttribute('aria-disabled')) === 'true' ||
      (await exactOption.isDisabled().catch(() => false))
    ) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        `Requested model is absent or disabled: ${requestedModel}`,
      );
    }
    await exactOption.click({ timeout: 5_000 });
    if (!(await waitForModelLabel(this.#page, switcher, requestedModel))) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        `Requested model selection was not acknowledged: ${requestedModel}`,
      );
    }
  }
}

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }
  return null;
}

async function readComposerValue(composer: Locator): Promise<string> {
  return await composer.evaluate((element) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      return element.value;
    }
    if (element instanceof HTMLElement) {
      return element.innerText;
    }
    return element.textContent ?? '';
  });
}

async function captureUserIdentitySet(page: Page): Promise<Set<string>> {
  const identities = new Set<string>();
  const messages = page.locator(CHATGPT_SELECTORS.userMessages);
  const count = await messages.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const identity = await readUserIdentity(messages.nth(index));
    if (identity !== null) {
      identities.add(identity.identityKey);
    }
  }
  return identities;
}

async function readUserIdentity(locator: Locator): Promise<{
  readonly messageId: string;
  readonly turnId: string;
  readonly identityKey: string;
} | null> {
  const attributes = await locator
    .evaluate((element) => {
      const identityNode = element.closest('[data-message-id], [data-turn-id]') ?? element;
      return {
        messageId:
          identityNode.getAttribute('data-message-id') ?? element.getAttribute('data-message-id'),
        turnId: identityNode.getAttribute('data-turn-id') ?? element.getAttribute('data-turn-id'),
      };
    })
    .catch(() => null);
  if (attributes === null || (attributes.messageId === null && attributes.turnId === null)) {
    return null;
  }
  const messageId = attributes.messageId ?? attributes.turnId;
  const turnId = attributes.turnId ?? attributes.messageId;
  if (messageId === null || turnId === null) {
    return null;
  }
  return { messageId, turnId, identityKey: `${messageId}\u0000${turnId}` };
}

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

function normalizeLabel(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function modelLabelMatches(value: string, requestedModel: string): boolean {
  const actual = normalizeLabel(value);
  const expected = normalizeLabel(requestedModel);
  if (actual === expected) {
    return true;
  }
  if (expected.length === 0) {
    return false;
  }

  let offset = actual.indexOf(expected);
  while (offset >= 0) {
    const before = actual[offset - 1];
    const after = actual[offset + expected.length];
    if (isLabelBoundary(before) && isLabelBoundary(after)) {
      return true;
    }
    offset = actual.indexOf(expected, offset + 1);
  }
  return false;
}

function isLabelBoundary(value: string | undefined): boolean {
  return value === undefined || /\s|[()[\]{}:]/.test(value);
}

async function waitForModelLabel(
  page: Page,
  switcher: Locator,
  requestedModel: string,
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  do {
    const label = (await switcher.textContent().catch(() => null)) ?? '';
    if (modelLabelMatches(label, requestedModel)) {
      return true;
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  return false;
}

