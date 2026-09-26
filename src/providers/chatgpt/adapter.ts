import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import path from 'node:path';

import type { BrowserOwner } from '../../browser/browser-owner.ts';
import { PageRegistryError, type PageRegistry } from '../../browser/page-registry.ts';
import type { PageBindingSnapshot } from '../../browser/page-binding.ts';
import {
  ProviderSubmissionError,
  type ProviderAdapter,
  type ProviderAcknowledgementRecoveryRequest,
  type ProviderArtifactCandidate,
  type ProviderArtifactDownload,
  type ProviderArtifactRequest,
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
} from '../provider-adapter.ts';
import { observeChatGptActivity } from './activity-observer.ts';
import {
  ChatGptBackendRecovery,
  type BackendJsonClient,
} from './backend-recovery.ts';
import { observeChatGptDialog } from './dialog-observer.ts';
import { observeChatGptDom, waitForChatGptDomMutation } from './dom-observer.ts';
import { ChatGptNetworkObserver } from './network-observer.ts';
import { readChatGptMessages } from './message-dom.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';
import { ChatGptSubmission, recoverChatGptAcknowledgement } from './submission.ts';

export interface ChatGptAdapterOptions {
  readonly browserOwner: BrowserOwner;
  readonly pageRegistry: PageRegistry;
  readonly loginUrl: string;
  readonly acknowledgementTimeoutMs: number;
  readonly backendRequestTimeoutMs?: number;
  readonly tokenCacheTtlMs?: number;
}

export class ChatGptAdapter implements ProviderAdapter {
  readonly provider = 'chatgpt';
  readonly #browserOwner: BrowserOwner;
  readonly #pageRegistry: PageRegistry;
  readonly #loginUrl: string;
  readonly #acknowledgementTimeoutMs: number;
  readonly #backendRecovery: ChatGptBackendRecovery;

