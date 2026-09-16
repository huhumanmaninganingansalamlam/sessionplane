import type { DatabaseSync } from 'node:sqlite';

import type { SessionPlaneEvent } from '../domain/events.ts';

interface EventRow {
  readonly sequence: number;
  readonly teamId: string;
  readonly roleId: string | null;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly createdAt: string;
}

export interface AppendEventInput {
  readonly teamId: string;
  readonly roleId?: string | null;
  readonly sessionId?: string | null;
  readonly generation?: number | null;
  readonly eventType: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export class EventRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  append(input: AppendEventInput): number {
    const result = this.#database
      .prepare(`
        INSERT INTO events(
          team_id, role_id, session_id, generation, event_type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.teamId,
        input.roleId ?? null,
        input.sessionId ?? null,
        input.generation ?? null,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        input.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  latestSequence(teamId: string): number {
    const row = this.#database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE team_id = ?')
      .get(teamId) as { sequence: number };
    return Number(row.sequence);
  }

  list(teamId: string, afterSequence: number, limit: number): readonly SessionPlaneEvent[] {
    const rows = this.#database
      .prepare(`
        SELECT
          sequence,
          team_id AS teamId,
          role_id AS roleId,
          session_id AS sessionId,
          generation,
          event_type AS eventType,
          payload_json AS payloadJson,
          created_at AS createdAt
        FROM events
        WHERE team_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT ?
      `)
      .all(teamId, afterSequence, limit) as unknown as EventRow[];
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      teamId: row.teamId,
      roleId: row.roleId,
      sessionId: row.sessionId,
      generation: row.generation === null ? null : Number(row.generation),
      eventType: row.eventType,
      payload: parsePayload(row.payloadJson),
      createdAt: row.createdAt,
    }));
  }
}

function parsePayload(value: string): Readonly<Record<string, unknown>> {
  const parsed = JSON.parse(value) as unknown;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Readonly<Record<string, unknown>>
    : {};
}

