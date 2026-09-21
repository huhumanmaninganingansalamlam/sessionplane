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
import { assertNoHumanVerification } from '../human-verification.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

const COMPOSER_HYDRATION_TIMEOUT_MS = 3_000;
const COMPOSER_COMMIT_TIMEOUT_MS = 3_000;
const COMPOSER_COMMIT_POLL_MS = 50;
const COMPOSER_READ_TIMEOUT_MS = 500;
const COMPOSER_STABLE_WINDOW_MS = 250;
const COMPOSER_WRITE_ATTEMPTS = 2;
const VISIBLE_SELECTOR_TIMEOUT_MS = 5_000;
const VISIBLE_SELECTOR_POLL_MS = 50;
const MODEL_OPTION_DISCOVERY_TIMEOUT_MS = 2_000;
const MODEL_OPTION_DISCOVERY_POLL_MS = 50;

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

  async prepare(): Promise<void> {
    if (this.#initialUrl !== null) {
      await this.#page.goto(this.#initialUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
      this.#registry.refreshPage(this.pageKey);
    }
    this.#requireExactPage();
    await assertNoHumanVerification({
      page: this.#page,
      provider: this.provider,
      pageKey: this.pageKey,
    });
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

    const composer = await firstVisibleComposer(this.#page);
    if (composer === null || !(await composer.isEditable().catch(() => false))) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        'The exact ChatGPT composer is not editable',
      );
    }

    this.#baselineConversationId = parseChatGptConversationId(this.#page.url());
    this.#baselineUserIds = await captureUserIdentitySet(this.#page);
    const attachments = this.#request.attachments ?? [];
    if (attachments.length > 0) {
      await uploadAttachments(this.#page, attachments);
    }
    if (!(await writeExactComposerValue(this.#page, composer, this.#request.prompt))) {
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
      const messages = this.#page.locator(CHATGPT_SELECTORS.userMessages);
      const count = await messages.count().catch(() => 0);
      for (let index = Math.max(0, count - 8); index < count; index += 1) {
        const message = messages.nth(index);
        if ((await messageHasExactPrompt(message, this.#request.prompt)) === false) {
          continue;
        }
        const identity = await readUserIdentity(message);
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
    await switcher.click({ timeout: 5_000 });
    const discovered = await discoverModelOptions(this.#page);
    const selected = resolveRequestedModel(discovered, requestedModel);
    if (selected === null) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        `Requested model is absent or disabled: ${requestedModel}`,
      );
    }
    await selected.locator.click({ timeout: 5_000 });
    if (!(await waitForModelLabel(this.#page, switcher, selected.label))) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        `Requested model selection was not acknowledged: ${selected.label}`,
      );
    }
  }
}

interface DiscoveredModelOption {
  readonly locator: Locator;
  readonly label: string;
  readonly normalizedLabel: string;
  readonly disabled: boolean;
  readonly index: number;
}

async function discoverModelOptions(page: Page): Promise<readonly DiscoveredModelOption[]> {
  const deadline = Date.now() + MODEL_OPTION_DISCOVERY_TIMEOUT_MS;
  const options = page.locator(CHATGPT_SELECTORS.modelOptions);
  do {
    const discovered: DiscoveredModelOption[] = [];
    const count = await options.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = options.nth(index);
      if (!(await locator.isVisible().catch(() => false))) continue;
      const label = ((await locator.textContent().catch(() => null)) ?? '').trim();
      const normalizedLabel = normalizeLabel(label);
      if (normalizedLabel === '') continue;
      discovered.push({
        locator,
        label,
        normalizedLabel,
        disabled:
          (await locator.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
          (await locator.isDisabled().catch(() => false)),
        index,
      });
    }
    if (discovered.length > 0) return discovered;
    await page.waitForTimeout(MODEL_OPTION_DISCOVERY_POLL_MS);
  } while (Date.now() < deadline);
  return [];
}

function resolveRequestedModel(
  options: readonly DiscoveredModelOption[],
  requestedModel: string,
): DiscoveredModelOption | null {
  const normalizedRequest = normalizeLabel(requestedModel);
  if (normalizedRequest === 'pro') {
    return [...options]
      .filter((option) => !option.disabled && isProModelLabel(option.normalizedLabel))
      .sort(compareProModelOptions)[0] ?? null;
  }

  return options.find(
    (option) =>
      !option.disabled &&
      (option.normalizedLabel === normalizedRequest ||
        modelLabelMatches(option.normalizedLabel, normalizedRequest)),
  ) ?? null;
}

function isProModelLabel(value: string): boolean {
  return /\bpro\b/.test(normalizeLabel(value));
}

function compareProModelOptions(left: DiscoveredModelOption, right: DiscoveredModelOption): number {
  const versionOrder = compareVersionParts(
    modelVersionParts(right.normalizedLabel),
    modelVersionParts(left.normalizedLabel),
  );
  if (versionOrder !== 0) return versionOrder;
  return left.index - right.index;
}

function modelVersionParts(value: string): readonly number[] {
  const match = normalizeLabel(value).match(/\d+(?:\.\d+)*/);
  return match === null ? [] : match[0].split('.').map((part) => Number(part));
}

function compareVersionParts(left: readonly number[], right: readonly number[]): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.length === 0 && right.length > 0) return -1;
  if (right.length === 0 && left.length > 0) return 1;
  return 0;
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

async function firstVisibleComposer(page: Page): Promise<Locator | null> {
  const exact = await firstVisible(
    page,
    CHATGPT_SELECTORS.composer.slice(0, 2),
    VISIBLE_SELECTOR_TIMEOUT_MS,
  );
  if (exact !== null) return exact;
  return await firstVisible(
    page,
    CHATGPT_SELECTORS.composer.slice(2),
    VISIBLE_SELECTOR_TIMEOUT_MS,
  );
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

async function readExactTextCandidates(locator: Locator): Promise<readonly string[]> {
  return await locator
    .evaluate(
      (element) => {
        const values: string[] = [];
        if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
          values.push(element.value);
        }
        if (element instanceof HTMLElement) {
          values.push(element.innerText, element.textContent ?? '');
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
  composer: Locator,
  expected: string,
): Promise<boolean> {
  const normalizedExpected = normalizeLineEndings(expected);
  const values = await readExactTextCandidates(composer);
  return values.some((value) => normalizeLineEndings(value) === normalizedExpected);
}

async function messageHasExactPrompt(message: Locator, expected: string): Promise<boolean> {
  const normalizedExpected = normalizeLineEndings(expected);
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
}

async function writeExactComposerValue(
  page: Page,
  composer: Locator,
  expected: string,
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
    if (await waitForComposerValue(page, composer, expected)) {
      return true;
    }
  }
  return await waitForComposerValue(page, composer, expected);
}

async function clearComposerValue(page: Page, composer: Locator): Promise<boolean> {
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
  composer: Locator,
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
  composer: Locator,
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

function acknowledgementHydrationGraceMs(acknowledgementTimeoutMs: number): number {
  return Math.min(30_000, Math.max(500, acknowledgementTimeoutMs));
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

