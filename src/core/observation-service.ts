import type { CurrentGenerationUpdate } from '../domain/generation.ts';
import { isTerminalSessionState, type SessionSnapshot } from '../domain/session.ts';
import type { Logger } from '../logging.ts';
import {
  type ProviderAdapterRegistry,
  type ProviderObservationEvidence,
  type ProviderObservationSource,
} from '../providers/provider-adapter.ts';
import { ExactFinalTracker, type ExactFinalDecision } from '../providers/chatgpt/exact-final.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { SessionRepository } from '../storage/session-repository.ts';

interface ObserverRuntime {
  readonly generation: number;
  readonly controller: AbortController;
  promise: Promise<void>;
}

export interface ObservationServiceOptions {
  readonly database: SessionPlaneDatabase;
  readonly scheduler: ActorScheduler;
  readonly adapters: ProviderAdapterRegistry;
  readonly activeSweepMs: number;
  readonly quietSweepMs: number;
  readonly quietWindowMs: number;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export class ObservationService {
  readonly #scheduler: ActorScheduler;
  readonly #adapters: ProviderAdapterRegistry;
  readonly #sessions: SessionRepository;
  readonly #activeSweepMs: number;
  readonly #quietSweepMs: number;
  readonly #quietWindowMs: number;
  readonly #logger: Logger | null;
  readonly #now: () => Date;
  readonly #runtimes = new Map<string, ObserverRuntime>();
  #closed = false;

  constructor(options: ObservationServiceOptions) {
    this.#scheduler = options.scheduler;
    this.#adapters = options.adapters;
    this.#sessions = new SessionRepository(options.database.raw);
    this.#activeSweepMs = options.activeSweepMs;
    this.#quietSweepMs = options.quietSweepMs;
    this.#quietWindowMs = options.quietWindowMs;
    this.#logger = options.logger ?? null;
    this.#now = options.now ?? (() => new Date());
  }

  get observerCount(): number {
    return this.#runtimes.size;
  }

  start(snapshot: SessionSnapshot): void {
    if (this.#closed || !isObservable(snapshot)) {
      return;
    }
    const existing = this.#runtimes.get(snapshot.sessionId);
    if (existing?.generation === snapshot.generation) {
      return;
    }
    existing?.controller.abort();

    const controller = new AbortController();
    const runtime: ObserverRuntime = {
      generation: snapshot.generation,
      controller,
      promise: Promise.resolve(),
    };
    this.#runtimes.set(snapshot.sessionId, runtime);
    runtime.promise = this.#run(snapshot, controller.signal)
      .catch((error: unknown) => {
        this.#logger?.warn('observation.loop-failed', {
          sessionId: snapshot.sessionId,
          generation: snapshot.generation,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      })
      .finally(() => {
        if (this.#runtimes.get(snapshot.sessionId) === runtime) {
          this.#runtimes.delete(snapshot.sessionId);
        }
      });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const runtimes = [...this.#runtimes.values()];
    for (const runtime of runtimes) {
      runtime.controller.abort();
    }
    await Promise.allSettled(runtimes.map((runtime) => runtime.promise));
    this.#runtimes.clear();
  }

  async #run(initial: SessionSnapshot, signal: AbortSignal): Promise<void> {
    const tracker = new ExactFinalTracker(this.#quietWindowMs);
    let source: ProviderObservationSource | null = null;
    try {
      while (!signal.aborted) {
        const current = this.#sessions.getSnapshot(initial.sessionId);
        if (
          current === null ||
          current.generation !== initial.generation ||
          isTerminalSessionState(current.sessionState)
        ) {
          return;
        }

        if (source === null) {
          try {
            const adapter = this.#adapters.require(current.provider);
            source = await adapter.openObservation({
              session: current,
              generation: current.generation,
            });
          } catch {
            await this.#recordUnavailable(current, 'dom-observer-open-failed');
            await waitForDelay(this.#quietSweepMs, signal);
            continue;
          }
        }

        let evidence: ProviderObservationEvidence;
        try {
          evidence = await source.observe();
        } catch {
          source.close();
          source = null;
          await this.#recordUnavailable(current, 'dom-observation-failed');
          await waitForDelay(this.#quietSweepMs, signal);
          continue;
        }

        const decision = tracker.evaluate(evidence, this.#now().getTime());
        const persisted = await this.#persistDecision(current, evidence, decision);
        if (persisted.terminal || decision.kind === 'complete') {
          return;
        }

        const sweepMs = decision.freshExactProgress
          ? this.#activeSweepMs
          : Math.min(this.#quietSweepMs, this.#quietWindowMs);
        await waitForWakeOrAbort(source, sweepMs, signal);
      }
    } finally {
      source?.close();
    }
  }

  async #persistDecision(
    previous: SessionSnapshot,
    evidence: ProviderObservationEvidence,
    decision: ExactFinalDecision,
  ): Promise<SessionSnapshot> {
    const update = updateForDecision(decision, evidence, this.#now().toISOString());
    if (!hasMeaningfulChange(previous, update)) {
      return previous;
    }
    return await this.#scheduler.updateGeneration(
      previous.sessionId,
      previous.generation,
      update,
      eventTypeForDecision(decision),
    );
  }

  async #recordUnavailable(snapshot: SessionSnapshot, reason: string): Promise<void> {
    const update: CurrentGenerationUpdate = {
      sessionState: 'observing',
      providerState: 'unknown',
      observationTransport: 'unavailable',
      reason,
      errorCode: null,
    };
    if (!hasMeaningfulChange(snapshot, update)) {
      return;
    }
    await this.#scheduler.updateGeneration(
      snapshot.sessionId,
      snapshot.generation,
      update,
      'generation.observation-unavailable',
    );
  }
}

function isObservable(snapshot: SessionSnapshot): boolean {
  return (
    !snapshot.terminal &&
    snapshot.generation > 0 &&
    snapshot.pageKey !== null &&
    snapshot.conversationId !== null &&
    (snapshot.submittedUserMessageId !== null || snapshot.submittedUserTurnId !== null)
  );
}

function updateForDecision(
  decision: ExactFinalDecision,
  evidence: ProviderObservationEvidence,
  now: string,
): CurrentGenerationUpdate {
  switch (decision.kind) {
    case 'complete':
      return {
        sessionState: 'complete',
        providerState: 'complete',
        observationTransport: 'fresh',
        responseMessageId: decision.responseMessageId,
        answerText: decision.answerText,
        completedAt: now,
        reason: decision.reason,
        errorCode: null,
      };
    case 'blocked':
      return {
        sessionState: 'observing',
        providerState: 'blocked',
        observationTransport: 'fresh',
        reason: decision.reason,
        errorCode: null,
      };
    case 'interstitial':
      return {
        sessionState: 'observing',
        providerState: 'unknown',
        observationTransport: 'fresh',
        reason: decision.reason,
        errorCode: 'provider.interstitial',
      };
    case 'progress':
      return {
        sessionState: 'observing',
        providerState: 'generating',
        observationTransport: evidence.observationTransport,
        reason: decision.reason,
        errorCode: null,
      };
    case 'pending':
      return {
        sessionState: 'observing',
        providerState: 'pending',
        observationTransport: evidence.observationTransport,
        reason: decision.reason,
        errorCode: null,
      };
    case 'unverified':
      return {
        sessionState: 'observing',
        providerState: 'unknown',
        observationTransport: evidence.observationTransport,
        reason: decision.reason,
        errorCode: null,
      };
  }
}

function eventTypeForDecision(decision: ExactFinalDecision): string {
  switch (decision.kind) {
    case 'complete':
      return 'generation.dom-complete';
    case 'blocked':
      return 'generation.provider-blocked';
    case 'interstitial':
      return 'generation.provider-interstitial';
    case 'progress':
      return 'generation.dom-progress';
    case 'pending':
      return 'generation.dom-pending';
    case 'unverified':
      return 'generation.dom-unverified';
  }
}

function hasMeaningfulChange(
  snapshot: SessionSnapshot,
  update: CurrentGenerationUpdate,
): boolean {
  return (
    (update.sessionState !== undefined && update.sessionState !== snapshot.sessionState) ||
    (update.providerState !== undefined && update.providerState !== snapshot.providerState) ||
    (update.observationTransport !== undefined &&
      update.observationTransport !== snapshot.observationTransport) ||
    (update.responseMessageId !== undefined &&
      update.responseMessageId !== snapshot.responseMessageId) ||
    (update.answerText !== undefined && update.answerText !== snapshot.answerText) ||
    (update.reason !== undefined && update.reason !== snapshot.reason) ||
    (update.errorCode !== undefined && update.errorCode !== snapshot.errorCode)
  );
}

async function waitForDelay(timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    const onAbort = (): void => finish();
    signal.addEventListener('abort', onAbort, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
  });
}

async function waitForWakeOrAbort(
  source: ProviderObservationSource,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    source.waitForWake(timeoutMs).then(finish, finish);
  });
}
