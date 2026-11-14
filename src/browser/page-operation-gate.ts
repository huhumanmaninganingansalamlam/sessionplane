import { KeyedMutex } from '../scheduler/keyed-mutex.ts';
import type { OwnedPageIdentity } from './owned-page-lifecycle.ts';

export type PageOperationMode = 'observe' | 'mutate';
export type PageOperationOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'busy' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unavailable'; readonly reason: 'timeout' | 'operation_error' }
  | { readonly kind: 'uncertain'; readonly reason: 'timeout' |
      'operation_error' | 'lease_changed_during_mutation' };

/**
 * Per-owned-target, not global, operation isolation. Timeouts release the
 * caller promptly without pretending that a CDP/browser command was canceled.
 * A timed-out mutation keeps its page lock until its underlying Promise
 * settles; unrelated pages retain their opportunity to progress.
 */
export class PageOperationGate {
  readonly #mutex: KeyedMutex;
  readonly #isExactLease: (lease: OwnedPageIdentity) => boolean;

  constructor(isExactLease: (lease: OwnedPageIdentity) => boolean, sharedMutex?: KeyedMutex) {
    this.#isExactLease = isExactLease;
    this.#mutex = sharedMutex ?? new KeyedMutex();
  }

  isBusy(pageKey: string): boolean {
    return this.#mutex.isBusy(pageKey);
  }

  async run<T>(
    lease: OwnedPageIdentity,
    mode: PageOperationMode,
    operation: () => Promise<T>,
    timeoutMs: number,
    /** A mutation may intentionally consume its exact lease by producing a
     * separately verified successor identity. The callback is evaluated only
     * after the operation and only when the original lease is no longer exact.
     */
    acceptMutationLeaseChange?: () => boolean,
  ): Promise<PageOperationOutcome<T>> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
      throw new Error('Invalid page operation deadline');
    }
    if (!this.#isExactLease(lease)) return { kind: 'stale' };
    if (this.#mutex.isBusy(lease.pageKey)) return { kind: 'busy' };

    return this.#mutex.runExclusive(lease.pageKey, async retainUntil => {
      if (!this.#isExactLease(lease)) return { kind: 'stale' };

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<PageOperationOutcome<T>>(resolve => {
        timeoutHandle = setTimeout(() => resolve(
          mode === 'mutate'
            ? { kind: 'uncertain', reason: 'timeout' }
            : { kind: 'unavailable', reason: 'timeout' },
        ), timeoutMs);
      });
      // All outcomes are converted to data, avoiding unhandled rejection if
      // the operation resolves after the client's wait deadline.
      const operationResult: Promise<PageOperationOutcome<T>> = Promise.resolve()
        .then(async () => {
          // runExclusive yields before execution; a revoked lease during that
          // microtask gap must never reach the browser mutation callback.
          if (!this.#isExactLease(lease)) return { kind: 'stale' } as const;
          const value = await operation();
          if (!this.#isExactLease(lease)) {
            let acceptedTransition = false;
            if (mode === 'mutate' && acceptMutationLeaseChange) {
              try { acceptedTransition = acceptMutationLeaseChange(); }
              catch { acceptedTransition = false; }
            }
            if (!acceptedTransition) {
              return mode === 'mutate'
                ? { kind: 'uncertain', reason: 'lease_changed_during_mutation' } as const
                : { kind: 'stale' } as const;
            }
          }
          return { kind: 'ok', value } as const;
        })
        .catch(() => mode === 'mutate'
          ? { kind: 'uncertain', reason: 'operation_error' } as const
          : { kind: 'unavailable', reason: 'operation_error' } as const);

      const outcome = await Promise.race([operationResult, timeout]);
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      if (outcome.kind === 'unavailable' && outcome.reason === 'timeout' ||
        outcome.kind === 'uncertain' && outcome.reason === 'timeout') {
        retainUntil(operationResult);
      }
      return outcome;
    });
  }
}
