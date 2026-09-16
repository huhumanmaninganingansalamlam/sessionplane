import type { BrowserOwner } from '../../browser/browser-owner.ts';
import { PageRegistryError, type PageRegistry } from '../../browser/page-registry.ts';
import {
  ProviderSubmissionError,
  type ProviderAdapter,
  type ProviderSubmission,
  type ProviderSubmissionRequest,
} from '../provider-adapter.ts';
import { ChatGptSubmission } from './submission.ts';

export interface ChatGptAdapterOptions {
  readonly browserOwner: BrowserOwner;
  readonly pageRegistry: PageRegistry;
  readonly loginUrl: string;
  readonly acknowledgementTimeoutMs: number;
}

export class ChatGptAdapter implements ProviderAdapter {
  readonly provider = 'chatgpt';
  readonly #browserOwner: BrowserOwner;
  readonly #pageRegistry: PageRegistry;
  readonly #loginUrl: string;
  readonly #acknowledgementTimeoutMs: number;

  constructor(options: ChatGptAdapterOptions) {
    this.#browserOwner = options.browserOwner;
    this.#pageRegistry = options.pageRegistry;
    this.#loginUrl = options.loginUrl;
    this.#acknowledgementTimeoutMs = options.acknowledgementTimeoutMs;
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
}

