import { createHash } from 'node:crypto';

import type { SessionPlaneDatabase } from './database.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';

interface ReceiptRow {
  readonly clientId: string;
  readonly requestId: string;
  readonly method: string;
  readonly requestHash: string;
  readonly status: string;
  readonly resultJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExecuteReceiptInput<Result> {
  readonly clientId: string;
  readonly requestId: string;
  readonly method: string;
  readonly payload: unknown;
  readonly operation: () => Result;
}

export class ReceiptRepository {
  readonly #database: SessionPlaneDatabase;
  readonly #now: () => Date;

  constructor(database: SessionPlaneDatabase, options: { readonly now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  execute<Result>(input: ExecuteReceiptInput<Result>): Result {
    const clientId = requireIdentity(input.clientId, 'clientId');
    const requestId = requireIdentity(input.requestId, 'requestId');
    const method = requireIdentity(input.method, 'method');
    const requestHash = hashCanonical({ method, payload: input.payload });

    return this.#database.transaction(() => {
      const existing = this.get(clientId, requestId);
      if (existing !== null) {
        if (existing.method !== method || existing.requestHash !== requestHash) {
          throw new SessionPlaneDomainError(
            'input.idempotency-conflict',
            `Request ${clientId}/${requestId} was already used with a different method or payload`,
          );
        }
        if (existing.status !== 'complete') {
          throw new SessionPlaneDomainError(
            'internal.invariant-violation',
            `Request receipt ${clientId}/${requestId} is not complete`,
          );
        }
        return parseResult<Result>(existing.resultJson);
      }

      const result = input.operation();
      const timestamp = this.#now().toISOString();
      const resultJson = serializeResult(result);
      this.#database.raw
        .prepare(`
          INSERT INTO request_receipts(
            client_id, request_id, method, result_json, created_at,
            request_hash, status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'complete', ?)
        `)
        .run(clientId, requestId, method, resultJson, timestamp, requestHash, timestamp);
      return result;
    });
  }

  record(input: { clientId: string; requestId: string; method: string; requestHash: string;
    status: 'attempted' | 'complete'; result: unknown }): void {
    const timestamp = this.#now().toISOString();
    const written = this.#database.raw.prepare(`
      INSERT INTO request_receipts(client_id, request_id, method, request_hash, status, result_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id, request_id) DO UPDATE SET
        status = excluded.status, result_json = excluded.result_json, updated_at = excluded.updated_at
      WHERE request_receipts.method = excluded.method AND request_receipts.request_hash = excluded.request_hash
    `).run(input.clientId, input.requestId, input.method, input.requestHash, input.status,
      serializeResult(input.result), timestamp, timestamp);
    if (Number(written.changes) !== 1) {
      throw new SessionPlaneDomainError('input.idempotency-conflict', 'Request identity already belongs to another operation');
    }
  }

  findConversationDeletion(conversationId: string): ReceiptRow | null {
    const row = this.#database.raw.prepare(`
      SELECT client_id AS clientId, request_id AS requestId FROM request_receipts
      WHERE method = 'session.delete' AND json_extract(result_json, '$.conversationId') = ?
        AND (status = 'attempted' OR json_extract(result_json, '$.deleted') = 1)
      ORDER BY updated_at DESC LIMIT 1
    `).get(conversationId) as { clientId: string; requestId: string } | undefined;
    return row === undefined ? null : this.get(row.clientId, row.requestId);
  }

  get(clientId: string, requestId: string): ReceiptRow | null {
    const row = this.#database.raw
      .prepare(`
        SELECT
          client_id AS clientId,
          request_id AS requestId,
          method,
          request_hash AS requestHash,
          status,
          result_json AS resultJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM request_receipts
        WHERE client_id = ? AND request_id = ?
      `)
      .get(clientId, requestId) as ReceiptRow | undefined;
    return row ?? null;
  }
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value, new Set<object>()));
}

function normalizeJson(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new SessionPlaneDomainError('input.invalid', 'Request payload contains a non-finite number');
    }
    return value;
  }
  if (typeof value === 'undefined') {
    throw new SessionPlaneDomainError('input.invalid', 'Request payload contains undefined');
  }
  if (typeof value !== 'object') {
    throw new SessionPlaneDomainError(
      'input.invalid',
      `Request payload contains unsupported type: ${typeof value}`,
    );
  }
  if (seen.has(value)) {
    throw new SessionPlaneDomainError('input.invalid', 'Request payload contains a cycle');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeJson(entry, seen));
    }
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, normalizeJson(object[key], seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

function serializeResult(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) {
    throw new SessionPlaneDomainError(
      'internal.invariant-violation',
      'Idempotent mutation returned a non-serializable result',
    );
  }
  return result;
}

function parseResult<Result>(value: string): Result {
  try {
    return JSON.parse(value) as Result;
  } catch (error) {
    throw new SessionPlaneDomainError(
      'internal.invariant-violation',
      'Stored request receipt contains invalid JSON',
      error,
    );
  }
}

function requireIdentity(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new SessionPlaneDomainError('input.invalid', `${name} must not be empty`);
  }
  return normalized;
}

