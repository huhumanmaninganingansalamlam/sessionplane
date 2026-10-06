import { KeyedMutex } from './keyed-mutex.ts';
import type { ProviderRecoveryResult } from '../providers/provider-adapter.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { ProbeBudgetRepository } from '../storage/probe-budget-repository.ts';
import type { RuntimeMetrics } from '../telemetry/metrics.ts';

export interface ProbeCoordinatorOptions {
  readonly database: SessionPlaneDatabase;
  readonly successIntervalMs: number;
  readonly min429BackoffMs: number;
  readonly max429BackoffMs: number;
  readonly jitterRatio?: number;
  readonly now?: () => Date;
  readonly random?: () => number;
  readonly metrics?: RuntimeMetrics;
}

export class ProbeCoordinator {
  readonly #database: SessionPlaneDatabase;
  readonly #budgets: ProbeBudgetRepository;
  readonly #successIntervalMs: number;
  readonly #min429BackoffMs: number;
  readonly #max429BackoffMs: number;
  readonly #jitterRatio: number;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #metrics: RuntimeMetrics | null;
  readonly #mutex = new KeyedMutex();
  readonly #waiting = new Map<string, Set<symbol>>();

  constructor(options: ProbeCoordinatorOptions) {
    if (options.min429BackoffMs > options.max429BackoffMs) {
      throw new Error('min429BackoffMs must not exceed max429BackoffMs');
    }
    this.#database = options.database;
    this.#budgets = new ProbeBudgetRepository(options.database.raw);
    this.#successIntervalMs = options.successIntervalMs;
    this.#min429BackoffMs = options.min429BackoffMs;
    this.#max429BackoffMs = options.max429BackoffMs;
    this.#jitterRatio = options.jitterRatio ?? 0.1;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#metrics = options.metrics ?? null;
  }

  run(
    scope: string,
    operation: () => Promise<ProviderRecoveryResult>,
    caller?: symbol,
    minimumIntervalMs = 0,
  ): Promise<ProviderRecoveryResult> {
    const normalizedScope = scope.trim();
    if (normalizedScope.length === 0) {
      return Promise.reject(new Error('Probe scope must not be empty'));
    }
    return this.#mutex.runExclusive(normalizedScope, () => this.#run(normalizedScope, operation, caller, minimumIntervalMs));
  }

  withdraw(scope: string, caller: symbol): void {
    const waiting = this.#waiting.get(scope);
    waiting?.delete(caller);
    if (waiting?.size === 0) this.#waiting.delete(scope);
  }

