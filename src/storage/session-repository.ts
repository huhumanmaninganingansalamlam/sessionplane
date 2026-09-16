import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type {
  ObservationTransport,
  ProviderState,
  SessionRecord,
  SessionSnapshot,
  SessionState,
} from '../domain/session.ts';
import { isTerminalSessionState } from '../domain/session.ts';
import type {
  CurrentGenerationUpdate,
  GenerationRecord,
  SubmissionState,
} from '../domain/generation.ts';

interface SessionRow {
  readonly sessionId: string;
  readonly teamId: string;
  readonly roleId: string;
  readonly provider: string;
  readonly predecessorSessionId: string | null;
  readonly sessionState: SessionState;
  readonly providerState: ProviderState;
  readonly observationTransport: ObservationTransport;
  readonly currentGeneration: number;
  readonly conversationId: string | null;
  readonly pageKey: string | null;
  readonly deadlineAt: string | null;
  readonly nextCheckAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SnapshotRow extends SessionRow {
  readonly roleKey: string;
  readonly submittedUserMessageId: string | null;
  readonly submittedUserTurnId: string | null;
  readonly responseMessageId: string | null;
  readonly answerText: string | null;
}

const SESSION_COLUMNS = `
  session_id AS sessionId,
  team_id AS teamId,
  role_id AS roleId,
  provider,
  predecessor_session_id AS predecessorSessionId,
  session_state AS sessionState,
  provider_state AS providerState,
  observation_transport AS observationTransport,
  current_generation AS currentGeneration,
  conversation_id AS conversationId,
  page_key AS pageKey,
  deadline_at AS deadlineAt,
  next_check_at AS nextCheckAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const QUALIFIED_SESSION_COLUMNS = `
  s.session_id AS sessionId,
  s.team_id AS teamId,
  s.role_id AS roleId,
  s.provider AS provider,
  s.predecessor_session_id AS predecessorSessionId,
  s.session_state AS sessionState,
  s.provider_state AS providerState,
  s.observation_transport AS observationTransport,
  s.current_generation AS currentGeneration,
  s.conversation_id AS conversationId,
  s.page_key AS pageKey,
  s.deadline_at AS deadlineAt,
  s.next_check_at AS nextCheckAt,
  s.created_at AS createdAt,
  s.updated_at AS updatedAt
`;

export class SessionRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  insertSession(session: SessionRecord): void {
    this.#database
      .prepare(`
        INSERT INTO sessions(
          session_id, team_id, role_id, provider, predecessor_session_id,
          session_state, provider_state, observation_transport, current_generation,
          conversation_id, page_key, deadline_at, next_check_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        session.sessionId,
        session.teamId,
        session.roleId,
        session.provider,
        session.predecessorSessionId,
        session.sessionState,
        session.providerState,
        session.observationTransport,
        session.currentGeneration,
        session.conversationId,
        session.pageKey,
        session.deadlineAt,
        session.nextCheckAt,
        session.createdAt,
        session.updatedAt,
      );
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.#database
      .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;
    return row ?? null;
  }

  listSessionsForRole(roleId: string): readonly SessionRecord[] {
    return this.#database
      .prepare(`
        SELECT ${SESSION_COLUMNS}
        FROM sessions
        WHERE role_id = ?
        ORDER BY created_at, session_id
      `)
      .all(roleId) as unknown as SessionRow[];
  }

  listNonterminalSessionIds(): readonly string[] {
    const rows = this.#database
      .prepare(`
        SELECT session_id AS sessionId
        FROM sessions
        WHERE session_state NOT IN ('complete', 'cancelled', 'superseded', 'failed')
        ORDER BY created_at, session_id
      `)
      .all() as unknown as Array<{ sessionId: string }>;
    return rows.map((row) => row.sessionId);
  }

  insertGeneration(generation: GenerationRecord): void {
    this.#database
      .prepare(`
        INSERT INTO generations(
          session_id, generation, team_brief_version, prompt_hash, submission_state,
          submitted_user_message_id, submitted_user_turn_id, response_message_id,
          answer_text, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        generation.sessionId,
        generation.generation,
        generation.teamBriefVersion,
        generation.promptHash,
        generation.submissionState,
        generation.submittedUserMessageId,
        generation.submittedUserTurnId,
        generation.responseMessageId,
        generation.answerText,
        generation.completedAt,
      );
  }

  advanceGeneration(input: {
    readonly sessionId: string;
    readonly expectedGeneration: number;
    readonly nextGeneration: number;
    readonly deadlineAt: string | null;
    readonly updatedAt: string;
  }): boolean {
    const result = this.#database
      .prepare(`
        UPDATE sessions
        SET
          current_generation = ?,
          session_state = 'submitting',
          provider_state = 'pending',
          observation_transport = 'fresh',
          deadline_at = ?,
          next_check_at = NULL,
          updated_at = ?
        WHERE session_id = ?
          AND current_generation = ?
          AND session_state NOT IN ('cancelled', 'superseded', 'failed')
      `)
      .run(
        input.nextGeneration,
        input.deadlineAt,
        input.updatedAt,
        input.sessionId,
        input.expectedGeneration,
      );
    return Number(result.changes) === 1;
  }

  updateCurrentGeneration(
    sessionId: string,
    generation: number,
    update: CurrentGenerationUpdate,
    updatedAt: string,
  ): boolean {
    const sessionAssignments: string[] = ['updated_at = ?'];
    const sessionValues: SQLInputValue[] = [updatedAt];
    const generationAssignments: string[] = [];
    const generationValues: SQLInputValue[] = [];

    appendAssignment(sessionAssignments, sessionValues, 'session_state', update.sessionState);
    appendAssignment(sessionAssignments, sessionValues, 'provider_state', update.providerState);
    appendAssignment(
      sessionAssignments,
      sessionValues,
      'observation_transport',
      update.observationTransport,
    );
    appendAssignment(sessionAssignments, sessionValues, 'conversation_id', update.conversationId);
    appendAssignment(sessionAssignments, sessionValues, 'page_key', update.pageKey);
    appendAssignment(sessionAssignments, sessionValues, 'next_check_at', update.nextCheckAt);

    appendAssignment(
      generationAssignments,
      generationValues,
      'submission_state',
      update.submissionState,
    );
    appendAssignment(
      generationAssignments,
      generationValues,
      'submitted_user_message_id',
      update.submittedUserMessageId,
    );
    appendAssignment(
      generationAssignments,
      generationValues,
      'submitted_user_turn_id',
      update.submittedUserTurnId,
    );
    appendAssignment(
      generationAssignments,
      generationValues,
      'response_message_id',
      update.responseMessageId,
    );
    appendAssignment(generationAssignments, generationValues, 'answer_text', update.answerText);
    appendAssignment(generationAssignments, generationValues, 'completed_at', update.completedAt);

    const sessionResult = this.#database
      .prepare(`
        UPDATE sessions
        SET ${sessionAssignments.join(', ')}
        WHERE session_id = ? AND current_generation = ?
      `)
      .run(...sessionValues, sessionId, generation);
    if (Number(sessionResult.changes) !== 1) {
      return false;
    }

    if (generationAssignments.length > 0) {
      const generationResult = this.#database
        .prepare(`
          UPDATE generations
          SET ${generationAssignments.join(', ')}
          WHERE session_id = ? AND generation = ?
        `)
        .run(...generationValues, sessionId, generation);
      if (Number(generationResult.changes) !== 1) {
        return false;
      }
    }
    return true;
  }

  getGenerationSubmissionState(sessionId: string, generation: number): SubmissionState | null {
    const row = this.#database
      .prepare(`
        SELECT submission_state AS submissionState
        FROM generations
        WHERE session_id = ? AND generation = ?
      `)
      .get(sessionId, generation) as { submissionState: SubmissionState } | undefined;
    return row?.submissionState ?? null;
  }

  transitionToSuperseded(sessionId: string, updatedAt: string): void {
    const session = this.getSession(sessionId);
    if (session === null || isTerminalSessionState(session.sessionState)) {
      return;
    }
    this.#database
      .prepare(`
        UPDATE sessions
        SET session_state = 'superseded', updated_at = ?
        WHERE session_id = ?
      `)
      .run(updatedAt, sessionId);
  }

  transitionToCancelled(sessionId: string, updatedAt: string): void {
    const session = this.getSession(sessionId);
    if (session === null || isTerminalSessionState(session.sessionState)) {
      return;
    }
    this.#database
      .prepare(`
        UPDATE sessions
        SET session_state = 'cancelled', provider_state = 'stopped', updated_at = ?
        WHERE session_id = ?
      `)
      .run(updatedAt, sessionId);
  }

  getSnapshot(sessionId: string): SessionSnapshot | null {
    const row = this.#database
      .prepare(`
        SELECT
          ${QUALIFIED_SESSION_COLUMNS},
          r.role_key AS roleKey,
          g.submitted_user_message_id AS submittedUserMessageId,
          g.submitted_user_turn_id AS submittedUserTurnId,
          g.response_message_id AS responseMessageId,
          g.answer_text AS answerText
        FROM sessions s
        JOIN team_roles r ON r.role_id = s.role_id
        LEFT JOIN generations g
          ON g.session_id = s.session_id AND g.generation = s.current_generation
        WHERE s.session_id = ?
      `)
      .get(sessionId) as SnapshotRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      requestOk: true,
      teamId: row.teamId,
      roleId: row.roleId,
      roleKey: row.roleKey,
      sessionId: row.sessionId,
      predecessorSessionId: row.predecessorSessionId,
      generation: Number(row.currentGeneration),
      sessionState: row.sessionState,
      providerState: row.providerState,
      observationTransport: row.observationTransport,
      terminal: isTerminalSessionState(row.sessionState),
      waitExpired: false,
      nextCheckAt: row.nextCheckAt,
      conversationId: row.conversationId,
      submittedUserMessageId: row.submittedUserMessageId,
      submittedUserTurnId: row.submittedUserTurnId,
      responseMessageId: row.responseMessageId,
      answerText: row.answerText,
      reason: null,
      errorCode: null,
    };
  }
}

function appendAssignment(
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