  constructor(options: ChatGptAdapterOptions) {
    this.#browserOwner = options.browserOwner;
    this.#pageRegistry = options.pageRegistry;
    this.#loginUrl = options.loginUrl;
    this.#acknowledgementTimeoutMs = options.acknowledgementTimeoutMs;
    this.#backendRecovery = new ChatGptBackendRecovery({
      requestTimeoutMs: options.backendRequestTimeoutMs ?? 15_000,
      tokenCacheTtlMs: options.tokenCacheTtlMs ?? 60_000,
    });
  }

  async openSubmission(request: ProviderSubmissionRequest): Promise<ProviderSubmission> {
    let createdPage: Page | null = null;
    try {
      let pageKey = request.session.pageKey;
      let initialUrl: string | undefined;
      if (
        pageKey !== null &&
        !hasOpenPage(this.#pageRegistry, pageKey) &&
        !request.session.promptSubmitted
      ) {
        pageKey = null;
      }
      if (
        pageKey !== null &&
        request.session.conversationId === null &&
        !request.session.promptSubmitted
      ) {
        const binding = this.#pageRegistry.refreshPage(pageKey);
        if (!sameProviderOrigin(binding.url, this.#loginUrl)) {
          initialUrl = this.#loginUrl;
        }
      }

      if (pageKey === null && request.session.conversationId !== null) {
        if (request.session.promptSubmitted) {
          throw new PageRegistryError(
            'browser.unavailable',
            'Cannot replace a missing Page after provider submission was attempted',
          );
        }
        const existing = this.#pageRegistry.findByConversation(
          request.session.conversationId,
        );
        if (existing.length > 0) {
          pageKey = existing[0]?.pageKey ?? null;
        } else {
          const created = await this.#browserOwner.createPage();
          createdPage = created.page;
          pageKey = created.binding.pageKey;
          await created.page.goto(
            chatGptConversationUrl(this.#loginUrl, request.session.conversationId),
            { waitUntil: 'commit', timeout: 30_000 },
          );
          this.#pageRegistry.refreshPage(pageKey);
        }
      }

      if (pageKey === null) {
        const created = await this.#browserOwner.createPage();
        createdPage = created.page;
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
      createdPage = null;
      return new ChatGptSubmission({
        page,
        pageKey,
        pageRegistry: this.#pageRegistry,
        request,
        acknowledgementTimeoutMs: this.#acknowledgementTimeoutMs,
        ...(initialUrl === undefined ? {} : { initialUrl }),
      });
    } catch (error) {
      await createdPage?.close().catch(() => undefined);
      if (error instanceof ProviderSubmissionError) {
        throw error;
      }
      if (error instanceof PageRegistryError) {
        throw new ProviderSubmissionError(error.errorCode, error.message, { cause: error });
      }
      throw new ProviderSubmissionError('browser.unavailable', 'Failed to open exact ChatGPT Page', {
        cause: error,
      });
    }
  }

  async recoverAcknowledgement(
    request: ProviderAcknowledgementRecoveryRequest,
  ): Promise<ProviderSubmissionAcknowledgement | null> {
    const pageKey = request.session.pageKey;
    const conversationId = request.session.conversationId;
    if (pageKey === null || conversationId === null) return null;
    try {
      const binding = this.#pageRegistry.refreshPage(pageKey);
      if (isWebRedirect(binding, request.session.sessionId, request.generation, conversationId)) {
        const page = this.#pageRegistry.pageForObservation(pageKey);
        const acknowledgement = await recoverChatGptAcknowledgement(
          page,
          request.prompt,
          binding.conversationId,
        );
        if (acknowledgement === null ||
          this.#pageRegistry.refreshPage(pageKey).bindingEpoch !== binding.bindingEpoch) {
          return null;
        }
        this.#pageRegistry.bindVerifiedRedirect(pageKey, {
          sessionId: request.session.sessionId,
          generation: request.generation,
          previousConversationId: conversationId,
          conversationId: binding.conversationId,
        });
        return acknowledgement;
      }
      const page = this.#pageRegistry.requireOwnedPage(pageKey, {
        sessionId: request.session.sessionId,
        generation: request.generation,
        conversationId,
      });
      return await recoverChatGptAcknowledgement(page, request.prompt, conversationId);
    } catch {
      return null;
    }
  }

  async openObservation(request: ProviderObservationRequest): Promise<ProviderObservationSource> {
    const pageKey = request.session.pageKey;
    const conversationId = request.session.conversationId;
    if (
      pageKey === null ||
      conversationId === null ||
      (request.session.submittedUserMessageId === null &&
        request.session.submittedUserTurnId === null)
    ) {
      throw new ProviderSubmissionError(
        'session.page-identity-unverified',
        'Exact ChatGPT observation identity is incomplete',
        { promptSubmitted: request.session.promptSubmitted },
      );
    }

    try {
      const binding = this.#pageRegistry.refreshPage(pageKey);
      const page = isWebRedirect(
        binding,
        request.session.sessionId,
        request.generation,
        conversationId,
      )
        ? this.#pageRegistry.pageForObservation(pageKey)
        : this.#pageRegistry.requireOwnedPage(pageKey, {
            sessionId: request.session.sessionId,
            generation: request.generation,
            conversationId,
          });
      return new ChatGptObservationSource({
        pageKey,
        page,
        pageRegistry: this.#pageRegistry,
        request,
      });
    } catch (error) {
      if (error instanceof PageRegistryError) {
        throw new ProviderSubmissionError(error.errorCode, error.message, {
          promptSubmitted: request.session.promptSubmitted,
          cause: error,
        });
      }
      throw error;
    }
  }

  async openDeletion(request: ProviderRecoveryRequest) {
    const conversationId = request.session.conversationId;
    if (conversationId === null || conversationId.startsWith('WEB:')) {
      throw new ProviderSubmissionError('session.conversation-mismatch', 'Deletion requires a durable ChatGPT conversation');
    }
    const { page } = await this.#browserOwner.createPage();
    const origin = new URL(this.#loginUrl).origin;
    try {
      const auth = await page.context().request.get(origin + '/api/auth/session', { timeout: 15_000 });
      let token: unknown;
      try {
        if (!auth.ok()) {
          throw new ProviderSubmissionError(
            auth.status() === 401 ? 'provider.authentication-required' : 'provider.unavailable',
            'Deletion authentication request failed',
          );
        }
        const body: unknown = await auth.json();
        token = body !== null && typeof body === 'object' && 'accessToken' in body ? body.accessToken : null;
      } finally { await auth.dispose(); }
      if (typeof token !== 'string' || token.length < 8) {
        throw new ProviderSubmissionError('provider.authentication-required', 'Deletion requires the dedicated authenticated profile');
      }
      const accessToken = token;
      const endpoint = origin + '/backend-api/conversation/' + encodeURIComponent(conversationId);
      const existing = await page.context().request.get(endpoint, {
        headers: { authorization: 'Bearer ' + accessToken }, timeout: 15_000,
      });
      let alreadyDeleted = false;
      try {
        if (!existing.ok()) {
          const body: unknown = await existing.json();
          const detail = body !== null && typeof body === 'object' && 'detail' in body ? body.detail : null;
          alreadyDeleted = existing.status() === 404 && detail !== null && typeof detail === 'object' &&
            'code' in detail && detail.code === 'conversation_deleted' &&
            'conversation_id' in detail && detail.conversation_id === conversationId;
          if (!alreadyDeleted) throw new ProviderSubmissionError('provider.unavailable', 'Exact conversation could not be verified for deletion');
        }
      } finally { await existing.dispose(); }
      return {
        alreadyDeleted,
        deleteOnce: async (): Promise<boolean> => {
          if (alreadyDeleted) return true;
          const response = await page.context().request.patch(
            origin + '/backend-api/conversation/' + encodeURIComponent(conversationId), {
              headers: { authorization: 'Bearer ' + accessToken },
              data: { is_visible: false }, timeout: 15_000,
            });
          try {
            if (response.status() >= 500 || response.status() === 408) {
              throw new Error('Conversation deletion outcome is unknown');
            }
            if (!response.ok()) return false;
            const body: unknown = await response.json();
            if (body !== null && typeof body === 'object' && 'success' in body && body.success === true) return true;
            throw new Error('Conversation deletion acknowledgement is unverified');
          } finally { await response.dispose(); }
        },
        close: async () => { await page.close(); },
      };
    } catch (error) {
      await page.close();
      throw error;
    }
  }

  async recover(request: ProviderRecoveryRequest): Promise<ProviderRecoveryResult> {
    const pageKey = request.session.pageKey;
    const conversationId = request.session.conversationId;
    if (pageKey === null || conversationId === null) {
      return recoveryUnavailable('backend-page-identity-incomplete');
    }

    let page: ReturnType<PageRegistry['requireOwnedPage']>;
    try {
      page = this.#pageRegistry.requireOwnedPage(pageKey, {
        sessionId: request.session.sessionId,
        generation: request.generation,
        conversationId,
      });
    } catch (error) {
      return recoveryUnavailable(
        error instanceof PageRegistryError
          ? 'backend-page-identity-unverified'
          : 'backend-page-unavailable',
      );
    }

    const client: BackendJsonClient = {
      async get(url, options) {
        const response = await page.context().request.get(url, {
          failOnStatusCode: false,
          ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
          timeout: options.timeoutMs,
        });
        try {
          return {
            status: response.status(),
            headers: response.headers(),
            body: await response.json().catch(() => null),
          };
        } finally {
          await response.dispose();
        }
      },
    };
    return await this.#backendRecovery.recover(request, client, new URL(page.url()).origin);
  }

  async discoverArtifacts(
    request: ProviderArtifactRequest,
  ): Promise<readonly ProviderArtifactCandidate[]> {
    const page = this.#requireExactArtifactPage(request);
    const message = (await readChatGptMessages(page, true)).find((message) =>
      message.role === 'assistant' && message.messageId !== null && message.messageId === request.session.responseMessageId);
    if (message === undefined) throw new ProviderSubmissionError('provider.artifacts-unavailable', 'Exact answer is not present for file discovery');
    const rows = message.artifacts ?? [];
    const seen = new Set<string>();
    const candidates: ProviderArtifactCandidate[] = [];
    for (const row of rows) {
      if (row.source === '' || seen.has(row.source)) continue;
      seen.add(row.source);
      const fallbackName = nameFromSource(row.source);
      const name = sanitizeArtifactName(row.name || fallbackName);
      const providerArtifactId = `chatgpt-link-${createHash('sha256')
        .update(row.source)
        .digest('hex')}`;
      candidates.push(Object.freeze({
        providerArtifactId,
        name,
        sourceUrl: row.source,
        mediaType: row.mediaType,
      }));
    }
    return Object.freeze(candidates);
  }

  async downloadArtifact(
    request: ProviderArtifactRequest,
    candidate: ProviderArtifactCandidate,
  ): Promise<ProviderArtifactDownload> {
    const page = this.#requireExactArtifactPage(request);
    const result = await page.evaluate(async (sourceUrl) => {
      const response = await fetch(sourceUrl, { credentials: 'include' }).catch(() => null);
      if (response === null || !response.ok) {
        return { ok: false as const, status: response?.status ?? 0, base64: '' };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      return { ok: true as const, status: response.status, base64: btoa(binary) };
    }, candidate.sourceUrl);
    if (!result.ok) {
      throw new ProviderSubmissionError(
        'provider.artifact-download-failed',
        `ChatGPT artifact download failed with status ${result.status}`,
        { promptSubmitted: request.session.promptSubmitted },
      );
    }
    return {
      candidate,
      bytes: Uint8Array.from(Buffer.from(result.base64, 'base64')),
    };
  }

  async openStop(request: ProviderStopRequest): Promise<ProviderStopOperation> {
    const pageKey = request.session.pageKey;
    const conversationId = request.session.conversationId;
    if (pageKey === null || conversationId === null) {
      throw new ProviderSubmissionError(
        'session.page-identity-unverified',
        'Exact ChatGPT stop identity is incomplete',
        { promptSubmitted: request.session.promptSubmitted },
      );
    }
    const page = this.#pageRegistry.requireOwnedPage(pageKey, {
      sessionId: request.session.sessionId,
      generation: request.generation,
      conversationId,
    });
    return new ChatGptStopOperation({
      pageKey,
      page,
      pageRegistry: this.#pageRegistry,
      request,
    });
  }

  #requireExactArtifactPage(
    request: ProviderArtifactRequest,
  ): ReturnType<PageRegistry['requireOwnedPage']> {
    const pageKey = request.session.pageKey;
    const conversationId = request.session.conversationId;
    if (pageKey === null || conversationId === null) {
      throw new ProviderSubmissionError(
        'session.page-identity-unverified',
        'Exact ChatGPT artifact identity is incomplete',
        { promptSubmitted: request.session.promptSubmitted },
      );
    }
    try {
      return this.#pageRegistry.requireOwnedPage(pageKey, {
        sessionId: request.session.sessionId,
        generation: request.bindingGeneration ?? request.generation,
        conversationId,
      });
    } catch (error) {
      if (error instanceof PageRegistryError) throw new ProviderSubmissionError(error.errorCode, error.message, { cause: error });
      throw error;
    }
  }
}

