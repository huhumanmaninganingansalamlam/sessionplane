import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionPlaneDomainError } from '../domain/errors.ts';

/** One bounded, process-local handover lease. It never changes request state. */
export class CoreMaintenance {
  #phase: 'running' | 'draining' | 'ready' = 'running';
  #token: string | null = null;
  #expiresAt: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active = 0;
  get paused(): boolean { return this.#phase !== 'running'; }
  status() { return { phase: this.#phase, activeOperations: this.#active, expiresAt: this.#expiresAt }; }

  enter(): (() => void) | null {
    if (this.paused) return null;
    this.#active++;
    let released = false;
    return () => { if (!released) { released = true; this.#active--; } };
  }
  async rpc<T>(operation: () => T | Promise<T>): Promise<T> {
    const release = this.enter();
    if (!release) throw this.#error('Core handover is draining; preserve and resume the same request');
    try { return await operation(); } finally { release(); }
  }
  track<T>(operation: Promise<T>): Promise<T> {
    this.#active++;
    return operation.finally(() => { this.#active--; });
  }
  /** Passive browser events are not dropped. A late writer revokes readiness before writing. */
  callback(operation: () => void): void {
    if (this.#phase === 'ready') this.resume();
    operation();
  }
  async wait(signal: AbortSignal): Promise<void> {
    while (this.paused && !signal.aborted) {
      await delay(20, undefined, { signal }).catch(() => undefined);
    }
  }
  async prepare(drainTimeoutMs: number, leaseMs: number, idle: () => boolean) {
    if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 10_000 ||
        !Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 60_000) throw this.#error('Invalid bounded maintenance interval');
    if (this.paused) throw this.#error('An existing handover lease must expire or be released first');
    const token = randomUUID();
    this.#token = token;
    this.#phase = 'draining';
    // The total interval, including draining, is bounded even if the caller disappears.
    this.#expiresAt = Date.now() + leaseMs;
    this.#timer = setTimeout(() => this.resume(), leaseMs);
    this.#timer.unref();
    const deadline = Math.min(Date.now() + drainTimeoutMs, this.#expiresAt);
    try {
      while (true) {
        if (this.#token !== token || Date.now() >= deadline) throw this.#error('Maintenance drain expired; normal operation resumed');
        if (this.#active === 0 && idle()) {
          this.#phase = 'ready';
          return { ...this.status(), token };
        }
        await delay(10);
      }
    } catch (error) {
      if (this.#token === token) this.resume();
      throw error;
    }
  }
  resume(token?: string): void {
    if (token !== undefined && token !== this.#token) throw this.#error('Stale maintenance lease');
    clearTimeout(this.#timer);
    this.#token = null;
    this.#expiresAt = null;
    this.#phase = 'running';
  }
  /** Validation and the terminal action have no awaited gap on the core event loop. */
  commit(token: string, idle: () => boolean, exit: () => never): never {
    if (token !== this.#token || this.#phase !== 'ready' ||
        this.#expiresAt === null || Date.now() >= this.#expiresAt || this.#active !== 0 || !idle()) {
      if (token === this.#token) this.resume();
      throw this.#error('Maintenance readiness changed; core preserved');
    }
    return exit();
  }
  #error(message: string) { return new SessionPlaneDomainError('core.maintenance', message); }
}
