import type { DatabaseSync } from 'node:sqlite';

export interface ProbeBudgetRecord {
  readonly scope: string;
  readonly nextAllowedAt: string | null;
  readonly blockedUntil: string | null;
  readonly backoffLevel: number;
  readonly consecutiveFailures: number;
  readonly updatedAt: string;
}

interface ProbeBudgetRow {
  readonly scope: string;
  readonly nextAllowedAt: string | null;
  readonly blockedUntil: string | null;
  readonly backoffLevel: number;
  readonly consecutiveFailures: number;
  readonly updatedAt: string;
}

export class ProbeBudgetRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  get(scope: string): ProbeBudgetRecord | null {
    const row = this.#database
      .prepare(`
        SELECT
          scope,
          next_allowed_at AS nextAllowedAt,
          blocked_until AS blockedUntil,
          backoff_level AS backoffLevel,
          consecutive_failures AS consecutiveFailures,
          updated_at AS updatedAt
        FROM probe_budget
        WHERE scope = ?
      `)
      .get(scope) as ProbeBudgetRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      ...row,
      backoffLevel: Number(row.backoffLevel),
      consecutiveFailures: Number(row.consecutiveFailures),
    };
  }

  save(record: ProbeBudgetRecord): void {
    this.#database
      .prepare(`
        INSERT INTO probe_budget(
          scope, next_allowed_at, blocked_until, backoff_level,
          consecutive_failures, lease_owner, lease_expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(scope) DO UPDATE SET
          next_allowed_at = excluded.next_allowed_at,
          blocked_until = excluded.blocked_until,
          backoff_level = excluded.backoff_level,
          consecutive_failures = excluded.consecutive_failures,
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = excluded.updated_at
      `)
      .run(
        record.scope,
        record.nextAllowedAt,
        record.blockedUntil,
        record.backoffLevel,
        record.consecutiveFailures,
        record.updatedAt,
      );
  }
}
