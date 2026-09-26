import { createHash } from 'node:crypto';

import type { Locator, Page, Request, Response, WebSocket } from 'playwright-core';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import {
  isProviderUrl,
  parseProviderConversationId,
} from '../browser/page-binding.ts';
import { PageRegistryError, type PageRegistry } from '../browser/page-registry.ts';
import {
  ProviderSubmissionError,
  type ProviderAdapter,
  type ProviderAcknowledgementRecoveryRequest,
  type ProviderArtifactCandidate,
  type ProviderArtifactDownload,
  type ProviderArtifactRequest,
  type ProviderAttachment,
  type ProviderName,
  type ProviderObservationEvidence,
  type ProviderObservationRequest,
  type ProviderObservationSource,
  type ProviderRecoveryRequest,
  type ProviderRecoveryResult,
  type ProviderStopOperation,
  type ProviderStopRequest,
  type ProviderSubmission,
  type ProviderSubmissionAcknowledgement,
  type ProviderSubmissionRequest,
  type ProviderWakeReason,
} from './provider-adapter.ts';
import {
  assertNoHumanVerification,
  navigateProviderPage,
  waitForProviderPageReady,
} from './human-verification.ts';

export interface ProviderDomSelectors {
  readonly composer: readonly string[];
  readonly sendButton: readonly string[];
  readonly authenticationRequired?: readonly string[];
  readonly userMessages: readonly string[];
  readonly userTextLines?: readonly string[];
  readonly assistantMessages: readonly string[];
  readonly assistantText: readonly string[];
  readonly completion: readonly string[];
  readonly stopControls: readonly string[];
  readonly modelSwitcher: readonly string[];
  readonly modelOptions: string;
  readonly fileInputs: readonly string[];
  readonly uploadTriggers: readonly string[];
  readonly uploadMenuItems: readonly string[];
  readonly attachmentEvidence: readonly string[];
  readonly artifactLinks: readonly string[];
}

export interface DomProviderAdapterOptions {
  readonly provider: ProviderName;
  readonly browserOwner: BrowserOwner;
  readonly pageRegistry: PageRegistry;
  readonly loginUrl: string;
  readonly acknowledgementTimeoutMs: number;
  readonly selectors: ProviderDomSelectors;
}

export class DomProviderAdapter implements ProviderAdapter {
  readonly provider: ProviderName;
  readonly #browserOwner: BrowserOwner;
  readonly #pageRegistry: PageRegistry;
  readonly #loginUrl: string;
  readonly #acknowledgementTimeoutMs: number;
  readonly #selectors: ProviderDomSelectors;

  constructor(options: DomProviderAdapterOptions) {
    this.provider = options.provider;
    this.#browserOwner = options.browserOwner;
    this.#pageRegistry = options.pageRegistry;
    this.#loginUrl = options.loginUrl;
    this.#acknowledgementTimeoutMs = options.acknowledgementTimeoutMs;
    this.#selectors = options.selectors;
  }

