import type { BrowserOwner } from '../../browser/browser-owner.ts';
import { PageRegistryError, type PageRegistry } from '../../browser/page-registry.ts';
import {
  ProviderSubmissionError,
  type ProviderAdapter,
  type ProviderObservationEvidence,
  type ProviderObservationRequest,
  type ProviderObservationSource,
  type ProviderRecoveryRequest,
  type ProviderRecoveryResult,
  type ProviderSubmission,
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
import { ChatGptSubmission } from './submission.ts';

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
    try {
      let pageKey = request.session.pageKey;
      let initialUrl: string | undefined;
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
      return new ChatGptSubmission({
        page,
        pageKey,
        pageRegistry: this.#pageRegistry,
        request,
        acknowledgementTimeoutMs: this.#acknowledgementTimeoutMs,
        ...(initialUrl === undefined ? {} : { initialUrl }),
      });
    } catch (error) {
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
      const page = this.#pageRegistry.requireOwnedPage(pageKey, {
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
  readonly #network: ChatGptNetworkObserver;
  #lastNetworkRevision = 0;
  #closed = false;

  constructor(options: ChatGptObservationSourceOptions) {
    this.pageKey = options.pageKey;
    this.#page = options.page;
    this.#pageRegistry = options.pageRegistry;
    this.#request = options.request;
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
      this.#pageRegistry.requireOwnedPage(this.pageKey, {
        sessionId: this.#request.session.sessionId,
        generation: this.#request.generation,
        conversationId: this.#request.session.conversationId ?? '',
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
        activity: activity.strength,
        dialogKind: dialog.kind,
        networkActivity: network.activity,
        observationTransport: 'fresh',
        reason: dialog.reason ?? activity.reason,
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