function hasOpenPage(pageRegistry: PageRegistry, pageKey: string): boolean {
  try {
    return pageRegistry.refreshPage(pageKey).state !== 'closed';
  } catch (error) {
    if (error instanceof PageRegistryError) return false;
    throw error;
  }
}

function isWebRedirect(
  binding: PageBindingSnapshot,
  sessionId: string,
  generation: number,
  conversationId: string,
): binding is PageBindingSnapshot & { readonly conversationId: string } {
  return (
    conversationId.startsWith('WEB:') &&
    binding.state === 'identity_lost' &&
    binding.sessionId === sessionId &&
    binding.generation === generation &&
    (binding.expectedConversationId === conversationId ||
      binding.expectedConversationId === null) &&
    binding.conversationId !== null &&
    !binding.conversationId.startsWith('WEB:')
  );
}

function sameProviderOrigin(currentUrl: string, loginUrl: string): boolean {
  try {
    return new URL(currentUrl).origin === new URL(loginUrl).origin;
  } catch {
    return false;
  }
}

function chatGptConversationUrl(loginUrl: string, conversationId: string): string {
  const url = new URL(loginUrl);
  url.pathname = '/c/' + encodeURIComponent(conversationId);
  url.search = '';
  url.hash = '';
  return url.href;
}