  async openSubmission(request: ProviderSubmissionRequest): Promise<ProviderSubmission> {
    try {
      let pageKey = request.session.pageKey;
      let initialUrl: string | undefined;
      if (pageKey !== null && shouldReplaceMissingUnsubmittedPage(this.#pageRegistry, request)) {
        pageKey = null;
      }
      if (pageKey === null) {
        const created = await this.#browserOwner.createPage();
        pageKey = created.binding.pageKey;
        this.#pageRegistry.reservePage(pageKey, {
          sessionId: request.session.sessionId,
          generation: request.generation,
          conversationId: null,
        });
        initialUrl = this.#loginUrl;
      } else {
        this.#pageRegistry.reservePage(pageKey, {
          sessionId: request.session.sessionId,
          generation: request.generation,
          conversationId: request.session.conversationId,
        });
      }
      const page = this.#pageRegistry.requireSessionPage(pageKey, {
        sessionId: request.session.sessionId,
        generation: request.generation,
        conversationId: request.session.conversationId,
      });
      return new DomProviderSubmission({
        provider: this.provider,
        page,
        pageKey,
        pageRegistry: this.#pageRegistry,
        request,
        selectors: this.#selectors,
        acknowledgementTimeoutMs: this.#acknowledgementTimeoutMs,
        ...(initialUrl === undefined ? {} : { initialUrl }),
      });
    } catch (error) {
      if (error instanceof ProviderSubmissionError) throw error;
      if (error instanceof PageRegistryError) {
        throw new ProviderSubmissionError(error.errorCode, error.message, { cause: error });
      }
      throw new ProviderSubmissionError(
        'browser.unavailable',
        `Failed to open exact ${this.provider} Page`,
        { cause: error },
      );
    }
  }

  async recoverAcknowledgement(
    request: ProviderAcknowledgementRecoveryRequest,
  ): Promise<ProviderSubmissionAcknowledgement | null> {
    const conversationId = request.session.conversationId;
    if (conversationId === null) return null;
    let page: Page;
    try {
      page = this.#requireOwnedPage(request.session, request.generation);
    } catch {
      return null;
    }
    if (parseProviderConversationId(page.url()) !== conversationId) return null;
    const turns = await readTurns(page, this.#selectors, 'user');
    const matches = new Map<string, DomTurn>();
    for (const turn of turns) {
      if (normalizeText(turn.text) !== normalizeText(request.prompt)) continue;
      matches.set(turn.identityKey, turn);
    }
    if (matches.size !== 1) return null;
    const turn = matches.values().next().value;
    if (turn === undefined) return null;
    return {
      conversationId,
      submittedUserMessageId: turn.messageId,
      submittedUserTurnId: turn.turnId,
    };
  }

  async openObservation(request: ProviderObservationRequest): Promise<ProviderObservationSource> {
    const page = this.#requireOwnedPage(request.session, request.generation);
    return new DomProviderObservationSource({
      provider: this.provider,
      page,
      pageKey: request.session.pageKey as string,
      pageRegistry: this.#pageRegistry,
      request,
      selectors: this.#selectors,
    });
  }

  async recover(_request: ProviderRecoveryRequest): Promise<ProviderRecoveryResult> {
    return {
      kind: 'unavailable',
      observationTransport: 'unavailable',
      responseMessageId: null,
      answerText: null,
      reason: `${this.provider}-backend-recovery-unavailable`,
      retryAfterMs: null,
      nextCheckAt: null,
    };
  }

  async openStop(request: ProviderStopRequest): Promise<ProviderStopOperation> {
    const page = this.#requireOwnedPage(request.session, request.generation);
    return new DomProviderStopOperation({
      provider: this.provider,
      page,
      pageKey: request.session.pageKey as string,
      pageRegistry: this.#pageRegistry,
      request,
      selectors: this.#selectors,
    });
  }

  async discoverArtifacts(
    request: ProviderArtifactRequest,
  ): Promise<readonly ProviderArtifactCandidate[]> {
    const page = this.#requireOwnedPage(request.session, request.bindingGeneration ?? request.generation);
    const selector = this.#selectors.artifactLinks.join(', ');
    if (selector.length === 0) return [];
    const turn = (await readTurns(page, this.#selectors, 'assistant', true)).find((turn) => turn.messageId === request.session.responseMessageId);
    if (turn === undefined) throw new ProviderSubmissionError('provider.artifacts-unavailable', 'Exact answer is not present for file discovery');
    const rows = turn.artifacts ?? [];
    const candidates = new Map<string, ProviderArtifactCandidate>();
    for (const row of rows) {
      if (row.href.length === 0) continue;
      const providerArtifactId = createHash('sha256')
        .update(`${this.provider}\u0000${row.href}\u0000${row.name}`)
        .digest('hex');
      candidates.set(providerArtifactId, {
        providerArtifactId,
        name: sanitizeArtifactName(row.name),
        sourceUrl: row.href,
        mediaType: row.mediaType,
      });
    }
    return [...candidates.values()];
  }

  async downloadArtifact(
    request: ProviderArtifactRequest,
    candidate: ProviderArtifactCandidate,
  ): Promise<ProviderArtifactDownload> {
    const page = this.#requireOwnedPage(request.session, request.bindingGeneration ?? request.generation);
    const expectedId = createHash('sha256')
      .update(`${this.provider}\u0000${candidate.sourceUrl}\u0000${candidate.name}`)
      .digest('hex');
    if (expectedId !== candidate.providerArtifactId) {
      throw new ProviderSubmissionError(
        'input.invalid',
        'Provider artifact descriptor hash did not match its source identity',
      );
    }
    let bytes: Uint8Array;
    if (candidate.sourceUrl.startsWith('blob:') || candidate.sourceUrl.startsWith('data:')) {
      const values = await page.evaluate(async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`artifact fetch failed: ${response.status}`);
        return [...new Uint8Array(await response.arrayBuffer())];
      }, candidate.sourceUrl);
      bytes = Uint8Array.from(values);
    } else {
      const response = await page.context().request.get(candidate.sourceUrl, {
        failOnStatusCode: false,
        timeout: 30_000,
      });
      try {
        if (!response.ok()) {
          throw new ProviderSubmissionError(
            'browser.unavailable',
            `Artifact download failed with HTTP ${response.status()}`,
          );
        }
        bytes = new Uint8Array(await response.body());
      } finally {
        await response.dispose();
      }
    }
    return { candidate, bytes };
  }

  #requireOwnedPage(
    session: ProviderObservationRequest['session'],
    generation: number,
  ): ReturnType<PageRegistry['requireOwnedPage']> {
    if (session.pageKey === null || session.conversationId === null) {
      throw new ProviderSubmissionError(
        'session.page-identity-unverified',
        `Exact ${this.provider} Page identity is incomplete`,
        { promptSubmitted: session.promptSubmitted },
      );
    }
    try {
      return this.#pageRegistry.requireOwnedPage(session.pageKey, {
        sessionId: session.sessionId,
        generation,
        conversationId: session.conversationId,
      });
    } catch (error) {
      if (error instanceof PageRegistryError) {
        throw new ProviderSubmissionError(error.errorCode, error.message, {
          promptSubmitted: session.promptSubmitted,
          cause: error,
        });
      }
      throw error;
    }
  }
}

