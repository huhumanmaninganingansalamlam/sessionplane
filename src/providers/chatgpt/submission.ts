import type { Locator, Page } from 'playwright-core';

import type { PageRegistry } from '../../browser/page-registry.ts';
import { parseChatGptConversationId } from '../../browser/page-binding.ts';
import {
  ProviderSubmissionError,
  type ProviderAttachment,
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
    const surface = normalizeLabel(this.#request.surface ?? '');
    if (surface === 'work') {
      throw new ProviderSubmissionError(
        'capability.unsupported',
        'SessionPlane supports the Chat surface only; ChatGPT Work is not supported',
      );
    }
    await assertChatOnlySurface(this.#page);
    if (surface !== '' && surface !== 'chat' && surface !== 'normal') {
      await selectNamedMode(
        this.#page,
        CHATGPT_SELECTORS.surfaceSwitcher,
        this.#request.surface ?? surface,
        'surface',
      );
    }

    if (this.#request.model !== null) {
      await this.#selectModel(this.#request.model);
    }
    if (
      this.#request.effort !== undefined &&
      this.#request.effort !== null &&
      normalizeLabel(this.#request.effort) !== ''
    ) {
      await selectNamedMode(
        this.#page,
        CHATGPT_SELECTORS.effortSwitcher,
        this.#request.effort,
        'effort',
      );
    }

    const composer = await firstVisible(this.#page, CHATGPT_SELECTORS.composer);
    if (composer === null || !(await composer.isEditable().catch(() => false))) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        'The exact ChatGPT composer is not editable',
      );
    }

    this.#baselineUserIds = await captureUserIdentitySet(this.#page);
    const attachments = this.#request.attachments ?? [];
    if (attachments.length > 0) {
      await uploadAttachments(this.#page, attachments);
    }
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

async function assertChatOnlySurface(page: Page): Promise<void> {
  for (const selector of CHATGPT_SELECTORS.unsupportedWorkSurfaceMarkers) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) {
      throw new ProviderSubmissionError(
        'capability.unsupported',
        'The active ChatGPT composer is Work; SessionPlane supports Chat only',
      );
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
    if (label === 'work' || modelLabelMatches(label, 'work')) {
      throw new ProviderSubmissionError(
        'capability.unsupported',
        'The active ChatGPT composer is Work; SessionPlane supports Chat only',
      );
    }
  }
}

async function selectNamedMode(
  page: Page,
  switcherSelectors: readonly string[],
  requested: string,
  kind: 'surface' | 'effort',
): Promise<void> {
  const targets = modeLabels(requested);
  const switcher = await firstVisible(page, switcherSelectors);
  if (switcher !== null) {
    const current = normalizeLabel((await switcher.textContent().catch(() => null)) ?? '');
    if (targets.some((target) => modelLabelMatches(current, target))) return;
    if (
      (await switcher.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
      (await switcher.isDisabled().catch(() => false))
    ) {
      throw new ProviderSubmissionError(
        'provider.mode-unavailable',
        `Requested ChatGPT ${kind} is disabled: ${requested}`,
      );
    }
    await switcher.click({ timeout: 5_000 });
  }

  const options = page.locator(CHATGPT_SELECTORS.namedModeOptions);
  const count = await options.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!(await option.isVisible().catch(() => false))) continue;
    const label = normalizeLabel((await option.textContent().catch(() => null)) ?? '');
    if (!targets.some((target) => modelLabelMatches(label, target))) continue;
    if (
      (await option.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
      (await option.isDisabled().catch(() => false))
    ) {
      throw new ProviderSubmissionError(
        'provider.mode-unavailable',
        `Requested ChatGPT ${kind} is disabled: ${requested}`,
      );
    }
    await option.click({ timeout: 5_000 });
    if (await waitForNamedMode(page, switcher, option, targets)) return;
    throw new ProviderSubmissionError(
      'provider.mode-unavailable',
      `Requested ChatGPT ${kind} selection was not acknowledged: ${requested}`,
    );
  }
  throw new ProviderSubmissionError(
    'provider.mode-unavailable',
    `Requested ChatGPT ${kind} is unavailable: ${requested}`,
  );
}

async function waitForNamedMode(
  page: Page,
  switcher: Locator | null,
  selectedOption: Locator,
  targets: readonly string[],
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  do {
    if (switcher !== null) {
      const switcherLabels = [
        await switcher.textContent().catch(() => null),
        await switcher.getAttribute('aria-label').catch(() => null),
        await switcher.getAttribute('title').catch(() => null),
      ];
      if (
        switcherLabels.some(
          (value) =>
            value !== null &&
            targets.some((target) => modelLabelMatches(normalizeLabel(value), target)),
        )
      ) {
        return true;
      }
    }

    const selectedState = await selectedOption
      .evaluate((element) => ({
        ariaChecked: element.getAttribute('aria-checked'),
        ariaPressed: element.getAttribute('aria-pressed'),
        ariaSelected: element.getAttribute('aria-selected'),
        dataState: element.getAttribute('data-state'),
      }))
      .catch(() => null);
    if (
      selectedState !== null &&
      (selectedState.ariaChecked === 'true' ||
        selectedState.ariaPressed === 'true' ||
        selectedState.ariaSelected === 'true' ||
        selectedState.dataState === 'checked' ||
        selectedState.dataState === 'active')
    ) {
      return true;
    }

    const selectedLabels = await page
      .locator(
        '[aria-checked="true"], [aria-pressed="true"], [aria-selected="true"], [data-state="checked"], [data-state="active"]',
      )
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
    if (
      selectedLabels.some((value) =>
        targets.some((target) => modelLabelMatches(normalizeLabel(value), target)),
      )
    ) {
      return true;
    }
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  return false;
}

function modeLabels(value: string): readonly string[] {
  const normalized = normalizeLabel(value).replaceAll('_', '-');
  switch (normalized) {
    case 'deep':
    case 'research':
    case 'deep-research':
    case 'deep research':
      return ['deep research', 'deep-research'];
    case 'image':
    case 'create-image':
    case 'create image':
      return ['create image', 'image'];
    case 'extended':
    case 'extended-thinking':
      return ['extended thinking', 'extended'];
    default:
      return [normalized];
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