function recoveryUnavailable(reason: string): ProviderRecoveryResult {
  return {
    kind: 'unavailable',
    observationTransport: 'unavailable',
    responseMessageId: null,
    answerText: null,
    reason,
    retryAfterMs: null,
    nextCheckAt: null,
  };
}

function nameFromSource(source: string): string {
  try {
    const url = new URL(source);
    const name = path.posix.basename(url.pathname);
    return name === '' || name === '/' ? 'chatgpt-artifact' : name;
  } catch {
    return 'chatgpt-artifact';
  }
}

function sanitizeArtifactName(value: string): string {
  const name = value.trim().replaceAll(/[\\/\u0000]/g, '_');
  return name === '' ? 'chatgpt-artifact' : name.slice(0, 255);
}

interface ChatGptStopOperationOptions {
  readonly pageKey: string;
  readonly page: ReturnType<PageRegistry['requireOwnedPage']>;
  readonly pageRegistry: PageRegistry;
  readonly request: ProviderStopRequest;
}

class ChatGptStopOperation implements ProviderStopOperation {
  readonly provider = 'chatgpt';
  readonly pageKey: string;
  readonly #page: ReturnType<PageRegistry['requireOwnedPage']>;
  readonly #pageRegistry: PageRegistry;
  readonly #request: ProviderStopRequest;
  #selector: string | null = null;