function shouldReplaceMissingUnsubmittedPage(
  pageRegistry: PageRegistry,
  request: ProviderSubmissionRequest,
): boolean {
  const pageKey = request.session.pageKey;
  if (
    pageKey === null ||
    request.session.promptSubmitted ||
    request.session.conversationId !== null
  ) {
    return false;
  }
  return !pageRegistry
    .listBindings({ includeClosed: false })
    .some((binding) => binding.pageKey === pageKey);
}

interface DomProviderSubmissionOptions {
  readonly provider: ProviderName;
  readonly page: Page;
  readonly pageKey: string;
  readonly pageRegistry: PageRegistry;
  readonly request: ProviderSubmissionRequest;
  readonly selectors: ProviderDomSelectors;
  readonly acknowledgementTimeoutMs: number;
  readonly initialUrl?: string;
}

class DomProviderSubmission implements ProviderSubmission {
  readonly provider: ProviderName;
  readonly pageKey: string;
  readonly #page: Page;
  readonly #pageRegistry: PageRegistry;
  readonly #request: ProviderSubmissionRequest;
  readonly #selectors: ProviderDomSelectors;
  readonly #acknowledgementTimeoutMs: number;
  readonly #initialUrl: string | null;
  #sendButton: Locator | null = null;
  #baselineUserKeys = new Set<string>();

  constructor(options: DomProviderSubmissionOptions) {
    this.provider = options.provider;
    this.pageKey = options.pageKey;
    this.#page = options.page;
    this.#pageRegistry = options.pageRegistry;
    this.#request = options.request;
    this.#selectors = options.selectors;
    this.#acknowledgementTimeoutMs = options.acknowledgementTimeoutMs;
    this.#initialUrl = options.initialUrl ?? null;
  }

