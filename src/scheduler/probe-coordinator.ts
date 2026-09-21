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
  readonly #tails = new Map<string, Promise<void>>();

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
  ): Promise<ProviderRecoveryResult> {
    const normalizedScope = scope.trim();
    if (normalizedScope.length === 0) {
      return Promise.reject(new Error('Probe scope must not be empty'));
    }
    const previous = this.#tails.get(normalizedScope) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#tails.set(normalizedScope, tail);

    return previous
      .catch(() => undefined)
      .then(() => this.#run(normalizedScope, operation))
      .finally(() => {
        release();
        if (this.#tails.get(normalizedScope) === tail) {
          this.#tails.delete(normalizedScope);
        }
      });
  }

  #run(
    scope: string,
    operation: () => Promise<ProviderRecoveryResult>,
  ): Promise<ProviderRecoveryResult> {
    const now = this.#now();
    const budget = this.#budgets.get(scope);
    const earliest = latestTimestamp(budget?.nextAllowedAt ?? null, budget?.blockedUntil ?? null);
    if (earliest !== null && Date.parse(earliest) > now.getTime()) {
      this.#metrics?.increment('backend_probe_deferred_total');
      return Promise.resolve({
        kind: 'deferred',
        observationTransport: 'deferred',
        responseMessageId: null,
        answerText: null,
        reason: 'probe-paced',
        retryAfterMs: Math.max(0, Date.parse(earliest) - now.getTime()),
        nextCheckAt: earliest,
      });
    }
    return this.#execute(scope, budget?.backoffLevel ?? 0, budget?.consecutiveFailures ?? 0, operation);
  }

  async #execute(
    scope: string,
    backoffLevel: number,
    consecutiveFailures: number,
    operation: () => Promise<ProviderRecoveryResult>,
  ): Promise<ProviderRecoveryResult> {
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
      const backoffMs = this.#jitter(rawBackoff);
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

    const nextAllowedAt = new Date(now.getTime() + this.#successIntervalMs).toISOString();
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
      this.#budgets.save({
        scope,
        nextAllowedAt,
        blockedUntil,
        backoffLevel,
        consecutiveFailures,
        updatedAt: now.toISOString(),
      });
    });
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