  constructor(options: ChatGptStopOperationOptions) {
    this.pageKey = options.pageKey;
    this.#page = options.page;
    this.#pageRegistry = options.pageRegistry;
    this.#request = options.request;
  }

  async prepare(): Promise<boolean> {
    this.#requireExactPage();
    for (const selector of CHATGPT_SELECTORS.stopControls) {
      const controls = this.#page.locator(selector);
      const count = await controls.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (
          (await control.isVisible().catch(() => false)) &&
          (await control.isEnabled().catch(() => false)) &&
          !(await control.isDisabled().catch(() => true))
        ) {
          this.#selector = selector;
          return true;
        }
      }
    }
    return false;
  }

  async stopOnce(): Promise<void> {
    if (this.#selector === null) {
      throw new ProviderSubmissionError(
        'internal.invariant-violation',
        'ChatGPT stop was not prepared before mutation',
        { promptSubmitted: this.#request.session.promptSubmitted },
      );
    }
    this.#requireExactPage();
    const controls = this.#page.locator(this.#selector);
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (
        (await control.isVisible().catch(() => false)) &&
        (await control.isEnabled().catch(() => false)) &&
        !(await control.isDisabled().catch(() => true))
      ) {
        await control.click({ timeout: 5_000 });
        return;
      }
    }
    throw new ProviderSubmissionError(
      'browser.unavailable',
      'Prepared ChatGPT stop control disappeared before mutation',
      { promptSubmitted: this.#request.session.promptSubmitted },
    );
  }

  #requireExactPage(): void {
    this.#pageRegistry.requireOwnedPage(this.pageKey, {
      sessionId: this.#request.session.sessionId,
      generation: this.#request.generation,
      conversationId: this.#request.session.conversationId ?? '',
    });
  }
}

interface ChatGptObservationSourceOptions {
  readonly pageKey: string;
  readonly page: ReturnType<PageRegistry['requireOwnedPage']>;
  readonly pageRegistry: PageRegistry;
  readonly request: ProviderObservationRequest;
}

class ChatGptObservationSource implements ProviderObservationSource {
  readonly provider = 'chatgpt';
  readonly pageKey: string;
  readonly #page: ReturnType<PageRegistry['requireOwnedPage']>;
  readonly #pageRegistry: PageRegistry;
  readonly #request: ProviderObservationRequest;
  #conversationId: string;
  readonly #network: ChatGptNetworkObserver;
  #lastNetworkRevision = 0;
  #closed = false;