  abandon(): void {
    void this.#page.close().catch(() => undefined);
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
      this.#pageRegistry.refreshPage(this.pageKey);
    } else {
      await waitForProviderPageReady({
        page: this.#page,
        provider: this.provider,
        pageKey: this.pageKey,
      });
    }
    this.#requireExactPage();
    if (!isProviderUrl(this.provider, this.#page.url())) {
      throw new ProviderSubmissionError(
        'session.page-identity-unverified',
        `Page ${this.pageKey} is not a ${this.provider} URL`,
      );
    }
    await assertNoHumanVerification({
      page: this.#page,
      provider: this.provider,
      pageKey: this.pageKey,
    });
    if (
      this.#selectors.authenticationRequired !== undefined &&
      (await anyVisible(this.#page, this.#selectors.authenticationRequired))
    ) {
      throw new ProviderSubmissionError(
        'provider.authentication-required',
        `${this.provider} authentication is required before submission`,
        {
          details: {
            provider: this.provider,
            pageKey: this.pageKey,
            requiresHumanAction: true,
          },
        },
      );
    }
    if (this.#request.model !== null) {
      await selectExactModel(this.#page, this.#selectors, this.#request.model);
    }
    for (const requested of [this.#request.surface, this.#request.effort]) {
      if (requested !== undefined && requested !== null && requested.trim() !== '') {
        await selectNamedMode(this.#page, requested);
      }
    }

    const composer = await firstEditable(this.#page, this.#selectors.composer, 5_000);
    if (composer === null) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        `${this.provider} composer is not editable`,
      );
    }
    this.#baselineUserKeys = new Set(
      (await readTurns(this.#page, this.#selectors, 'user')).map((turn) => turn.identityKey),
    );
    const attachments = this.#request.attachments ?? [];
    if (attachments.length > 0) {
      await uploadAttachments(this.#page, this.#selectors, attachments);
    }
    await composer.fill(this.#request.prompt);
    if (!(await waitForComposerValue(composer, this.#request.prompt, 2_000))) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        `${this.provider} composer value did not match the requested prompt`,
      );
    }
    const sendButton = await firstEnabled(this.#page, this.#selectors.sendButton, 5_000);
    if (sendButton === null) {
      throw new ProviderSubmissionError(
        'provider.composer-unavailable',
        `${this.provider} send control is unavailable`,
      );
    }
    this.#sendButton = sendButton;
    this.#requireExactPage();
  }

  async submitOnce(): Promise<void> {
    if (this.#sendButton === null) {
      throw new ProviderSubmissionError(
        'internal.invariant-violation',
        `${this.provider} submission was not prepared`,
        { promptSubmitted: true },
      );
    }
    this.#requireExactPage();
    await this.#sendButton.click({ timeout: 10_000 });
  }

  async captureAcknowledgement(): Promise<ProviderSubmissionAcknowledgement | null> {
    const deadline = Date.now() + this.#acknowledgementTimeoutMs;
    do {
      const conversationId = parseProviderConversationId(this.#page.url());
      const turns = await readTurns(this.#page, this.#selectors, 'user');
      for (const turn of turns.slice(Math.max(0, turns.length - 12))) {
        if (this.#baselineUserKeys.has(turn.identityKey)) continue;
        if (normalizeText(turn.text) !== normalizeText(this.#request.prompt)) continue;
        if (conversationId === null) continue;
        return {
          conversationId,
          submittedUserMessageId: turn.messageId,
          submittedUserTurnId: turn.turnId,
        };
      }
      await this.#page.waitForTimeout(100);
    } while (Date.now() < deadline);
    return null;
  }

  bindAcknowledgement(acknowledgement: ProviderSubmissionAcknowledgement): void {
    const binding = this.#pageRegistry.bindPage(this.pageKey, {
      sessionId: this.#request.session.sessionId,
      generation: this.#request.generation,
      conversationId: acknowledgement.conversationId,
    });
    if (binding.state !== 'owned') {
      throw new ProviderSubmissionError(
        'session.page-identity-unverified',
        `${this.provider} acknowledgement did not establish exact page ownership`,
        { promptSubmitted: true },
      );
    }
  }

  #requireExactPage(): void {
    this.#pageRegistry.requireSessionPage(this.pageKey, {
      sessionId: this.#request.session.sessionId,
      generation: this.#request.generation,
      conversationId: this.#request.session.conversationId,
    });
  }
}

interface DomProviderObservationSourceOptions {
  readonly provider: ProviderName;
  readonly page: Page;
  readonly pageKey: string;
  readonly pageRegistry: PageRegistry;
  readonly request: ProviderObservationRequest;
  readonly selectors: ProviderDomSelectors;
}

class DomProviderObservationSource implements ProviderObservationSource {
  readonly provider: ProviderName;
  readonly pageKey: string;
  readonly #page: Page;
  readonly #pageRegistry: PageRegistry;
  readonly #request: ProviderObservationRequest;
  readonly #selectors: ProviderDomSelectors;
  readonly #network: GenericNetworkObserver;
  #lastNetworkRevision = 0;
  #closed = false;

  constructor(options: DomProviderObservationSourceOptions) {
    this.provider = options.provider;
    this.pageKey = options.pageKey;
    this.#page = options.page;
    this.#pageRegistry = options.pageRegistry;
    this.#request = options.request;
    this.#selectors = options.selectors;
    this.#network = new GenericNetworkObserver(options.page, options.provider);
  }

  async observe(): Promise<ProviderObservationEvidence> {
    const observedAt = new Date().toISOString();
    const network = this.#network.snapshot(this.#lastNetworkRevision);
    this.#lastNetworkRevision = network.revision;
    if (this.#closed) return this.#unavailable(observedAt, network.activity, 'source-closed');
    try {
      this.#pageRegistry.requireOwnedPage(this.pageKey, {
        sessionId: this.#request.session.sessionId,
        generation: this.#request.generation,
        conversationId: this.#request.session.conversationId ?? '',
      });
      const before = this.#pageRegistry.getBinding(this.pageKey);
      const dom = await observeProviderDom(this.#page, this.#selectors, {
        submittedUserMessageId: this.#request.session.submittedUserMessageId,
        submittedUserTurnId: this.#request.session.submittedUserTurnId,
      });
      const after = this.#pageRegistry.refreshPage(this.pageKey);
      if (
        before.bindingEpoch !== after.bindingEpoch ||
        after.state !== 'owned' ||
        after.sessionId !== this.#request.session.sessionId ||
        after.generation !== this.#request.generation ||
        after.conversationId !== this.#request.session.conversationId
      ) {
        return {
          provider: this.provider,
          pageKey: this.pageKey,
          bindingEpoch: after.bindingEpoch,
          observedAt,
          conversationId: after.conversationId,
          submittedUserFound: false,
          laterUserFound: false,
          candidate: null,
          activity: 'unknown',
          dialogKind: null,
          networkActivity: network.activity,
          observationTransport: 'stale',
          reason: 'page-binding-changed-during-observation',
        };
      }
      return {
        provider: this.provider,
        pageKey: this.pageKey,
        bindingEpoch: after.bindingEpoch,
        observedAt,
        conversationId: after.conversationId,
        submittedUserFound: dom.submittedUserFound,
        laterUserFound: dom.laterUserFound,
        candidate: dom.candidate,
        activity: dom.activity,
        dialogKind: dom.dialogKind,
        networkActivity: network.activity,
        observationTransport: 'fresh',
        reason: dom.reason,
      };
    } catch (error) {
      const binding = this.#pageRegistry.getBinding(this.pageKey);
      return {
        ...this.#unavailable(
          observedAt,
          network.activity,
          error instanceof PageRegistryError ? 'page-identity-unverified' : 'dom-observation-failed',
        ),
        bindingEpoch: binding.bindingEpoch,
        conversationId: binding.conversationId,
        observationTransport: error instanceof PageRegistryError ? 'stale' : 'unavailable',
      };
    }
  }

  async waitForWake(timeoutMs: number): Promise<ProviderWakeReason> {
    if (this.#closed) return 'timer';
    const controller = new AbortController();
    try {
      return await Promise.race([
        waitForDomMutation(this.#page, timeoutMs).catch(() => 'timer' as const),
        this.#network.waitForActivity(this.#lastNetworkRevision, timeoutMs, controller.signal),
      ]);
    } finally {
      controller.abort();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#network.close();
  }

  #unavailable(
    observedAt: string,
    networkActivity: boolean,
    reason: string,
  ): ProviderObservationEvidence {
    const binding = this.#pageRegistry.getBinding(this.pageKey);
    return {
      provider: this.provider,
      pageKey: this.pageKey,
      bindingEpoch: binding.bindingEpoch,
      observedAt,
      conversationId: binding.conversationId,
      submittedUserFound: false,
      laterUserFound: false,
      candidate: null,
      activity: 'unknown',
      dialogKind: null,
      networkActivity,
      observationTransport: 'unavailable',
      reason,
    };
  }
}

class DomProviderStopOperation implements ProviderStopOperation {
  readonly provider: ProviderName;
  readonly pageKey: string;
  readonly #page: Page;
  readonly #pageRegistry: PageRegistry;
  readonly #request: ProviderStopRequest;
  readonly #selectors: ProviderDomSelectors;
  #control: Locator | null = null;

  constructor(options: {
    readonly provider: ProviderName;
    readonly page: Page;
    readonly pageKey: string;
    readonly pageRegistry: PageRegistry;
    readonly request: ProviderStopRequest;
    readonly selectors: ProviderDomSelectors;
  }) {
    this.provider = options.provider;
    this.pageKey = options.pageKey;
    this.#page = options.page;
    this.#pageRegistry = options.pageRegistry;
    this.#request = options.request;
    this.#selectors = options.selectors;
  }

  async prepare(): Promise<boolean> {
    this.#requireExactPage();
    this.#control = await firstVisible(this.#page, this.#selectors.stopControls);
    return this.#control !== null && (await this.#control.isEnabled().catch(() => false));
  }

  async stopOnce(): Promise<void> {
    if (this.#control === null) {
      throw new ProviderSubmissionError(
        'internal.invariant-violation',
        `${this.provider} stop was not prepared`,
        { promptSubmitted: this.#request.session.promptSubmitted },
      );
    }
    this.#requireExactPage();
    await this.#control.click({ timeout: 10_000 });
  }

  #requireExactPage(): void {
    this.#pageRegistry.requireOwnedPage(this.pageKey, {
      sessionId: this.#request.session.sessionId,
      generation: this.#request.generation,
      conversationId: this.#request.session.conversationId ?? '',
    });
  }
}

interface DomTurn {
  readonly role: 'user' | 'assistant';
  readonly index: number;
  readonly text: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly identityKey: string;
  readonly artifacts?: readonly { href: string; name: string; mediaType: string | null }[];
  readonly terminalAttribute: boolean;
  readonly streamingAttribute: boolean;
}

async function readTurns(
  page: Page,
  selectors: ProviderDomSelectors,
  role?: 'user' | 'assistant',
  includeArtifacts = false,
): Promise<readonly DomTurn[]> {
  const raw = await page.evaluate(
    ({ userSelectors, userTextLineSelectors, assistantSelectors, textSelectors, artifactSelector, includeArtifacts }) => {
      const normalize = (value: string | null | undefined): string =>
        (value ?? '').replaceAll(/\s+/g, ' ').trim();
      const userSelector = userSelectors.join(', ');
      const allSelector = [...userSelectors, ...assistantSelectors].join(', ');
      if (allSelector.length === 0) return [];
      const roleOf = (element: Element): 'user' | 'assistant' =>
        userSelector.length > 0 && element.matches(userSelector) ? 'user' : 'assistant';
      const elements = [...document.querySelectorAll(allSelector)].filter((element) => {
        const parentMatch = element.parentElement?.closest(allSelector) ?? null;
        return parentMatch === null || roleOf(parentMatch) !== roleOf(element);
      });
      let userIndex = 0;
      let assistantIndex = 0;
      return elements.map((element) => {
        const isUser = roleOf(element) === 'user';
        const roleValue: 'user' | 'assistant' = isUser ? 'user' : 'assistant';
        const index = isUser ? userIndex++ : assistantIndex++;
        const messageId =
          element.getAttribute('data-message-id') ??
          element.getAttribute('data-response-id') ??
          element.id ??
          null;
        const turnId =
          element.getAttribute('data-turn-id') ??
          element.getAttribute('data-message-id') ??
          element.getAttribute('data-response-id') ??
          element.id ??
          null;
        let text = normalize(element.textContent);
        if (isUser && userTextLineSelectors.length > 0) {
          for (const selector of userTextLineSelectors) {
            const lines = [...element.querySelectorAll(selector)];
            if (lines.length === 0) continue;
            text = normalize(lines.map((line) => line.textContent ?? '').join('\n'));
            break;
          }
        } else if (!isUser) {
          let textNode: Element = element;
          for (const selector of textSelectors) {
            const candidate = element.querySelector(selector);
            if (candidate !== null) {
              textNode = candidate;
              break;
            }
          }
          text = normalize(textNode.textContent);
        }
        const status = (element.getAttribute('data-status') ?? '').toLowerCase();
        const state = (element.getAttribute('data-state') ?? '').toLowerCase();
        return {
          ...(includeArtifacts && artifactSelector.length > 0 ? { artifacts: [...element.querySelectorAll<HTMLAnchorElement>(artifactSelector)].map((anchor, index) => ({
            href: anchor.href || anchor.getAttribute('href') || '',
            name: anchor.getAttribute('download') || anchor.getAttribute('aria-label') || anchor.textContent?.trim() || `artifact-${index + 1}`,
            mediaType: anchor.getAttribute('type'),
          })) } : {}),
          role: roleValue,
          index,
          text,
          messageId,
          turnId,
          terminalAttribute:
            element.getAttribute('data-complete') === 'true' ||
            status === 'complete' ||
            status === 'finished' ||
            state === 'complete' ||
            state === 'finished',
          streamingAttribute:
            element.getAttribute('data-streaming') === 'true' ||
            status === 'streaming' ||
            state === 'streaming',
        };
      });
    },
    {
      userSelectors: [...selectors.userMessages],
      userTextLineSelectors: [...(selectors.userTextLines ?? [])],
      artifactSelector: selectors.artifactLinks.join(', '), includeArtifacts,
      assistantSelectors: [...selectors.assistantMessages],
      textSelectors: [...selectors.assistantText],
    },
  );
  const counters: Record<'user' | 'assistant', number> = { user: 0, assistant: 0 };
  const turns: DomTurn[] = raw.map((turn) => {
    const ordinal = counters[turn.role]++;
    const digest = createHash('sha256').update(normalizeText(turn.text)).digest('hex').slice(0, 24);
    const generated = `dom-${turn.role}:${ordinal}:${digest}`;
    const messageId = turn.messageId?.trim() || generated;
    const turnId = turn.turnId?.trim() || messageId;
    return {
      role: turn.role,
      index: turn.index,
      text: turn.text,
      messageId,
      turnId,
      ...(turn.artifacts === undefined ? {} : { artifacts: turn.artifacts }),
      identityKey: `${messageId}\u0000${turnId}`,
      terminalAttribute: turn.terminalAttribute,
      streamingAttribute: turn.streamingAttribute,
    };
  });
  return role === undefined ? turns : turns.filter((turn) => turn.role === role);
}

async function observeProviderDom(
  page: Page,
  selectors: ProviderDomSelectors,
  anchor: {
    readonly submittedUserMessageId: string | null;
    readonly submittedUserTurnId: string | null;
  },
): Promise<{
  readonly submittedUserFound: boolean;
  readonly laterUserFound: boolean;
  readonly candidate: ProviderObservationEvidence['candidate'];
  readonly activity: ProviderObservationEvidence['activity'];
  readonly dialogKind: ProviderObservationEvidence['dialogKind'];
  readonly reason: string | null;
}> {
  const turns = await readTurns(page, selectors);
  const anchorIndex = turns.findIndex((turn) =>
    (anchor.submittedUserMessageId !== null && turn.messageId === anchor.submittedUserMessageId) ||
    (anchor.submittedUserTurnId !== null && turn.turnId === anchor.submittedUserTurnId),
  );
  const afterAnchor = anchorIndex < 0 ? [] : turns.slice(anchorIndex + 1);
  const laterUserIndex = afterAnchor.findIndex((turn) => turn.role === 'user');
  const candidateTurns = (laterUserIndex < 0 ? afterAnchor : afterAnchor.slice(0, laterUserIndex))
    .filter((turn) => turn.role === 'assistant' && turn.text.length > 0);
  const candidateTurn = candidateTurns.at(-1) ?? null;
  const stopVisible = await anyVisible(page, selectors.stopControls);
  const completionVisible = await anyVisible(page, selectors.completion);
  const dialogText = await visibleDialogText(page);
  const lowerDialog = dialogText.toLowerCase();
  const dialogKind =
    lowerDialog.includes('rate limit') ||
    lowerDialog.includes('too many requests') ||
    lowerDialog.includes('사용량 한도') ||
    lowerDialog.includes('요청 한도')
      ? 'rate_limit'
      : dialogText.length > 0
        ? 'interstitial'
        : null;
  const candidate = candidateTurn === null
    ? null
    : {
        responseMessageId: candidateTurn.messageId,
        answerText: candidateTurn.text,
        terminalMarker:
          candidateTurn.terminalAttribute || (completionVisible && !stopVisible),
        streamingMarker: candidateTurn.streamingAttribute || stopVisible,
      };
  return {
    submittedUserFound: anchorIndex >= 0,
    laterUserFound: laterUserIndex >= 0,
    candidate,
    activity: stopVisible ? 'strong' : candidate === null ? 'none' : 'none',
    dialogKind,
    reason:
      dialogKind === 'rate_limit'
        ? 'visible-provider-rate-limit'
        : dialogKind === 'interstitial'
          ? 'visible-provider-interstitial'
          : anchorIndex < 0
            ? 'submitted-user-anchor-missing'
            : laterUserIndex >= 0
              ? 'later-user-turn-present'
              : stopVisible
                ? 'provider-stop-control-visible'
                : candidate === null
                  ? 'assistant-candidate-missing'
                  : null,
  };
}

async function uploadAttachments(
  page: Page,
  selectors: ProviderDomSelectors,
  attachments: readonly ProviderAttachment[],
): Promise<void> {
  const paths = attachments.map((attachment) => attachment.path);
  const input = await firstExisting(page, selectors.fileInputs);
  if (input !== null) {
    await input.setInputFiles(paths);
  } else {
    const trigger = await firstVisible(page, selectors.uploadTriggers);
    if (trigger === null) {
      throw new ProviderSubmissionError(
        'provider.attachment-surface-unavailable',
        'Provider file upload surface is unavailable',
      );
    }
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
    await trigger.click({ timeout: 5_000 });
    let chooser = await chooserPromise;
    if (chooser === null && selectors.uploadMenuItems.length > 0) {
      const item = await firstVisible(page, selectors.uploadMenuItems);
      if (item !== null) {
        const secondChooser = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
        await item.click({ timeout: 5_000 });
        chooser = await secondChooser;
      }
    }
    if (chooser !== null) {
      await chooser.setFiles(paths);
    } else {
      const lateInput = await firstExisting(page, selectors.fileInputs);
      if (lateInput === null) {
        throw new ProviderSubmissionError(
          'provider.attachment-surface-unavailable',
          'Provider upload control did not expose a file chooser',
        );
      }
      await lateInput.setInputFiles(paths);
    }
  }

  const deadline = Date.now() + 20_000;
  do {
    const expected = attachments.map((attachment) => normalizeLabel(attachment.name));
    const body = normalizeLabel((await page.locator('body').innerText().catch(() => '')) ?? '');
    if (expected.every((name) => body.includes(name))) return;

    const evidence: string[] = [];
    for (const selector of selectors.attachmentEvidence) {
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
    if (expected.every((name) => normalizedEvidence.includes(name))) return;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new ProviderSubmissionError(
    'provider.attachment-evidence-missing',
    'Provider did not acknowledge the selected attachment files',
  );
}

async function selectExactModel(
  page: Page,
  selectors: ProviderDomSelectors,
  requestedModel: string,
): Promise<void> {
  const switcher = await firstVisible(page, selectors.modelSwitcher);
  if (switcher === null) {
    throw new ProviderSubmissionError(
      'provider.model-unavailable',
      `Requested model is unavailable: ${requestedModel}`,
    );
  }
  const current = normalizeLabel((await switcher.textContent().catch(() => null)) ?? '');
  if (modelLabelMatches(current, requestedModel)) return;
  await switcher.click({ timeout: 5_000 });
  const options = page.locator(selectors.modelOptions);
  const count = await options.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    if (!(await option.isVisible().catch(() => false))) continue;
    const label = normalizeLabel((await option.textContent().catch(() => null)) ?? '');
    if (!modelLabelMatches(label, requestedModel)) continue;
    if (
      (await option.getAttribute('aria-disabled').catch(() => null)) === 'true' ||
      (await option.isDisabled().catch(() => false))
    ) {
      break;
    }
    await option.click({ timeout: 5_000 });
    const deadline = Date.now() + 2_000;
    do {
      const selected = normalizeLabel((await switcher.textContent().catch(() => null)) ?? '');
      if (modelLabelMatches(selected, requestedModel)) return;
      await page.waitForTimeout(50);
    } while (Date.now() < deadline);
    break;
  }
  throw new ProviderSubmissionError(
    'provider.model-unavailable',
    `Requested model is absent, disabled, or not acknowledged: ${requestedModel}`,
  );
}

async function selectNamedMode(page: Page, requested: string): Promise<void> {
  const normalized = normalizeLabel(requested);
  const candidates = page.locator('button, [role="menuitem"], [role="option"], [role="menuitemcheckbox"]');
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const label = normalizeLabel(
      (await candidate.getAttribute('aria-label').catch(() => null)) ??
      (await candidate.textContent().catch(() => null)) ??
      '',
    );
    if (!modelLabelMatches(label, normalized)) continue;
    if ((await candidate.getAttribute('aria-pressed').catch(() => null)) === 'true') return;
    if ((await candidate.getAttribute('aria-checked').catch(() => null)) === 'true') return;
    await candidate.click({ timeout: 5_000 });
    return;
  }
  throw new ProviderSubmissionError(
    'provider.model-unavailable',
    `Requested provider mode is unavailable: ${requested}`,
  );
}

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function firstEditable(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const candidate = await firstVisible(page, selectors);
    if (candidate !== null && (await candidate.isEditable().catch(() => false))) {
      return candidate;
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(50);
  } while (true);
}

async function firstEnabled(
  page: Page,
  selectors: readonly string[],
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    const candidate = await firstVisible(page, selectors);
    if (
      candidate !== null &&
      (await candidate.isEnabled().catch(() => false)) &&
      !(await candidate.isDisabled().catch(() => true))
    ) {
      return candidate;
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(50);
  } while (true);
}

async function firstExisting(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if ((await candidate.count().catch(() => 0)) > 0) return candidate;
  }
  return null;
}

async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  return (await firstVisible(page, selectors)) !== null;
}

async function visibleDialogText(page: Page): Promise<string> {
  const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
  const count = await dialogs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const dialog = dialogs.nth(index);
    if (!(await dialog.isVisible().catch(() => false))) continue;
    return normalizeText((await dialog.innerText().catch(() => '')) ?? '');
  }
  return '';
}

async function readComposerValue(composer: Locator): Promise<string> {
  return await composer.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }
    return element instanceof HTMLElement ? element.innerText : element.textContent ?? '';
  });
}

