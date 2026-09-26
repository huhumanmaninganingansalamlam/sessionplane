import type { ObservationTransport, SessionSnapshot } from '../domain/session.ts';

export const PROVIDERS = ['chatgpt', 'gemini', 'grok'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface ProviderAttachment {
  readonly path: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly mediaType: string | null;
}

export interface ProviderSubmissionRequest {
  readonly session: SessionSnapshot;
  readonly generation: number;
  readonly prompt: string;
  readonly model: string | null;
  readonly effort?: string | null;
  readonly surface?: string | null;
  readonly attachments?: readonly ProviderAttachment[];
}

export type PreparationPurpose = 'model' | 'effort' | 'composer' | 'submit';

export interface PreparationTarget {
  readonly purpose: PreparationPurpose;
  readonly id: string;
  readonly role: string;
  readonly ancestorIds: readonly string[];
  readonly name: string;
  readonly tag: string;
  readonly text: string;
  readonly placeholder: string | null;
  readonly selected: boolean | null;
  readonly checked: boolean | null;
  readonly disabled: boolean;
  readonly editable: boolean;
  readonly ariaValueText: string | null;
  readonly ariaValueNow: string | null;
  readonly ariaValueMin: string | null;
  readonly ariaValueMax: string | null;
  readonly selectedValue: number | null;
  readonly description: string;
  readonly controls: readonly string[];
  readonly describedBy: readonly string[];
  readonly labelledBy: readonly string[];
}

export type PreparationChoices = Readonly<Partial<Record<PreparationPurpose, PreparationTarget>>>;

export interface ProviderSubmissionAcknowledgement {
  readonly conversationId: string;
  readonly submittedUserMessageId: string;
  readonly submittedUserTurnId: string;
}

export interface ProviderAcknowledgementRecoveryRequest {
  readonly session: SessionSnapshot;
  readonly generation: number;
  readonly prompt: string;
}

export interface ProviderSubmission {
  readonly provider: string;
  readonly pageKey: string;
  prepareForObservation?(): Promise<void>;
  prepare(choices?: PreparationChoices): Promise<void>;
  abandon(): void;
  submitOnce(): Promise<void>;
  captureAcknowledgement(): Promise<ProviderSubmissionAcknowledgement | null>;
  bindAcknowledgement(acknowledgement: ProviderSubmissionAcknowledgement): void;
}

export type ProviderActivityStrength = 'strong' | 'weak' | 'none' | 'unknown';
export type ProviderDialogKind = 'rate_limit' | 'interstitial';
export type ProviderWakeReason = 'dom' | 'network' | 'timer';

export interface ProviderAssistantCandidate {
  readonly responseMessageId: string;
  readonly answerText: string;
  readonly terminalMarker: boolean;
  readonly streamingMarker: boolean;
}

export interface ProviderObservationEvidence {
  readonly errorCode?: string | undefined;
  readonly provider: string;
  readonly pageKey: string;
  readonly bindingEpoch: number;
  readonly observedAt: string;
  readonly conversationId: string | null;
  readonly submittedUserFound: boolean;
  readonly laterUserFound: boolean;
  readonly candidate: ProviderAssistantCandidate | null;
  readonly activity: ProviderActivityStrength;
  readonly dialogKind: ProviderDialogKind | null;
  readonly networkActivity: boolean;
  readonly observationTransport: ObservationTransport;
  readonly reason: string | null;
}

export interface ProviderObservationRequest {
  readonly session: SessionSnapshot;
  readonly generation: number;
}

export interface ProviderObservationSource {
  readonly provider: string;
  readonly pageKey: string;
  observe(): Promise<ProviderObservationEvidence>;
  waitForWake(timeoutMs: number): Promise<ProviderWakeReason>;
  close(): void;
}

export type ProviderRecoveryKind =
  | 'complete'
  | 'pending'
  | 'unverified'
  | 'deferred'
  | 'unavailable';

export interface ProviderRecoveryResult {
  readonly kind: ProviderRecoveryKind;
  readonly observationTransport: ObservationTransport;
  readonly responseMessageId: string | null;
  readonly answerText: string | null;
  readonly reason: string;
  readonly retryAfterMs: number | null;
  readonly nextCheckAt: string | null;
}

export interface ProviderRecoveryRequest {
  readonly session: SessionSnapshot;
  readonly generation: number;
}

export interface ProviderArtifactCandidate {
  readonly providerArtifactId: string;
  readonly name: string;
  readonly sourceUrl: string;
  readonly mediaType: string | null;
}

export interface ProviderArtifactRequest {
  /** Current page owner revision; the requested answer may belong to an older generation. */
  readonly bindingGeneration?: number;
  readonly session: SessionSnapshot;
  readonly generation: number;
}

export interface ProviderArtifactDownload {
  readonly candidate: ProviderArtifactCandidate;
  readonly bytes: Uint8Array;
}

export interface ProviderStopRequest {
  readonly session: SessionSnapshot;
  readonly generation: number;
}

export interface ProviderStopOperation {
  readonly provider: string;
  readonly pageKey: string;
  prepare(): Promise<boolean>;
  stopOnce(): Promise<void>;
}

export interface ProviderAdapter {
  readonly provider: string;
  openSubmission(request: ProviderSubmissionRequest): Promise<ProviderSubmission>;
  openDeletion?(request: ProviderRecoveryRequest): Promise<{
    readonly alreadyDeleted: boolean;
    deleteOnce(): Promise<boolean>;
    close(): Promise<void>;
  }>;
  recoverAcknowledgement?(
    request: ProviderAcknowledgementRecoveryRequest,
  ): Promise<ProviderSubmissionAcknowledgement | null>;
  openObservation(request: ProviderObservationRequest): Promise<ProviderObservationSource>;
  recover(request: ProviderRecoveryRequest): Promise<ProviderRecoveryResult>;
  openStop(request: ProviderStopRequest): Promise<ProviderStopOperation>;
  discoverArtifacts?(request: ProviderArtifactRequest): Promise<readonly ProviderArtifactCandidate[]>;
  downloadArtifact?(
    request: ProviderArtifactRequest,
    candidate: ProviderArtifactCandidate,
  ): Promise<ProviderArtifactDownload>;

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

  has(provider: string): boolean {
    return this.#adapters.has(provider);
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

  list(): readonly ProviderAdapter[] {
    return [...this.#adapters.values()];
  }
}
