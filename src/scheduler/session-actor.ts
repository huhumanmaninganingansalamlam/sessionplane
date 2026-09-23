import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import { reduceWaitState } from '../core/wait-reducer.ts';

export interface SessionWaitSnapshot extends SessionSnapshot {
  readonly latestEventSequence: number;
}

export interface SessionWaitOptions {
  readonly waitMs: number;
  readonly afterRevision?: number;
  readonly expectedGeneration?: number;
  readonly signal?: AbortSignal;
}

interface Waiter {
  readonly afterRevision: number;
  readonly resolve: (snapshot: SessionWaitSnapshot) => void;
  readonly timer: NodeJS.Timeout;
  readonly cleanup: () => void;
}

export class SessionActor {
  readonly sessionId: string;
  #snapshot: SessionSnapshot;
  #revision: number;
  #tail: Promise<void> = Promise.resolve();
  #queueDepth = 0;
  #nextWaiterId = 1;
  readonly #waiters = new Map<number, Waiter>();
  readonly #onIdleTerminal: (() => void) | null;
  #closed = false;

  constructor(snapshot: SessionSnapshot, revision: number, onIdleTerminal?: () => void) {
    this.sessionId = snapshot.sessionId;
    this.#snapshot = snapshot;
    this.#revision = revision;
    this.#onIdleTerminal = onIdleTerminal ?? null;
  }

  get revision(): number {
    return this.#revision;
  }

  get queueDepth(): number {
    return this.#queueDepth;
  }

  get subscriberCount(): number {
    return this.#waiters.size;
  }

  snapshot(): SessionWaitSnapshot {
    return this.#decorate(this.#snapshot, false);
  }

  enqueue<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    if (this.#closed) {
      return Promise.reject(
        new SessionPlaneDomainError('browser.unavailable', `Session actor ${this.sessionId} is closed`),
      );
    }
    this.#queueDepth += 1;
    const scheduled = this.#tail.then(operation);
    this.#tail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled.finally(() => {
      this.#queueDepth -= 1;
      this.#retireIfIdleTerminal();
    });
  }

  publish(snapshot: SessionSnapshot, revision: number): void {
    if (snapshot.sessionId !== this.sessionId) {
      throw new SessionPlaneDomainError(
        'internal.invariant-violation',
        'Session actor received a snapshot for another session',
      );
    }
    if (snapshot.generation < this.#snapshot.generation) {
      throw new SessionPlaneDomainError(
        'session.generation-superseded',
        `Refusing generation ${snapshot.generation}; current generation is ${this.#snapshot.generation}`,
      );
    }
    if (
      snapshot.generation === this.#snapshot.generation &&
      this.#snapshot.terminal &&
      !snapshot.terminal
    ) {
      throw new SessionPlaneDomainError(
        'internal.invariant-violation',
        'A terminal generation cannot be downgraded',
      );
    }

    this.#snapshot = snapshot;
    this.#revision = Math.max(this.#revision, revision);
    for (const [waiterId, waiter] of this.#waiters) {
      if (snapshot.terminal || this.#revision > waiter.afterRevision) {
        clearTimeout(waiter.timer);
        waiter.cleanup();
        this.#waiters.delete(waiterId);
        waiter.resolve(this.#decorate(snapshot, false));
      }
    }
    this.#retireIfIdleTerminal();
  }

  async wait(options: SessionWaitOptions): Promise<SessionWaitSnapshot> {
    this.#assertGeneration(options.expectedGeneration);
    const afterRevision = options.afterRevision ?? this.#revision;
    if (this.#snapshot.terminal || this.#revision > afterRevision) {
      const snapshot = this.#decorate(this.#snapshot, false);
      this.#retireIfIdleTerminal();
      return snapshot;
    }
    if (options.waitMs <= 0 || this.#closed) {
      return this.#decorate(this.#snapshot, true);
    }

    return await new Promise<SessionWaitSnapshot>((resolve) => {
      const waiterId = this.#nextWaiterId;
      this.#nextWaiterId += 1;
      let settled = false;
      const finish = (waitExpired: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        const waiter = this.#waiters.get(waiterId);
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          waiter.cleanup();
          this.#waiters.delete(waiterId);
        }
        resolve(this.#decorate(this.#snapshot, waitExpired));
        this.#retireIfIdleTerminal();
      };
      const timer = setTimeout(() => {
        finish(true);
      }, options.waitMs);
      timer.unref?.();
      const onAbort = (): void => finish(true);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = (): void => options.signal?.removeEventListener('abort', onAbort);
      this.#waiters.set(waiterId, {
        afterRevision,
        resolve: () => finish(false),
        timer,
        cleanup,
      });
      if (options.signal?.aborted === true) {
        finish(true);
      }
    });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const [waiterId, waiter] of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.cleanup();
      this.#waiters.delete(waiterId);
      waiter.resolve(this.#decorate(this.#snapshot, true));
    }
  }

  #retireIfIdleTerminal(): void {
    if (
      !this.#closed &&
      this.#snapshot.terminal &&
      this.#queueDepth === 0 &&
      this.#waiters.size === 0
    ) {
      this.#onIdleTerminal?.();
    }
  }

  #assertGeneration(expectedGeneration: number | undefined): void {
    if (expectedGeneration !== undefined && expectedGeneration !== this.#snapshot.generation) {
      throw new SessionPlaneDomainError(
        'session.generation-superseded',
        `Expected generation ${expectedGeneration}; current generation is ${this.#snapshot.generation}`,
      );
    }
  }

  #decorate(snapshot: SessionSnapshot, waitExpired: boolean): SessionWaitSnapshot {
    const reduced = reduceWaitState({ snapshot, clientWaitExpired: waitExpired });
    return {
      ...reduced,
      latestEventSequence: this.#revision,
    };
  }
}