async function waitForComposerValue(
  composer: Locator,
  expected: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const actual = await readComposerValue(composer).catch(() => null);
    if (actual !== null && normalizeText(actual) === normalizeText(expected)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (true);
}

function normalizeText(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll(/\s+/g, ' ').trim();
}

function normalizeLabel(value: string): string {
  return value.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

function modelLabelMatches(value: string, requested: string): boolean {
  const actual = normalizeLabel(value);
  const expected = normalizeLabel(requested);
  if (actual === expected) return true;
  if (expected.length === 0) return false;
  let offset = actual.indexOf(expected);
  while (offset >= 0) {
    const before = actual[offset - 1];
    const after = actual[offset + expected.length];
    if (
      (before === undefined || /\s|[()[\]{}:]/.test(before)) &&
      (after === undefined || /\s|[()[\]{}:]/.test(after))
    ) {
      return true;
    }
    offset = actual.indexOf(expected, offset + 1);
  }
  return false;
}

async function waitForDomMutation(page: Page, timeoutMs: number): Promise<ProviderWakeReason> {
  return await page.evaluate((timeout) =>
    new Promise<'dom' | 'timer'>((resolve) => {
      const root = document.body ?? document.documentElement;
      if (root === null) {
        resolve('timer');
        return;
      }
      let settled = false;
      const observer = new MutationObserver(() => finish('dom'));
      const timer = setTimeout(() => finish('timer'), timeout);
      const finish = (reason: 'dom' | 'timer'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        observer.disconnect();
        resolve(reason);
      };
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    }), timeoutMs);
}

interface NetworkWaiter {
  readonly afterRevision: number;
  readonly resolve: (reason: ProviderWakeReason) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanup: () => void;
}

class GenericNetworkObserver {
  readonly #page: Page;
  readonly #provider: string;
  readonly #waiters = new Map<number, NetworkWaiter>();
  readonly #webSockets = new Map<WebSocket, () => void>();
  #revision = 0;
  #nextWaiterId = 1;
  #closed = false;

  readonly #onRequest = (request: Request): void => {
    if (this.#relevant(request.url(), request.resourceType())) this.#record();
  };
  readonly #onResponse = (response: Response): void => {
    const request = response.request();
    if (this.#relevant(response.url(), request.resourceType())) this.#record();
  };
  readonly #onWebSocket = (socket: WebSocket): void => {
    if (!isProviderUrl(this.#provider, socket.url())) return;
    const onFrame = (): void => this.#record();
    this.#webSockets.set(socket, onFrame);
    socket.on('framereceived', onFrame);
    socket.on('framesent', onFrame);
    socket.once('close', () => {
      socket.off('framereceived', onFrame);
      socket.off('framesent', onFrame);
      this.#webSockets.delete(socket);
    });
    this.#record();
  };

  constructor(page: Page, provider: string) {
    this.#page = page;
    this.#provider = provider;
    page.on('request', this.#onRequest);
    page.on('response', this.#onResponse);
    page.on('websocket', this.#onWebSocket);
  }

  snapshot(afterRevision: number): { readonly revision: number; readonly activity: boolean } {
    return { revision: this.#revision, activity: this.#revision > afterRevision };
  }

  async waitForActivity(
    afterRevision: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProviderWakeReason> {
    if (this.#closed || signal?.aborted === true) return 'timer';
    if (this.#revision > afterRevision) return 'network';
    return await new Promise<ProviderWakeReason>((resolve) => {
      const waiterId = this.#nextWaiterId++;
      let settled = false;
      const finish = (reason: ProviderWakeReason): void => {
        if (settled) return;
        settled = true;
        const waiter = this.#waiters.get(waiterId);
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          waiter.cleanup();
          this.#waiters.delete(waiterId);
        }
        resolve(reason);
      };
      const timer = setTimeout(() => finish('timer'), timeoutMs);
      timer.unref?.();
      const onAbort = (): void => finish('timer');
      signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      this.#waiters.set(waiterId, { afterRevision, resolve: finish, timer, cleanup });
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#page.off('request', this.#onRequest);
    this.#page.off('response', this.#onResponse);
    this.#page.off('websocket', this.#onWebSocket);
    for (const [socket, onFrame] of this.#webSockets) {
      socket.off('framereceived', onFrame);
      socket.off('framesent', onFrame);
    }
    this.#webSockets.clear();
    for (const [waiterId, waiter] of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.cleanup();
      this.#waiters.delete(waiterId);
      waiter.resolve('timer');
    }
  }

  #record(): void {
    if (this.#closed) return;
    this.#revision += 1;
    for (const [waiterId, waiter] of this.#waiters) {
      if (this.#revision <= waiter.afterRevision) continue;
      clearTimeout(waiter.timer);
      waiter.cleanup();
      this.#waiters.delete(waiterId);
      waiter.resolve('network');
    }
  }

  #relevant(url: string, resourceType: string): boolean {
    return (
      ['fetch', 'xhr', 'websocket'].includes(resourceType) &&
      isProviderUrl(this.#provider, url)
    );
  }
}

function sanitizeArtifactName(value: string): string {
  const name = value.trim().replaceAll(/[\\/\0]/g, '_').slice(0, 300);
  return name.length === 0 ? 'artifact.bin' : name;
}
