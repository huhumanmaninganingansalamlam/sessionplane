import {
  ProviderSubmissionError,
  type ProviderAdapter,
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
} from '../../src/providers/provider-adapter.ts';

export type FakeAcknowledgementMode = 'success' | 'missing';

export class FakeProviderAdapter implements ProviderAdapter {
  readonly provider = 'chatgpt';
  acknowledgementMode: FakeAcknowledgementMode = 'success';
  submitThrows = false;
  readonly disabledModels = new Set<string>();
  openCount = 0;
  prepareCount = 0;
  submitCount = 0;
  acknowledgementCount = 0;
  bindCount = 0;
  observationOpenCount = 0;
  recoveryCount = 0;
  stopPrepareCount = 0;
  stopCount = 0;
  stopControlAvailable = true;
  stopThrows = false;
  readonly #observationSources = new Map<string, FakeObservationSource>();
  readonly #pendingObservations = new Map<
    string,
    Array<Partial<ProviderObservationEvidence>>
  >();
  readonly #recoveryResults = new Map<string, ProviderRecoveryResult[]>();

  async openSubmission(request: ProviderSubmissionRequest): Promise<ProviderSubmission> {
    this.openCount += 1;
    const adapter = this;
    const pageKey = `fake-page:${request.session.sessionId}`;
    return {
      provider: this.provider,
      pageKey,
      async prepare(): Promise<void> {
        adapter.prepareCount += 1;
        if (request.model !== null && adapter.disabledModels.has(request.model)) {
          throw new ProviderSubmissionError(
            'provider.model-unavailable',
            `Fake model is disabled: ${request.model}`,
          );
        }
      },
      async submitOnce(): Promise<void> {
        adapter.submitCount += 1;
        if (adapter.submitThrows) {
          throw new Error('Synthetic submit transport failure');
        }
      },
      async captureAcknowledgement(): Promise<ProviderSubmissionAcknowledgement | null> {
        adapter.acknowledgementCount += 1;
        if (adapter.acknowledgementMode === 'missing') {
          return null;
        }
        return {
          conversationId: `conversation-${request.session.sessionId}`,
          submittedUserMessageId: `user-message-${request.generation}`,
          submittedUserTurnId: `user-turn-${request.generation}`,
        };
      },
      bindAcknowledgement(): void {
        adapter.bindCount += 1;
      },
    };
  }

  async openObservation(request: ProviderObservationRequest): Promise<ProviderObservationSource> {
    this.observationOpenCount += 1;
    const source = new FakeObservationSource(request);
    this.#observationSources.set(request.session.sessionId, source);
    for (const observation of this.#pendingObservations.get(request.session.sessionId) ?? []) {
      source.emit(observation);
    }
    this.#pendingObservations.delete(request.session.sessionId);
    return source;
  }

  emitObservation(
    sessionId: string,
    observation: Partial<ProviderObservationEvidence>,
  ): void {
    const source = this.#observationSources.get(sessionId);
    if (source !== undefined) {
      source.emit(observation);
      return;
    }
    const pending = this.#pendingObservations.get(sessionId) ?? [];
    pending.push(observation);
    this.#pendingObservations.set(sessionId, pending);
  }

  queueRecovery(sessionId: string, result: ProviderRecoveryResult): void {
    const queue = this.#recoveryResults.get(sessionId) ?? [];
    queue.push(result);
    this.#recoveryResults.set(sessionId, queue);
  }

  async recover(request: ProviderRecoveryRequest): Promise<ProviderRecoveryResult> {
    this.recoveryCount += 1;
    const queue = this.#recoveryResults.get(request.session.sessionId);
    const result = queue?.shift();
    if (queue !== undefined && queue.length === 0) {
      this.#recoveryResults.delete(request.session.sessionId);
    }
    return result ?? {
      kind: 'pending',
      observationTransport: 'fresh',
      responseMessageId: null,
      answerText: null,
      reason: 'fake-backend-pending',
      retryAfterMs: null,
      nextCheckAt: null,
    };
  }

  async openStop(request: ProviderStopRequest): Promise<ProviderStopOperation> {
    const adapter = this;
    return {
      provider: this.provider,
      pageKey: request.session.pageKey ?? `fake-page:${request.session.sessionId}`,
      async prepare(): Promise<boolean> {
        adapter.stopPrepareCount += 1;
        return adapter.stopControlAvailable;
      },
      async stopOnce(): Promise<void> {
        adapter.stopCount += 1;
        if (adapter.stopThrows) {
          throw new Error('Synthetic stop acknowledgement failure');
        }
      },
    };
  }
}

class FakeObservationSource implements ProviderObservationSource {
  readonly provider = 'chatgpt';
  readonly pageKey: string;
  readonly #request: ProviderObservationRequest;
  readonly #queue: ProviderObservationEvidence[] = [];
  readonly #waiters = new Set<(reason: ProviderWakeReason) => void>();
  #closed = false;

  constructor(request: ProviderObservationRequest) {
    this.#request = request;
    this.pageKey = request.session.pageKey ?? `fake-page:${request.session.sessionId}`;
  }

  async observe(): Promise<ProviderObservationEvidence> {
    return this.#queue.shift() ?? this.#baseEvidence();
  }

  async waitForWake(timeoutMs: number): Promise<ProviderWakeReason> {
    if (this.#closed || this.#queue.length > 0) {
      return this.#closed ? 'timer' : 'dom';
    }
    return await new Promise<ProviderWakeReason>((resolve) => {
      let settled = false;
      const finish = (reason: ProviderWakeReason): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.#waiters.delete(finish);
        resolve(reason);
      };
      const timer = setTimeout(() => finish('timer'), timeoutMs);
      timer.unref?.();
      this.#waiters.add(finish);
    });
  }

  emit(overrides: Partial<ProviderObservationEvidence>): void {
    if (this.#closed) {
      return;
    }
    this.#queue.push({ ...this.#baseEvidence(), ...overrides });
    for (const waiter of [...this.#waiters]) {
      waiter('dom');
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of [...this.#waiters]) {
      waiter('timer');
    }
  }

  #baseEvidence(): ProviderObservationEvidence {
    return {
      provider: this.provider,
      pageKey: this.pageKey,
      bindingEpoch: 1,
      observedAt: new Date().toISOString(),
      conversationId: this.#request.session.conversationId,
      submittedUserFound: true,
      laterUserFound: false,
      candidate: null,
      activity: 'none',
      dialogKind: null,
      networkActivity: false,
      observationTransport: 'fresh',
      reason: null,
    };
  }
}