  constructor(options: ChatGptObservationSourceOptions) {
    this.pageKey = options.pageKey;
    this.#page = options.page;
    this.#pageRegistry = options.pageRegistry;
    this.#request = options.request;
    this.#conversationId = options.request.session.conversationId ?? '';
    this.#network = new ChatGptNetworkObserver(options.page);
  }

  async observe(): Promise<ProviderObservationEvidence> {
    const observedAt = new Date().toISOString();
    const network = this.#network.snapshot(this.#lastNetworkRevision);
    this.#lastNetworkRevision = network.revision;
    if (this.#closed) {
      return this.#unavailable(observedAt, network.activity, 'observation-source-closed');
    }

    try {
      const redirect = this.#pageRegistry.refreshPage(this.pageKey);
      if (isWebRedirect(
        redirect,
        this.#request.session.sessionId,
        this.#request.generation,
        this.#conversationId,
      )) {
        const dom = await observeChatGptDom(this.#page, {
          submittedUserMessageId: this.#request.session.submittedUserMessageId,
          submittedUserTurnId: this.#request.session.submittedUserTurnId,
        });
        const after = this.#pageRegistry.refreshPage(this.pageKey);
        if (dom.submittedUserFound && after.bindingEpoch === redirect.bindingEpoch) {
          this.#pageRegistry.bindVerifiedRedirect(this.pageKey, {
            sessionId: this.#request.session.sessionId,
            generation: this.#request.generation,
            previousConversationId: this.#conversationId,
            conversationId: redirect.conversationId,
          });
          this.#conversationId = redirect.conversationId;
        }
      }
      this.#pageRegistry.requireOwnedPage(this.pageKey, {
        sessionId: this.#request.session.sessionId,
        generation: this.#request.generation,
        conversationId: this.#conversationId,
      });
      const before = this.#pageRegistry.getBinding(this.pageKey);
      const [dom, dialog] = await Promise.all([
        observeChatGptDom(this.#page, {
          submittedUserMessageId: this.#request.session.submittedUserMessageId,
          submittedUserTurnId: this.#request.session.submittedUserTurnId,
        }),
        observeChatGptDialog(this.#page),
      ]);
      const activity = await observeChatGptActivity(this.#page, dom);
      const after = this.#pageRegistry.refreshPage(this.pageKey);
      if (
        before.bindingEpoch !== after.bindingEpoch ||
        after.state !== 'owned' ||
        after.sessionId !== this.#request.session.sessionId ||
        after.generation !== this.#request.generation ||
        after.conversationId !== this.#conversationId
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
        activity: activity.strength,
        dialogKind: dialog.kind,
        networkActivity: network.activity,
        observationTransport: dom.loadFailureStatus !== null || dom.actionableAlert ? 'unavailable' : 'fresh',
        ...(dom.loadFailureStatus !== null ? { errorCode: 'provider.conversation-unavailable' }
          : dom.actionableAlert ? { errorCode: 'provider.observation-unavailable' } : {}),
        reason: dialog.reason ?? (dom.loadFailureStatus !== null
          ? 'conversation-load-http-' + dom.loadFailureStatus
          : dom.actionableAlert ? 'provider-actionable-alert' : activity.reason),
      };
    } catch (error) {
      const binding = this.#pageRegistry.getBinding(this.pageKey);
      return {
        ...this.#unavailable(
          observedAt,
          network.activity,
          error instanceof PageRegistryError
            ? 'page-identity-unverified'
            : 'dom-observation-failed',
        ),
        bindingEpoch: binding.bindingEpoch,
        conversationId: binding.conversationId,
        observationTransport: error instanceof PageRegistryError ? 'stale' : 'unavailable',
      };
    }
  }

  async waitForWake(timeoutMs: number): Promise<ProviderWakeReason> {
    if (this.#closed) {
      return 'timer';
    }
    const controller = new AbortController();
    try {
      return await Promise.race([
        waitForChatGptDomMutation(this.#page, timeoutMs).catch(() => 'timer' as const),
        this.#network.waitForActivity(this.#lastNetworkRevision, timeoutMs, controller.signal),
      ]);
    } finally {
      controller.abort();
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
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