  #run(
    scope: string,
    operation: () => Promise<ProviderRecoveryResult>,
    caller?: symbol,
    minimumIntervalMs = 0,
  ): Promise<ProviderRecoveryResult> {
    const now = this.#now();
    const budget = this.#budgets.get(scope);
    const earliest = latestTimestamp(budget?.nextAllowedAt ?? null, budget?.blockedUntil ?? null);
    if (caller !== undefined) {
      const waiting = this.#waiting.get(scope) ?? new Set<symbol>();
      waiting.add(caller);
      this.#waiting.set(scope, waiting);
    }
    const coolingDown = earliest !== null && Date.parse(earliest) > now.getTime();
    const waitingForTurn = caller !== undefined && this.#waiting.get(scope)?.values().next().value !== caller;
    if (coolingDown || waitingForTurn) {
      const nextCheckAt = coolingDown ? earliest! : new Date(now.getTime() + Math.max(1, this.#successIntervalMs)).toISOString();
      this.#metrics?.increment('backend_probe_deferred_total');
      return Promise.resolve({
        kind: 'deferred',
        observationTransport: 'deferred',
        responseMessageId: null,
        answerText: null,
        reason: waitingForTurn && !coolingDown ? 'probe-queued' : 'probe-paced',
        retryAfterMs: Math.max(0, Date.parse(nextCheckAt) - now.getTime()),
        nextCheckAt,
      });
    }
    return this.#execute(scope, budget?.backoffLevel ?? 0, budget?.consecutiveFailures ?? 0, operation, minimumIntervalMs)
      .finally(() => { if (caller !== undefined) this.withdraw(scope, caller); });
  }

  async #execute(
    scope: string,
    backoffLevel: number,
    consecutiveFailures: number,
    operation: () => Promise<ProviderRecoveryResult>,
    minimumIntervalMs = 0,
  ): Promise<ProviderRecoveryResult> {
    // Reserve UI load-recovery spacing before its side effect, including across an owner restart.
    if (minimumIntervalMs > 0) {
      const now = this.#now();
      this.#save(scope, new Date(now.getTime() + minimumIntervalMs).toISOString(), null, backoffLevel, consecutiveFailures, now);
    }
    this.#metrics?.increment('backend_probe_total');
    let result: ProviderRecoveryResult;
    try {
      result = await operation();
    } catch {
      result = {
        kind: 'unavailable',
        observationTransport: 'unavailable',
        responseMessageId: null,
        answerText: null,
        reason: 'backend-probe-failed',
        retryAfterMs: null,
        nextCheckAt: null,
      };
    }

    const now = this.#now();
    if (result.kind === 'deferred' && result.reason === 'backend-http-429') {
      this.#metrics?.increment('backend_probe_429_total');
      this.#metrics?.increment('backend_probe_deferred_total');
      const rawBackoff = Math.max(
        result.retryAfterMs ?? 0,
        Math.min(this.#max429BackoffMs, this.#min429BackoffMs * 2 ** backoffLevel),
      );
      const backoffMs = Math.max(result.retryAfterMs ?? 0, this.#jitter(rawBackoff));
      const nextCheckAt = new Date(now.getTime() + backoffMs).toISOString();
      this.#save(scope, nextCheckAt, nextCheckAt, backoffLevel + 1, consecutiveFailures + 1, now);
      return { ...result, retryAfterMs: backoffMs, nextCheckAt };
    }

    if (result.kind === 'unavailable') {
      const failureLevel = Math.min(consecutiveFailures, 5);
      const retryMs = Math.min(
        this.#max429BackoffMs,
        this.#successIntervalMs * 2 ** failureLevel,
      );
      const nextCheckAt = new Date(now.getTime() + this.#jitter(retryMs)).toISOString();
      this.#save(scope, nextCheckAt, null, 0, consecutiveFailures + 1, now);
      return {
        ...result,
        retryAfterMs: Date.parse(nextCheckAt) - now.getTime(),
        nextCheckAt,
      };
    }

    if (result.kind === 'deferred') {
      this.#metrics?.increment('backend_probe_deferred_total');
    }

    const nextAllowedAt = new Date(now.getTime() + Math.max(this.#successIntervalMs, minimumIntervalMs)).toISOString();
    this.#save(scope, nextAllowedAt, null, 0, 0, now);
    return { ...result, nextCheckAt: result.nextCheckAt ?? nextAllowedAt };
  }

  #save(
    scope: string,
    nextAllowedAt: string | null,
    blockedUntil: string | null,
    backoffLevel: number,
    consecutiveFailures: number,
    now: Date,
  ): void {
    this.#database.transaction(() => {
      const existing = this.#budgets.get(scope);
      this.#budgets.save({
        scope,
        nextAllowedAt: latestTimestamp(nextAllowedAt, existing?.nextAllowedAt ?? null),
        blockedUntil: latestTimestamp(blockedUntil, existing?.blockedUntil ?? null),
        backoffLevel,
        consecutiveFailures,
        updatedAt: now.toISOString(),
      });
    });
  }

  defer(scope: string, until: string): void {
    const prior = this.#budgets.get(scope);
    this.#save(scope, until, until, prior?.backoffLevel ?? 0, prior?.consecutiveFailures ?? 0, this.#now());
  }

  #jitter(valueMs: number): number {
    if (this.#jitterRatio <= 0) {
      return Math.max(1, Math.round(valueMs));
    }
    const factor = 1 + (this.#random() * 2 - 1) * this.#jitterRatio;
    return Math.max(1, Math.round(valueMs * factor));
  }
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
