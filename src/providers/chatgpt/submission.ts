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
      await navigateProviderPage({
        page: this.#page,
        provider: this.provider,
        pageKey: this.pageKey,
        url: this.#initialUrl,
        timeoutMs: 30_000,
      });
      this.#registry.refreshPage(this.pageKey);
    } else {
      await waitForProviderPageReady({
        page: this.#page,
        provider: this.provider,
        pageKey: this.pageKey,
      });
    }
    this.#requireExactPage();
    await assertNoHumanVerification({
      page: this.#page,
      provider: this.provider,
      pageKey: this.pageKey,
    });
    await assertChatGptAuthenticated(this.#page);
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

    let modelSelection: ModelSelectionMode | null = null;
    if (this.#request.model !== null) {
      modelSelection = await this.#selectModel(this.#request.model, this.#request.effort ?? null);
    }
    if (
      this.#request.effort !== undefined &&
      this.#request.effort !== null &&
      normalizeLabel(this.#request.effort) !== '' &&
      modelSelection !== 'intelligence-pro' &&
      modelSelection !== 'intelligence-thinking'
    ) {
      const selectedByIntelligence = await selectIntelligenceEffort(
        this.#page,
        this.#request.effort,
      );
      if (!selectedByIntelligence) {
        await selectNamedMode(
          this.#page,
          CHATGPT_SELECTORS.effortSwitcher,
          this.#request.effort,
          'effort',
        );
      }
    }

    const composer = await firstEditableComposer(this.#page);
    if (composer === null) {
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

    const sendButton = await waitForEnabledSendButton(this.#page, composer, 60_000);
    if (sendButton === null) {
      const visibleControl = await firstVisible(this.#page, CHATGPT_SELECTORS.sendButton);
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        'The exact ChatGPT send control is unavailable',
        { details: { sendControl: visibleControl === null ? 'absent' : 'disabled' } },
      );
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

  async #selectModel(requestedModel: string, requestedEffort: string | null): Promise<ModelSelectionMode> {
    if (normalizeModelIdentity(requestedModel) === 'thinking') {
      const intelligenceSwitcher = await firstVisible(
        this.#page,
        CHATGPT_SELECTORS.intelligenceSwitcher,
      );
      if (intelligenceSwitcher !== null) {
        const effort = requestedEffort?.trim() || 'standard';
        if (!(await selectIntelligenceEffort(this.#page, effort))) {
          throw new ProviderSubmissionError(
            'provider.mode-unavailable',
            'Requested ChatGPT effort is unavailable: ' + effort,
          );
        }
        return 'intelligence-thinking';
      }
    }
    if (isIntelligenceProRequest(requestedModel)) {
      const intelligenceSwitcher = await firstVisible(
        this.#page,
        CHATGPT_SELECTORS.intelligenceSwitcher,
      );
      if (intelligenceSwitcher !== null) {
        await selectIntelligencePro(this.#page, intelligenceSwitcher, requestedModel);
        return 'intelligence-pro';
      }
    }

    const switcher = await firstVisible(this.#page, CHATGPT_SELECTORS.modelSwitcher);
    if (switcher === null) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        'Requested model is unavailable: ' + requestedModel,
      );
    }
    if (
      (await switcher.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
      (await switcher.isDisabled().catch(() => false))
    ) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        'Requested model is unavailable: ' + requestedModel,
      );
    }
    await switcher.click({ timeout: 5_000 });
    const discovered = await discoverModelOptions(this.#page);
    const selected = resolveRequestedModel(discovered, requestedModel);
    if (selected === null) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        'Requested model is absent or disabled: ' + requestedModel,
      );
    }
    await selected.locator.click({ timeout: 5_000 });
    if (!(await waitForModelLabel(this.#page, switcher, selected.label))) {
      throw new ProviderSubmissionError(
        'provider.model-unavailable',
        'Requested model selection was not acknowledged: ' + selected.label,
      );
    }
    return 'legacy';
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

type ModelSelectionMode = 'legacy' | 'intelligence-pro' | 'intelligence-thinking';

interface IntelligencePreset {
  readonly title: string;
  readonly selectedDisplayTitle: string | null;
  readonly selectedDisplayVersion: string | null;
  readonly modelSlug: string;
  readonly lane: string;
  readonly presetType: string;
  readonly thinkingEffort: string | null;
}

interface IntelligenceVersion {
  readonly id: string;
  readonly displayText: string;
  readonly displayTextForIntelligence: string;
  readonly enabled: boolean;
  readonly presets: readonly IntelligencePreset[];
}

interface IntelligenceCapabilities {
  readonly versions: readonly IntelligenceVersion[];
}

interface IntelligenceTarget {
  readonly version: IntelligenceVersion;
  readonly preset: IntelligencePreset;
  readonly presetIndex: number;
}

async function selectIntelligencePro(
  page: Page,
  switcher: Locator,
  requestedModel: string,
): Promise<void> {
  const capabilities = await readIntelligenceCapabilities(page);
  const targets =
    capabilities === null ? [] : intelligenceProTargets(capabilities, requestedModel);
  const preferredVersions = targets.map((target) => target.version.displayText);
  const liveResult = await selectLiveIntelligencePro(
    page,
    switcher,
    requestedModel,
    preferredVersions,
  );
  if (liveResult.selected) return;
  throw new ProviderSubmissionError(
    'provider.model-unavailable',
    'No available ChatGPT Pro preset could satisfy: ' + requestedModel,
    { details: { attempted: ['live:' + liveResult.reason] } },
  );
}

async function selectIntelligenceEffort(page: Page, requestedEffort: string): Promise<boolean> {
  const switcher = await firstVisible(page, CHATGPT_SELECTORS.intelligenceSwitcher);
  if (switcher === null) return false;
  const effort = intelligenceThinkingEffort(requestedEffort);
  if (effort === null) return false;
  const capabilities = await readIntelligenceCapabilities(page);
  const targets =
    capabilities === null ? [] : intelligenceEffortTargets(capabilities, effort);
  const attempted: string[] = [];
  for (const target of targets) {
    const result = await selectIntelligenceTarget(page, switcher, target);
    attempted.push(target.version.id + ':' + String(target.presetIndex) + ':' + result.reason);
    if (result.selected) return true;
  }
  const liveResult = await selectLiveIntelligenceEffort(page, switcher, effort);
  attempted.push('live:' + liveResult.reason);
  if (liveResult.selected) return true;
  throw new ProviderSubmissionError(
    'provider.mode-unavailable',
    'Requested ChatGPT effort is unavailable: ' + requestedEffort,
    { details: { attempted } },
  );
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

async function readIntelligenceCapabilities(page: Page): Promise<IntelligenceCapabilities | null> {
  return await page
    .evaluate(async () => {
      let response = await fetch('/backend-api/models', { credentials: 'include' }).catch(() => null);
      if (response === null || !response.ok) {
        const auth = await fetch('/api/auth/session', { credentials: 'include' }).catch(() => null);
        if (auth === null || !auth.ok) return null;
        const session = (await auth.json().catch(() => null)) as { accessToken?: unknown } | null;
        const accessToken =
          session !== null && typeof session.accessToken === 'string' ? session.accessToken : null;
        if (accessToken === null || accessToken.length < 8) return null;
        response = await fetch('/backend-api/models', {
          credentials: 'include',
          headers: { Authorization: 'Bearer ' + accessToken },
        }).catch(() => null);
      }
      if (response === null || !response.ok) return null;
      const body = (await response.json().catch(() => null)) as {
        versions?: unknown;
      } | null;
      if (body === null || !Array.isArray(body.versions)) return null;
      const versions = body.versions.flatMap((rawVersion) => {
        if (rawVersion === null || typeof rawVersion !== 'object') return [];
        const record = rawVersion as Record<string, unknown>;
        const id = typeof record.id === 'string' ? record.id : '';
        const rawPresets = Array.isArray(record.intelligence_presets)
          ? record.intelligence_presets
          : [];
        if (id === '' || rawPresets.length === 0) return [];
        const presets = rawPresets.flatMap((rawPreset) => {
          if (rawPreset === null || typeof rawPreset !== 'object') return [];
          const preset = rawPreset as Record<string, unknown>;
          const modelSlug = typeof preset.model_slug === 'string' ? preset.model_slug : '';
          const lane = typeof preset.lane === 'string' ? preset.lane : '';
          if (modelSlug === '' || lane === '') return [];
          return [
            {
              title: typeof preset.title === 'string' ? preset.title : '',
              selectedDisplayTitle:
                typeof preset.selected_display_title === 'string'
                  ? preset.selected_display_title
                  : null,
              selectedDisplayVersion:
                typeof preset.selected_display_version === 'string'
                  ? preset.selected_display_version
                  : null,
              modelSlug,
              lane,
              presetType:
                typeof preset.preset_type === 'string' ? preset.preset_type : 'available',
              thinkingEffort:
                typeof preset.thinking_effort === 'string' ? preset.thinking_effort : null,
            },
          ];
        });
        return [
          {
            id,
            displayText:
              typeof record.display_text === 'string' ? record.display_text : id,
            displayTextForIntelligence:
              typeof record.display_text_for_intelligence === 'string'
                ? record.display_text_for_intelligence
                : typeof record.display_text === 'string'
                  ? record.display_text
                  : id,
            enabled: record.enabled !== false,
            presets,
          },
        ];
      });
      return { versions };
    })
    .catch(() => null);
}

function intelligenceProTargets(
  capabilities: IntelligenceCapabilities,
  requestedModel: string,
): readonly IntelligenceTarget[] {
  const request = normalizeModelIdentity(requestedModel);
  const targets: IntelligenceTarget[] = [];
  for (const version of capabilities.versions) {
    if (!version.enabled) continue;
    version.presets.forEach((preset, presetIndex) => {
      if (preset.lane !== 'pro' || preset.presetType !== 'available') return;
      if (request !== 'pro') {
        const identities = [
          preset.modelSlug,
          (preset.selectedDisplayVersion ?? version.displayText) + ' Pro',
          'GPT-' + (preset.selectedDisplayVersion ?? version.displayText) + ' Pro',
        ].map(normalizeModelIdentity);
        if (!identities.some((identity) => identity === request)) return;
      }
      targets.push({ version, preset, presetIndex });
    });
  }
  return targets.sort(compareIntelligenceTargets);
}

function intelligenceEffortTargets(
  capabilities: IntelligenceCapabilities,
  effort: string,
): readonly IntelligenceTarget[] {
  const targets: IntelligenceTarget[] = [];
  for (const version of capabilities.versions) {
    if (!version.enabled) continue;
    version.presets.forEach((preset, presetIndex) => {
      if (
        preset.lane === 'thinking' &&
        preset.presetType === 'available' &&
        preset.thinkingEffort === effort
      ) {
        targets.push({ version, preset, presetIndex });
      }
    });
  }
  return targets.sort(compareIntelligenceTargets);
}

function compareIntelligenceTargets(left: IntelligenceTarget, right: IntelligenceTarget): number {
  const leftVersion =
    left.preset.selectedDisplayVersion ?? left.version.id.replace(/[^0-9.]/g, '');
  const rightVersion =
    right.preset.selectedDisplayVersion ?? right.version.id.replace(/[^0-9.]/g, '');
  return compareVersionParts(modelVersionParts(rightVersion), modelVersionParts(leftVersion));
}

async function selectIntelligenceTarget(
  page: Page,
  switcher: Locator,
  target: IntelligenceTarget,
): Promise<{ readonly selected: boolean; readonly reason: string }> {
  if (!(await ensureIntelligencePickerOpen(page, switcher))) {
    return { selected: false, reason: 'picker-not-open' };
  }
  if (!(await selectIntelligenceVersion(page, target.version))) {
    return { selected: false, reason: 'version-not-selected' };
  }
  if (!(await ensureIntelligencePickerOpen(page, switcher))) {
    return { selected: false, reason: 'picker-reopen-failed' };
  }
  return await selectLiveIntelligenceSliderIndex(page, target.presetIndex);
}

async function selectLiveIntelligencePro(
  page: Page,
  switcher: Locator,
  requestedModel: string,
  preferredVersions: readonly string[] = [],
): Promise<{ readonly selected: boolean; readonly reason: string }> {
  if (!(await ensureIntelligencePickerOpen(page, switcher))) {
    return { selected: false, reason: 'picker-not-open' };
  }

  const isFamilyRequest = normalizeModelIdentity(requestedModel) === 'pro';
  const visibleVersions = isFamilyRequest
    ? await readLiveIntelligenceVersionLabels(page)
    : [requestedModel];
  const versions: (string | null)[] = [
    ...visibleVersions,
    ...preferredVersions,
  ].filter((version, index, all) =>
    all.findIndex((candidate) => normalizeLabel(candidate) === normalizeLabel(version)) === index,
  );
  if (versions.length === 0) versions.push(null);

  let lastReason = 'no-semantic-model-acknowledgement';
  for (const version of versions) {
    if (version !== null) {
      const versionResult = await selectLiveIntelligenceVersion(page, version);
      if (!versionResult.selected) {
        lastReason = 'version-' + versionResult.reason;
        continue;
      }
      if (!(await ensureIntelligencePickerOpen(page, switcher))) {
        lastReason = 'picker-reopen-failed';
        continue;
      }
    }

    const result = await selectLiveIntelligenceProAtCurrentVersion(page);
    if (result.selected) return result;
    lastReason = result.reason;
  }
  return { selected: false, reason: lastReason };
}

async function readLiveIntelligenceVersionLabels(page: Page): Promise<string[]> {
  const options = page
    .locator(CHATGPT_SELECTORS.intelligenceContent)
    .filter({ visible: true })
    .locator('[role="menuitemradio"]');
  const count = await options.count().catch(() => 0);
  const labels: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (
      (await option.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
      (await option.isDisabled().catch(() => false))
    ) {
      continue;
    }
    const label = ((await option.textContent().catch(() => null)) ?? '').trim();
    if (label !== '' && !labels.some((existing) => normalizeLabel(existing) === normalizeLabel(label))) {
      labels.push(label);
    }
  }
  return labels;
}

async function selectLiveIntelligenceProAtCurrentVersion(
  page: Page,
): Promise<{ readonly selected: boolean; readonly reason: string }> {
  const state = await readLiveIntelligenceSlider(page);
  if (state === null) return { selected: false, reason: 'slider-not-visible' };
  if (state.maximum - state.minimum > 100) {
    return { selected: false, reason: 'unsupported-slider-range' };
  }

  let current = state.current;
  if (await waitForLiveModelLabel(page, 'Pro')) {
    return { selected: true, reason: 'selected-live-pro' };
  }

  while (current > state.minimum) {
    await state.control.press('ArrowLeft');
    await page.waitForTimeout(50);
    const next = Number(await state.slider.getAttribute('aria-valuenow').catch(() => null));
    if (!Number.isInteger(next) || next >= current) break;
    current = next;
  }

  for (;;) {
    if (await waitForLiveModelLabel(page, 'Pro')) {
      return { selected: true, reason: 'selected-live-pro' };
    }
    if (current >= state.maximum) break;
    await state.control.press('ArrowRight');
    await page.waitForTimeout(50);
    const next = Number(await state.slider.getAttribute('aria-valuenow').catch(() => null));
    if (!Number.isInteger(next) || next <= current) break;
    current = next;
  }
  return { selected: false, reason: 'no-semantic-model-acknowledgement' };
}

async function waitForLiveModelLabel(page: Page, requestedModel: string): Promise<boolean> {
  const deadline = Date.now() + 150;
  do {
    const menu = page.locator(CHATGPT_SELECTORS.intelligenceContent).filter({ visible: true }).first();
    const slider = menu.locator('[role="slider"][aria-valuemin][aria-valuemax][aria-valuenow]').first();
    const labels = await slider.evaluate((element) => {
      const control = element.closest('[role="menuitem"][aria-describedby]');
      const descriptions = (control?.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter((node): node is HTMLElement => node instanceof HTMLElement && control?.contains(node) === true)
        .map((node) => node.textContent ?? '');
      const status = Array.from(element.closest('[role="menu"]')?.querySelectorAll('[role="status"]') ?? []).filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return [
        element.getAttribute('aria-valuetext') ?? '',
        ...descriptions,
        status.length === 1 ? status[0]?.textContent ?? '' : '',
      ];
    }).catch((): string[] => []);
    if (labels.some((label) => modelLabelMatches(label, requestedModel))) return true;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  return false;
}

async function selectLiveIntelligenceVersion(
  page: Page,
  requestedModel: string,
): Promise<{ readonly selected: boolean; readonly reason: string }> {
  const requestedVersion = modelVersionParts(requestedModel);
  const requestedLabel = normalizeLabel(requestedModel);

  const advanced = page.locator(CHATGPT_SELECTORS.intelligenceContent).filter({ visible: true }).first();
  const options = advanced.locator('[role="menuitemradio"]');
  const findTarget = async (): Promise<Locator | null> => {
    const count = await options.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const label = ((await option.textContent().catch(() => null)) ?? '').trim();
      const parts = modelVersionParts(label);
      if (
        (requestedVersion.length > 0 &&
          parts.length > 0 &&
          compareVersionParts(parts, requestedVersion) === 0) ||
        (requestedVersion.length === 0 && normalizeLabel(label) === requestedLabel)
      ) {
        return option;
      }
    }
    return null;
  };

  let target = await findTarget();
  if (target !== null && (await target.getAttribute('aria-checked').catch(() => null)) === 'true') {
    return { selected: true, reason: 'already-selected' };
  }

  const content = page.locator(CHATGPT_SELECTORS.intelligenceContent).filter({ visible: true }).first();
  const opener = content.locator('[role="menuitem"]').first();
  if (!(await opener.isVisible().catch(() => false))) {
    return { selected: false, reason: 'version-opener-not-visible' };
  }
  await opener.click({ timeout: 5_000 }).catch(() => undefined);
  target = await findTarget();
  if (target === null || !(await waitForVisible(target, 2_000))) {
    return { selected: false, reason: 'requested-version-not-visible' };
  }
  await target.click({ timeout: 5_000 });
  if (!(await waitForAttribute(target, 'aria-checked', 'true', 2_000))) {
    return { selected: false, reason: 'version-not-acknowledged' };
  }
  return { selected: true, reason: 'selected' };
}

async function selectLiveIntelligenceEffort(
  page: Page,
  switcher: Locator,
  effort: string,
): Promise<{ readonly selected: boolean; readonly reason: string }> {
  if (!(await ensureIntelligencePickerOpen(page, switcher))) {
    return { selected: false, reason: 'picker-not-open' };
  }
  const state = await readLiveIntelligenceSlider(page);
  if (state === null || state.maximum - state.minimum > 100) {
    return { selected: false, reason: 'unsupported-slider-shape' };
  }
  const targetIndex =
    effort === 'standard' ? 1 : effort === 'extended' ? 2 : effort === 'max' ? 3 : null;
  if (targetIndex === null) {
    return { selected: false, reason: 'unsupported-effort' };
  }
  const result = await selectLiveIntelligenceSliderIndex(page, targetIndex);
  return result.selected
    ? { selected: true, reason: 'selected-live-effort-' + String(targetIndex) }
    : result;
}

interface LiveIntelligenceSliderState {
  readonly slider: Locator;
  readonly control: Locator;
  readonly minimum: number;
  readonly maximum: number;
  readonly current: number;
}

async function readLiveIntelligenceSlider(
  page: Page,
): Promise<LiveIntelligenceSliderState | null> {
  const sliders = page
    .locator(CHATGPT_SELECTORS.intelligenceContent)
    .filter({ visible: true })
    .locator('[role="slider"][aria-valuemin][aria-valuemax][aria-valuenow]')
    .filter({ visible: true });
  if ((await sliders.count().catch(() => 0)) !== 1) return null;
  const slider = sliders.first();
  const minimum = Number(await slider.getAttribute('aria-valuemin').catch(() => null));
  const maximum = Number(await slider.getAttribute('aria-valuemax').catch(() => null));
  const current = Number(await slider.getAttribute('aria-valuenow').catch(() => null));
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(current) ||
    !Number.isInteger(maximum) ||
    minimum < 0 ||
    current < minimum ||
    current > maximum ||
    maximum < minimum
  ) {
    return null;
  }

  const ancestorControl = slider.locator('xpath=ancestor::*[@role="menuitem"][1]').first();
  const control = (await ancestorControl.isVisible().catch(() => false)) ? ancestorControl : slider;
  return { slider, control, minimum, maximum, current };
}

async function selectLiveIntelligenceSliderIndex(
  page: Page,
  targetIndex: number,
): Promise<{ readonly selected: boolean; readonly reason: string }> {
  const state = await readLiveIntelligenceSlider(page);
  if (state === null) {
    return { selected: false, reason: 'slider-not-visible-or-invalid' };
  }
  if (targetIndex < state.minimum || targetIndex > state.maximum) {
    return {
      selected: false,
      reason: 'preset-index-out-of-range-' + String(state.maximum - state.minimum + 1),
    };
  }

  let current = state.current;
  const key = targetIndex > current ? 'ArrowRight' : 'ArrowLeft';
  const maxAttempts = state.maximum - state.minimum + 2;
  for (let attempts = 0; attempts < maxAttempts && current !== targetIndex; attempts += 1) {
    await state.control.press(key);
    await page.waitForTimeout(50);
    current = Number(await state.slider.getAttribute('aria-valuenow').catch(() => null));
  }
  return {
    selected: current === targetIndex,
    reason: current === targetIndex ? 'selected' : 'slider-stuck-' + String(current),
  };
}

async function ensureIntelligencePickerOpen(page: Page, switcher: Locator): Promise<boolean> {
  const content = page.locator(CHATGPT_SELECTORS.intelligenceContent).filter({ visible: true }).first();
  if (await content.isVisible().catch(() => false)) return true;
  await switcher.click({ timeout: 5_000 }).catch(() => undefined);
  return await waitForVisible(content, 2_000);
}

async function selectIntelligenceVersion(
  page: Page,
  version: IntelligenceVersion,
): Promise<boolean> {
  const advanced = page.locator(CHATGPT_SELECTORS.intelligenceContent).filter({ visible: true }).first();
  const options = advanced.locator('[role="menuitemradio"]');
  let target = await matchingVersionOption(options, version);
  if (target !== null && (await target.getAttribute('aria-checked').catch(() => null)) === 'true') {
    return true;
  }

  const content = page.locator(CHATGPT_SELECTORS.intelligenceContent).filter({ visible: true }).first();
  const opener = content.locator('[role="menuitem"]').first();
  if (!(await opener.isVisible().catch(() => false))) return false;
  await opener.click({ timeout: 5_000 });
  target = await matchingVersionOption(options, version);
  if (target === null || !(await waitForVisible(target, 2_000))) return false;
  await target.click({ timeout: 5_000 });
  return await waitForAttribute(target, 'aria-checked', 'true', 2_000);
}

async function matchingVersionOption(
  options: Locator,
  version: IntelligenceVersion,
): Promise<Locator | null> {
  const count = await options.count().catch(() => 0);
  const labels = [
    normalizeLabel(version.displayTextForIntelligence),
    normalizeLabel(version.displayText),
  ].filter((label) => label !== '');
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const id = await option.getAttribute('data-version-id').catch(() => null);
    if (id === version.id) return option;
    const text = normalizeLabel((await option.textContent().catch(() => null)) ?? '');
    if (labels.some((label) => text === label || modelLabelMatches(text, label))) return option;
  }
  return null;
}

async function waitForAttribute(
  locator: Locator,
  attribute: string,
  expected: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await locator.getAttribute(attribute).catch(() => null)) === expected) return true;
    await locator.page().waitForTimeout(25);
  } while (Date.now() < deadline);
  return false;
}

async function waitForVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await locator.isVisible().catch(() => false)) return true;
    await locator.page().waitForTimeout(25);
  } while (Date.now() < deadline);
  return false;
}

async function waitForEnabledSendButton(page: Page, composer: Locator, timeoutMs: number): Promise<Locator | null> {
  const form = composer.locator('xpath=ancestor::form[1]');
  const buttons = ((await form.count().catch(() => 0)) === 1
    ? form.locator(CHATGPT_SELECTORS.sendButton.join(', '))
    : page.locator('[data-testid="send-button"]'))
    .filter({ visible: true });
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await buttons.count().catch(() => 0)) === 1) {
      const button = buttons.first();
      if (await button.isEnabled().catch(() => false)) return button;
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return null;
}

function isIntelligenceProRequest(value: string): boolean {
  const normalized = normalizeModelIdentity(value);
  return normalized === 'pro' || (normalized.startsWith('gpt ') && normalized.endsWith(' pro'));
}

function normalizeModelIdentity(value: string): string {
  return normalizeLabel(value).replaceAll('-', ' ');
}

function intelligenceThinkingEffort(value: string): string | null {
  const normalized = normalizeLabel(value).replaceAll('_', '-');
  switch (normalized) {
    case 'medium':
    case 'standard':
      return 'standard';
    case 'high':
    case 'extended':
      return 'extended';
    case 'extra-high':
    case 'extra high':
    case 'very-high':
    case 'very high':
    case 'max':
    case 'maximum':
      return 'max';
    default:
      return null;
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
    if (label === 'work' || modelLabelMatches(label, 'work')) {
      throw new ProviderSubmissionError(
        'capability.unsupported',
        'The active ChatGPT composer is Work; SessionPlane supports Chat only',
      );
    }
    if (label === 'chat' || label === 'normal' || modelLabelMatches(label, 'chat')) {
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

async function firstEditableComposer(page: Page): Promise<Locator | null> {
  const candidates = page.locator(CHATGPT_SELECTORS.composer.join(', ')).filter({ visible: true });
  const deadline = Date.now() + COMPOSER_READY_TIMEOUT_MS;
  do {
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isEditable().catch(() => false)) return candidate;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(VISIBLE_SELECTOR_POLL_MS, remaining));
  } while (Date.now() < deadline);
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
  composer: Locator,
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
  return value === undefined || /\s|[()[\]{}:;,!.?·•]/.test(value);
}

async function waitForModelLabel(
  page: Page,
  switcher: Locator,
  requestedModel: string,
): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  do {
    const label = (await switcher.textContent().catch(() => null)) ?? '';
    if (modelLabelMatches(label, requestedModel)) return true;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  return false;
}
