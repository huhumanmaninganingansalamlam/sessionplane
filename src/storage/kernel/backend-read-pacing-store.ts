import { requireNonempty } from './row-codecs.ts';
import type { KernelTransactionContext } from './transaction-context.ts';

export class BackendReadPacingStore {
  readonly #context: KernelTransactionContext;

  constructor(context: KernelTransactionContext) {
    this.#context = context;
  }

  readBackendReadFence(providerKey: string, origin: string): number {
    requireNonempty(providerKey, 'providerKey');
    requireNonempty(origin, 'origin');
    const row = this.#context.database.raw.prepare(
      'SELECT next_allowed_at_ms AS nextAllowedAtMs FROM kernel_backend_read_pacing' +
      ' WHERE provider_key=? AND endpoint_origin=?',
    ).get(providerKey, origin) as { nextAllowedAtMs: number } | undefined;
    return row?.nextAllowedAtMs ?? 0;
  }

  extendBackendReadFence(providerKey: string, origin: string, atMs: number): number {
    requireNonempty(providerKey, 'providerKey');
    requireNonempty(origin, 'origin');
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      throw new Error('Backend pacing timestamp must be a nonnegative safe integer');
    }
    this.#context.database.raw.prepare(
      'INSERT INTO kernel_backend_read_pacing' +
      ' (provider_key,endpoint_origin,next_allowed_at_ms,updated_at) VALUES(?,?,?,?)' +
      ' ON CONFLICT(provider_key,endpoint_origin) DO UPDATE SET' +
      ' next_allowed_at_ms=excluded.next_allowed_at_ms,updated_at=excluded.updated_at' +
      ' WHERE excluded.next_allowed_at_ms > kernel_backend_read_pacing.next_allowed_at_ms',
    ).run(providerKey, origin, atMs, this.#context.now());
    return this.readBackendReadFence(providerKey, origin);
  }
}
