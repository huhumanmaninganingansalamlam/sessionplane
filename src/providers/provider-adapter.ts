import type { SessionSnapshot } from '../domain/session.ts';

export interface ProviderSubmissionRequest {
  readonly session: SessionSnapshot;
  readonly generation: number;
  readonly prompt: string;
  readonly model: string | null;
}

export interface ProviderSubmissionAcknowledgement {
  readonly conversationId: string;
  readonly submittedUserMessageId: string;
  readonly submittedUserTurnId: string;
}

export interface ProviderSubmission {
  readonly provider: string;
  readonly pageKey: string;
  prepare(): Promise<void>;
  submitOnce(): Promise<void>;
  captureAcknowledgement(): Promise<ProviderSubmissionAcknowledgement | null>;
  bindAcknowledgement(acknowledgement: ProviderSubmissionAcknowledgement): void;
}

export interface ProviderAdapter {
  readonly provider: string;
  openSubmission(request: ProviderSubmissionRequest): Promise<ProviderSubmission>;
}

export class ProviderSubmissionError extends Error {
  readonly errorCode: string;
  readonly promptSubmitted: boolean;
  readonly details: unknown;

  constructor(
    errorCode: string,
    message: string,
    options: { readonly promptSubmitted?: boolean; readonly details?: unknown; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderSubmissionError';
    this.errorCode = errorCode;
    this.promptSubmitted = options.promptSubmitted ?? false;
    this.details = options.details;
  }
}

export class ProviderAdapterRegistry {
  readonly #adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: readonly ProviderAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: ProviderAdapter): void {
    if (this.#adapters.has(adapter.provider)) {
      throw new Error(`Provider adapter already registered: ${adapter.provider}`);
    }
    this.#adapters.set(adapter.provider, adapter);
  }

  require(provider: string): ProviderAdapter {
    const adapter = this.#adapters.get(provider);
    if (adapter === undefined) {
      throw new ProviderSubmissionError(
        'browser.unavailable',
        `Provider adapter is unavailable: ${provider}`,
      );
    }
    return adapter;
  }
}

