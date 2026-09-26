import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';

import type { SessionPlaneDatabase } from './database.ts';

export const OUTBOX_STATES = [
  'prepared',
  'composer_filled',
  'submit_attempted',
  'submitted',
  'submission_unknown',
  'failed_pre_submit',
] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

export interface OutboxRecord {
  readonly outboxId: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly teamId: string;
  readonly roleId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly payloadJson: string;
  readonly submissionState: OutboxState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly requestHash: string;
  readonly resultJson: string | null;
  readonly errorCode: string | null;
  readonly promptSubmitted: boolean;
}

interface OutboxRow extends Omit<OutboxRecord, 'promptSubmitted'> {
  readonly promptSubmitted: number;
}

export interface InsertOutboxInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly teamId: string;
  readonly roleId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly payloadJson: string;
  readonly requestHash: string;
  readonly createdAt: string;
}

export class OutboxRepository {
  readonly #database: SessionPlaneDatabase;

  constructor(database: SessionPlaneDatabase) {
    this.#database = database;
  }

  insert(input: InsertOutboxInput): OutboxRecord {
    const outboxId = randomUUID();
    this.#database.raw
      .prepare(`
        INSERT INTO outbox(
          outbox_id, client_id, request_id, team_id, role_id, session_id,
          generation, payload_json, submission_state, created_at, updated_at,
          request_hash, result_json, error_code, prompt_submitted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, NULL, NULL, 0)
      `)
      .run(
        outboxId,
        input.clientId,
        input.requestId,
        input.teamId,
        input.roleId,
        input.sessionId,
        input.generation,
        input.payloadJson,
        input.createdAt,
        input.createdAt,
        input.requestHash,
      );
    return this.requireById(outboxId);
  }

  getByRequest(clientId: string, requestId: string): OutboxRecord | null {
    const row = this.#database.raw
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE client_id = ? AND request_id = ?`)
      .get(clientId, requestId) as OutboxRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  getByGeneration(sessionId: string, generation: number): OutboxRecord | null {
    const row = this.#database.raw
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE session_id = ? AND generation = ?`)
      .get(sessionId, generation) as OutboxRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  getById(outboxId: string): OutboxRecord | null {
    const row = this.#database.raw.prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE outbox_id = ?`)
      .get(outboxId) as OutboxRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  listForTeam(teamId: string) {
    // One compact row per conversation, including replaced conversations needing cleanup.
    return this.#database.raw.prepare(`SELECT o.outbox_id AS requestRef, o.request_id AS requestId,
      o.session_id AS sessionId, o.generation, o.role_id AS roleId, o.submission_state AS submissionState,
      s.session_state AS sessionState, s.provider_state AS providerState, o.error_code AS errorCode
      FROM outbox o JOIN sessions s ON s.session_id = o.session_id AND s.current_generation = o.generation
      WHERE o.team_id = ? ORDER BY o.created_at, o.outbox_id`).all(teamId);
  }

  historyForTeam(teamId: string, before?: OutboxRecord) {
    const rows = this.#database.raw.prepare(`SELECT o.outbox_id AS requestRef, o.request_id AS requestId,
      o.session_id AS sessionId, o.generation, o.role_id AS roleId,
      o.submission_state AS submissionState, g.error_code AS errorCode, g.completed_at AS completedAt,
      g.response_message_id AS responseMessageId
      FROM outbox o JOIN generations g ON g.session_id = o.session_id AND g.generation = o.generation
      WHERE o.team_id = ? AND (? IS NULL OR (o.created_at, o.outbox_id) < (?, ?))
      ORDER BY o.created_at DESC, o.outbox_id DESC LIMIT 51`)
      .all(teamId, before?.createdAt ?? null, before?.createdAt ?? null, before?.outboxId ?? null);
    const requests = rows.slice(0, 50);
    return { requests, nextRequestRef: rows.length > 50 ? requests.at(-1)!.requestRef : null };
  }

  requireById(outboxId: string): OutboxRecord {
    const row = this.#database.raw
      .prepare(`SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE outbox_id = ?`)
      .get(outboxId) as OutboxRow | undefined;
    if (row === undefined) {
      throw new Error(`Unknown outbox row: ${outboxId}`);
    }
    return mapRow(row);
  }

  listByStates(states: readonly OutboxState[]): readonly OutboxRecord[] {
    if (states.length === 0) {
      return [];
    }
    const placeholders = states.map(() => '?').join(', ');
    const rows = this.#database.raw
      .prepare(`
        SELECT ${OUTBOX_COLUMNS}
        FROM outbox
        WHERE submission_state IN (${placeholders})
        ORDER BY created_at, outbox_id
      `)
      .all(...states) as unknown as OutboxRow[];
    return rows.map((row) => mapRow(row));
  }

  transition(
    outboxId: string,
    expected: readonly OutboxState[],
    next: OutboxState,
    input: {
      readonly updatedAt: string;
      readonly resultJson?: string | null;
      readonly errorCode?: string | null;
      readonly promptSubmitted?: boolean;
    },
  ): boolean {
    if (expected.length === 0) {
      return false;
    }
    const assignments = ['submission_state = ?', 'updated_at = ?'];
    const values: SQLInputValue[] = [next, input.updatedAt];
    append(assignments, values, 'result_json', input.resultJson);
    append(assignments, values, 'error_code', input.errorCode);
    append(
      assignments,
      values,
      'prompt_submitted',
      input.promptSubmitted === undefined ? undefined : input.promptSubmitted ? 1 : 0,
    );
    const placeholders = expected.map(() => '?').join(', ');
    const result = this.#database.raw
      .prepare(`
        UPDATE outbox
        SET ${assignments.join(', ')}
        WHERE outbox_id = ? AND submission_state IN (${placeholders})
      `)
      .run(...values, outboxId, ...expected);
    return Number(result.changes) === 1;
  }
}

const OUTBOX_COLUMNS = `
  outbox_id AS outboxId,
  client_id AS clientId,
  request_id AS requestId,
  team_id AS teamId,
  role_id AS roleId,
  session_id AS sessionId,
  generation,
  payload_json AS payloadJson,
  submission_state AS submissionState,
  created_at AS createdAt,
  updated_at AS updatedAt,
  request_hash AS requestHash,
  result_json AS resultJson,
  error_code AS errorCode,
  prompt_submitted AS promptSubmitted
`;

function mapRow(row: OutboxRow): OutboxRecord {
  return {
    ...row,
    generation: Number(row.generation),
    promptSubmitted: Number(row.promptSubmitted) === 1,
  };
}

function append(
  assignments: string[],
  values: SQLInputValue[],
  column: string,
  value: SQLInputValue | undefined,
): void {
  if (value === undefined) {
    return;
  }
  assignments.push(`${column} = ?`);
  values.push(value);
}

