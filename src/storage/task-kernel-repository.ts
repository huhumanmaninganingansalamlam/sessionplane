import { createHash } from 'node:crypto';

import {
  isTaskTerminal,
  reduceTaskProjection,
} from '../domain/durable-task.ts';
import type {
  AttemptKind,
  DecisionAudience,
  TaskEvent,
  TaskProjection,
  TaskState,
} from '../domain/durable-task.ts';
import type { SessionPlaneDatabase } from './database.ts';

/**
 * Task Kernel storage is deliberately independent of provider selectors,
 * browser/page handles, client wait calls, and legacy TeamWorkflow/outbox.
 * Every mutation (including event + public projection) is one BEGIN IMMEDIATE
 * transaction. An external adapter MUST act only after beginDispatch commits.
 */
export interface ProjectRecord {
  readonly projectId: string;
  readonly projectKey: string;
  readonly displayName: string;
}
export interface SlotRecord {
  readonly projectId: string;
  readonly slotId: string;
  readonly roleKey: string;
  readonly providerKey: string;
  readonly providerConversationId: string | null;
  readonly revision: number;
  readonly activeTaskId: string | null;
}
export interface SlotBindingRecord {
  readonly projectId: string;
  readonly slotId: string;
  readonly revision: number;
  readonly providerKey: string;
  readonly providerConversationId: string | null;
}
export interface TaskRecord extends TaskProjection {
  readonly taskId: string;
  readonly projectId: string;
  readonly slotId: string;
  readonly slotRevision: number;
  readonly clientId: string;
  readonly requestId: string;
  readonly originalPrompt: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type AttemptState =
  | 'planned' | 'dispatched' | 'acknowledged' | 'uncertain' | 'failed_before_dispatch';
export interface AttemptRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly kind: AttemptKind;
  readonly turnKey: string;
  readonly content: string;
  readonly state: AttemptState;
  readonly externalTurnId: string | null;
  readonly dispatchedAt: string | null;
  readonly acknowledgedAt: string | null;
}
/** Durable, bounded POST provenance. The prompt body remains only in the
 * existing attempt record; evidence stores its hash and exact message edges.
 */
export interface AttemptSessionBindingRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly conversationId: string;
  readonly boundAt: string;
}
export interface DispatchEvidenceRecord {
  readonly conversationId: string;
  readonly messageId: string;
  readonly parentMessageId: string;
  readonly textHash: string;
  readonly observedAt: string;
}
export interface DecisionRecord {
  readonly decisionId: string;
  readonly taskId: string;
  readonly audience: DecisionAudience;
  readonly contextJson: string;
  readonly status: 'pending' | 'resolved' | 'superseded';
  readonly resolutionJson: string | null;
  readonly actionConsumed: boolean;
}
export interface TimerRecord {
  readonly timerId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly contextJson: string;
  readonly status: 'pending' | 'fired' | 'canceled';
}
export interface ResultRecord {
  readonly resultId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly externalTurnId: string;
  readonly answerText: string;
  readonly completesTask: boolean;
  readonly observedAt: string;
}
export interface TaskEventRecord {
  readonly taskRevision: number;
  readonly event: TaskEvent;
  readonly createdAt: string;
}
export interface FullTaskRecord {
  readonly task: TaskRecord;
  readonly attempts: readonly AttemptRecord[];
  readonly decisions: readonly DecisionRecord[];
  readonly timers: readonly TimerRecord[];
  readonly results: readonly ResultRecord[];
  readonly events: readonly TaskEventRecord[];
}

type Row = Record<string, unknown>;
const TASK_COLUMNS = `task_id AS taskId, project_id AS projectId,
  slot_id AS slotId, slot_revision AS slotRevision, client_id AS clientId,
  request_id AS requestId, original_prompt AS originalPrompt, state,
  cancel_requested AS cancelRequested, pending_decision_id AS pendingDecisionId,
  revision, created_at AS createdAt, updated_at AS updatedAt`;
const ATTEMPT_COLUMNS = `attempt_id AS attemptId, task_id AS taskId,
  sequence, kind, turn_key AS turnKey, content, state,
  external_turn_id AS externalTurnId, dispatched_at AS dispatchedAt,
  acknowledged_at AS acknowledgedAt`;
const DECISION_COLUMNS = `decision_id AS decisionId, task_id AS taskId,
  audience, context_json AS contextJson, status,
  resolution_json AS resolutionJson, action_consumed AS actionConsumed`;
const TIMER_COLUMNS = `timer_id AS timerId, task_id AS taskId, kind,
  due_at AS dueAt, context_json AS contextJson, status`;
const RESULT_COLUMNS = `result_id AS resultId, task_id AS taskId,
  attempt_id AS attemptId, external_turn_id AS externalTurnId,
  answer_text AS answerText, completes_task AS completesTask,
  observed_at AS observedAt`;

function taskFromRow(row: Row): TaskRecord {
  return {
    taskId: String(row.taskId),
    projectId: String(row.projectId),
    slotId: String(row.slotId),
    slotRevision: Number(row.slotRevision),
    clientId: String(row.clientId),
    requestId: String(row.requestId),
    originalPrompt: String(row.originalPrompt),
    state: row.state as TaskState,
    cancelRequested: Number(row.cancelRequested) === 1,
    pendingDecisionId: row.pendingDecisionId as string | null,
    revision: Number(row.revision),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

function attemptFromRow(row: Row): AttemptRecord {
  return {
    attemptId: String(row.attemptId),
    taskId: String(row.taskId),
    sequence: Number(row.sequence),
    kind: row.kind as AttemptKind,
    turnKey: String(row.turnKey),
    content: String(row.content),
    state: row.state as AttemptState,
    externalTurnId: row.externalTurnId as string | null,
    dispatchedAt: row.dispatchedAt as string | null,
    acknowledgedAt: row.acknowledgedAt as string | null,
  };
}

function decisionFromRow(row: Row): DecisionRecord {
  return {
    decisionId: String(row.decisionId),
    taskId: String(row.taskId),
    audience: row.audience as DecisionAudience,
    contextJson: String(row.contextJson),
    status: row.status as DecisionRecord['status'],
    resolutionJson: row.resolutionJson as string | null,
    actionConsumed: Number(row.actionConsumed) === 1,
  };
}

function timerFromRow(row: Row): TimerRecord {
  return {
    timerId: String(row.timerId),
    taskId: String(row.taskId),
    kind: String(row.kind),
    dueAt: String(row.dueAt),
    contextJson: String(row.contextJson),
    status: row.status as TimerRecord['status'],
  };
}

function resultFromRow(row: Row): ResultRecord {
  return {
    resultId: String(row.resultId),
    taskId: String(row.taskId),
    attemptId: String(row.attemptId),
    externalTurnId: String(row.externalTurnId),
    answerText: String(row.answerText),
    completesTask: Number(row.completesTask) === 1,
    observedAt: String(row.observedAt),
  };
}

function requireNonempty(value: string, name: string): void {
  if (value.trim() === '') throw new Error(`${name} must be nonempty`);
}

export class TaskKernelRepository {
  readonly #database: SessionPlaneDatabase;
  readonly #now: () => string;

  constructor(database: SessionPlaneDatabase, now: () => string = () => new Date().toISOString()) {
    this.#database = database;
    this.#now = now;
  }

  openProject(input: {
    projectId: string;
    projectKey: string;
    displayName: string;
    clientId: string;
  }): ProjectRecord {
    for (const [name, value] of Object.entries(input)) requireNonempty(value, name);
    return this.#database.transaction(() => {
      const row = this.#database.raw.prepare(
        'SELECT project_id AS projectId, project_key AS projectKey, display_name AS displayName FROM kernel_projects WHERE project_key = ?',
      ).get(input.projectKey) as Row | undefined;
      if (row) {
        this.#requireAccess(String(row.projectId), input.clientId);
        if (row.projectId !== input.projectId) throw new Error('Project identity conflict');
        return row as unknown as ProjectRecord;
      }
      this.#database.raw.prepare(
        'INSERT INTO kernel_projects(project_id,project_key,display_name,created_at) VALUES(?,?,?,?)',
      ).run(input.projectId, input.projectKey, input.displayName, this.#now());
      this.#database.raw.prepare(
        "INSERT INTO kernel_project_access(project_id,client_id,access_role) VALUES(?,?,'owner')",
      ).run(input.projectId, input.clientId);
      return {
        projectId: input.projectId,
        projectKey: input.projectKey,
        displayName: input.displayName,
      };
    });
  }

  grantAccess(projectId: string, ownerClientId: string, clientId: string): void {
    requireNonempty(clientId, 'clientId');
    this.#database.transaction(() => {
      this.#requireAccess(projectId, ownerClientId, 'owner');
      this.#database.raw.prepare(
        "INSERT INTO kernel_project_access(project_id,client_id,access_role) VALUES(?,?,'member') ON CONFLICT(project_id,client_id) DO NOTHING",
      ).run(projectId, clientId);
    });
  }

  openSlot(input: {
    projectId: string;
    clientId: string;
    slotId: string;
    roleKey: string;
    providerKey: string;
  }): SlotRecord {
    for (const [name, value] of Object.entries(input)) requireNonempty(value, name);
    return this.#database.transaction(() => {
      this.#requireAccess(input.projectId, input.clientId);
      const found = this.#findSlot(input.projectId, input.slotId);
      if (found) {
        if (found.roleKey !== input.roleKey || found.providerKey !== input.providerKey) {
          throw new Error('Slot role/provider conflict; explicit binding replacement required');
        }
        return found;
      }
      const at = this.#now();
      this.#database.raw.prepare(
        `INSERT INTO kernel_slots(project_id,slot_id,role_key,provider_key,
          provider_conversation_id,revision,active_task_id,created_at,updated_at)
          VALUES(?,?,?,?,NULL,1,NULL,?,?)`,
      ).run(input.projectId, input.slotId, input.roleKey, input.providerKey, at, at);
      this.#database.raw.prepare(
        `INSERT INTO kernel_slot_bindings(project_id,slot_id,revision,provider_key,
          provider_conversation_id,observed_at) VALUES(?,?,1,?,NULL,?)`,
      ).run(input.projectId, input.slotId, input.providerKey, at);
      return this.#requireSlot(input.projectId, input.slotId);
    });
  }

  getSlot(projectId: string, slotId: string, clientId: string): SlotRecord {
    this.#requireAccess(projectId, clientId);
    return this.#requireSlot(projectId, slotId);
  }

  /** Public revision is advanced by admitted tasks, separate from the
   * immutable provider binding revision used for ACK/FINAL correlation.
   */
  getConversationRevision(projectId: string, slotId: string, clientId: string): number {
    this.#requireAccess(projectId, clientId);
    const row = this.#database.raw.prepare(
      'SELECT revision FROM kernel_public_slot_revisions WHERE project_id=? AND slot_id=?',
    ).get(projectId, slotId) as { revision: number } | undefined;
    return row?.revision ?? this.#requireSlot(projectId, slotId).revision;
  }

  getBindingAtRevision(
    projectId: string, slotId: string, revision: number, clientId: string,
  ): SlotBindingRecord {
    this.#requireAccess(projectId, clientId);
    const row = this.#database.raw.prepare(
      `SELECT project_id AS projectId,slot_id AS slotId,revision,
        provider_key AS providerKey,provider_conversation_id AS providerConversationId
        FROM kernel_slot_bindings WHERE project_id=? AND slot_id=? AND revision=?`,
    ).get(projectId, slotId, revision) as Row | undefined;
    if (!row) throw new Error('Missing immutable historical slot binding');
    return {
      projectId: String(row.projectId),
      slotId: String(row.slotId),
      revision: Number(row.revision),
      providerKey: String(row.providerKey),
      providerConversationId: row.providerConversationId as string | null,
    };
  }

  /**
   * First exact observed provider conversation may be attached under the
   * current task lease. A different ID is never silently substituted.
   */
  observeConversation(input: {
    projectId: string;
    clientId: string;
    slotId: string;
    expectedRevision: number;
    taskId: string;
    providerConversationId: string;
  }): SlotRecord {
    requireNonempty(input.providerConversationId, 'providerConversationId');
    return this.#database.transaction(() => {
      this.#requireAccess(input.projectId, input.clientId);
      const slot = this.#requireSlot(input.projectId, input.slotId);
      if (slot.revision !== input.expectedRevision || slot.activeTaskId !== input.taskId) {
        throw new Error('Stale slot revision or task lease');
      }
      if (slot.providerConversationId !== null &&
        slot.providerConversationId !== input.providerConversationId) {
        throw new Error('Observed provider conversation differs from bound identity');
      }
      this.#database.raw.prepare(
        'UPDATE kernel_slots SET provider_conversation_id = ?, updated_at = ? WHERE project_id = ? AND slot_id = ?',
      ).run(input.providerConversationId, this.#now(), input.projectId, input.slotId);
      const history = this.#database.raw.prepare(
        `UPDATE kernel_slot_bindings SET provider_conversation_id=?,observed_at=?
          WHERE project_id=? AND slot_id=? AND revision=?
            AND (provider_conversation_id IS NULL OR provider_conversation_id=?)`,
      ).run(input.providerConversationId, this.#now(), input.projectId, input.slotId,
        slot.revision, input.providerConversationId);
      if (history.changes !== 1) throw new Error('Historical provider binding conflict');
      return this.#requireSlot(input.projectId, input.slotId);
    });
  }

  replaceBinding(input: {
    projectId: string;
    clientId: string;
    slotId: string;
    expectedRevision: number;
    providerKey: string;
    providerConversationId: string | null;
  }): SlotRecord {
    requireNonempty(input.providerKey, 'providerKey');
    return this.#database.transaction(() => {
      this.#requireAccess(input.projectId, input.clientId);
      const slot = this.#requireSlot(input.projectId, input.slotId);
      if (slot.revision !== input.expectedRevision || slot.activeTaskId !== null) {
        throw new Error('Stale or busy slot; preserve unresolved task identity');
      }
      const changed = this.#database.raw.prepare(
        `UPDATE kernel_slots SET provider_key = ?, provider_conversation_id = ?,
          revision = revision + 1, updated_at = ?
          WHERE project_id = ? AND slot_id = ? AND revision = ? AND active_task_id IS NULL`,
      ).run(input.providerKey, input.providerConversationId, this.#now(),
        input.projectId, input.slotId, slot.revision);
      if (changed.changes !== 1) throw new Error('Concurrent slot revision conflict');
      this.#database.raw.prepare(
        `INSERT INTO kernel_slot_bindings(project_id,slot_id,revision,provider_key,
          provider_conversation_id,observed_at) VALUES(?,?,?,?,?,?)`,
      ).run(input.projectId, input.slotId, slot.revision + 1,
        input.providerKey, input.providerConversationId, this.#now());
      return this.#requireSlot(input.projectId, input.slotId);
    });
  }

  startTask(input: {
    taskId: string;
    projectId: string;
    slotId: string;
    expectedSlotRevision: number;
    clientId: string;
    requestId: string;
    prompt: string;
  }): TaskRecord {
    for (const name of ['taskId', 'projectId', 'slotId', 'clientId', 'requestId', 'prompt'] as const) {
      requireNonempty(input[name], name);
    }
    return this.#database.transaction(() => {
      this.#requireAccess(input.projectId, input.clientId);
      const existing = this.#database.raw.prepare(
        `SELECT ${TASK_COLUMNS} FROM kernel_tasks
          WHERE project_id = ? AND client_id = ? AND request_id = ?`,
      ).get(input.projectId, input.clientId, input.requestId) as Row | undefined;
      if (existing) {
        const task = taskFromRow(existing);
        if (task.taskId !== input.taskId || task.slotId !== input.slotId ||
          task.slotRevision !== input.expectedSlotRevision ||
          task.originalPrompt !== input.prompt) {
          throw new Error('Idempotency key was reused with different task inputs');
        }
        return task;
      }
      const slot = this.#requireSlot(input.projectId, input.slotId);
      if (slot.revision !== input.expectedSlotRevision || slot.activeTaskId !== null) {
        throw new Error('Stale slot revision or unresolved task lease');
      }
      const at = this.#now();
      this.#database.raw.prepare(
        `INSERT INTO kernel_tasks(task_id,project_id,slot_id,slot_revision,
          client_id,request_id,original_prompt,state,cancel_requested,
          pending_decision_id,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'working',0,NULL,1,?,?)`,
      ).run(input.taskId, input.projectId, input.slotId, slot.revision,
        input.clientId, input.requestId, input.prompt, at, at);
      const claimed = this.#database.raw.prepare(
        `UPDATE kernel_slots SET active_task_id = ?, updated_at = ?
          WHERE project_id = ? AND slot_id = ? AND revision = ? AND active_task_id IS NULL`,
      ).run(input.taskId, at, input.projectId, input.slotId, slot.revision);
      if (claimed.changes !== 1) throw new Error('Concurrent slot lease conflict');
      this.#database.raw.prepare(
        `INSERT INTO kernel_events(task_id,task_revision,event_type,payload_json,created_at)
          VALUES(?,1,'task.created',?,?)`,
      ).run(input.taskId, JSON.stringify({ type: 'task.created' }), at);
      return this.#requireTask(input.taskId, input.clientId);
    });
  }

  getTask(taskId: string, clientId: string): TaskRecord {
    return this.#requireTask(taskId, clientId);
  }

  /** Internal journal callback: resolve the immutable task initiator from
   * SQLite, never from a browser page or a process-local caller cache.
   * Public task reads continue to check the supplied client authorization.
   */
  dispatchClientId(taskId: string): string | null {
    const row = this.#database.raw.prepare(
      'SELECT client_id AS clientId FROM kernel_tasks WHERE task_id = ?',
    ).get(taskId) as { clientId: string } | undefined;
    return row?.clientId ?? null;
  }
  /** Shared, profile-scoped backend cooldown; no token, body, or task data. */
  backendReadNotBeforeMs(providerKey: string, origin: string): number {
    requireNonempty(providerKey, 'providerKey');
    requireNonempty(origin, 'origin');
    const row = this.#database.raw.prepare(
      'SELECT next_allowed_at_ms AS nextAllowedAtMs FROM kernel_backend_read_pacing' +
      ' WHERE provider_key=? AND endpoint_origin=?',
    ).get(providerKey, origin) as { nextAllowedAtMs: number } | undefined;
    return row?.nextAllowedAtMs ?? 0;
  }

  /** Atomic monotonic fence: concurrent readers cannot shorten Retry-After. */
  extendBackendReadNotBeforeMs(providerKey: string, origin: string, atMs: number): number {
    requireNonempty(providerKey, 'providerKey');
    requireNonempty(origin, 'origin');
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      throw new Error('Backend pacing timestamp must be a nonnegative safe integer');
    }
    this.#database.raw.prepare(
      'INSERT INTO kernel_backend_read_pacing' +
      ' (provider_key,endpoint_origin,next_allowed_at_ms,updated_at) VALUES(?,?,?,?)' +
      ' ON CONFLICT(provider_key,endpoint_origin) DO UPDATE SET' +
      ' next_allowed_at_ms=excluded.next_allowed_at_ms,updated_at=excluded.updated_at' +
      ' WHERE excluded.next_allowed_at_ms > kernel_backend_read_pacing.next_allowed_at_ms',
    ).run(providerKey, origin, atMs, this.#now());
    return this.backendReadNotBeforeMs(providerKey, origin);
  }

/** Bind each journaled send attempt to one durable owned session generation.
   * Page key/epoch may be recovered, but the session generation cannot drift.
   */
  bindAttemptSession(input: {
    taskId: string; clientId: string; attemptId: string;
    sessionId: string; generation: number; conversationId: string;
  }): AttemptSessionBindingRecord {
    for (const name of ['taskId', 'clientId', 'attemptId', 'sessionId', 'conversationId'] as const) {
      requireNonempty(input[name], name);
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error('Attempt session generation must be a positive integer');
    }
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      const attempt = this.#requireAttempt(input.attemptId, input.taskId);
      const slot = this.#requireSlot(task.projectId, task.slotId);
      const immutable = this.getBindingAtRevision(task.projectId, task.slotId,
        task.slotRevision, input.clientId);
      if (slot.activeTaskId !== task.taskId || slot.revision !== task.slotRevision ||
          immutable.providerConversationId !== input.conversationId ||
          slot.providerConversationId !== input.conversationId) {
        throw new Error('Attempt lost its exact active conversation lease');
      }
      const old = this.getAttemptSessionBinding(input);
      if (old !== null) {
        if (old.sessionId !== input.sessionId || old.generation !== input.generation ||
            old.conversationId !== input.conversationId) {
          throw new Error('Attempt session generation cannot be rebound');
        }
        return old;
      }
      if (attempt.state !== 'planned') {
        throw new Error('Only a planned attempt can bind its session generation');
      }
      this.#database.raw.prepare(
        'INSERT INTO kernel_attempt_session_bindings(attempt_id,task_id,session_id,' +
        ' generation,provider_conversation_id,bound_at) VALUES(?,?,?,?,?,?)',
      ).run(input.attemptId, input.taskId, input.sessionId, input.generation,
        input.conversationId, this.#now());
      return this.getAttemptSessionBinding(input)!;
    });
  }

  getAttemptSessionBinding(input: {
    taskId: string; clientId: string; attemptId: string;
  }): AttemptSessionBindingRecord | null {
    this.#requireTask(input.taskId, input.clientId);
    this.#requireAttempt(input.attemptId, input.taskId);
    const row = this.#database.raw.prepare(
      'SELECT attempt_id AS attemptId, task_id AS taskId, session_id AS sessionId,' +
      ' generation, provider_conversation_id AS conversationId, bound_at AS boundAt' +
      ' FROM kernel_attempt_session_bindings WHERE attempt_id=? AND task_id=?',
    ).get(input.attemptId, input.taskId) as Row | undefined;
    return row ? {
      attemptId: String(row.attemptId), taskId: String(row.taskId),
      sessionId: String(row.sessionId), generation: Number(row.generation),
      conversationId: String(row.conversationId), boundAt: String(row.boundAt),
    } : null;
  }


  getFullTask(taskId: string, clientId: string): FullTaskRecord {
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      const db = this.#database.raw;
      const attempts = db.prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM kernel_attempts WHERE task_id=? ORDER BY sequence`,
      ).all(taskId).map(attemptFromRow);
      const decisions = db.prepare(
        `SELECT ${DECISION_COLUMNS} FROM kernel_decisions WHERE task_id=? ORDER BY created_at,decision_id`,
      ).all(taskId).map(decisionFromRow);
      const timers = db.prepare(
        `SELECT ${TIMER_COLUMNS} FROM kernel_timers WHERE task_id=? ORDER BY due_at,timer_id`,
      ).all(taskId).map(timerFromRow);
      const results = db.prepare(
        `SELECT ${RESULT_COLUMNS} FROM kernel_results WHERE task_id=?
          ORDER BY (SELECT sequence FROM kernel_attempts a
            WHERE a.attempt_id=kernel_results.attempt_id)`,
      ).all(taskId).map(resultFromRow);
      const events = (db.prepare(
        `SELECT task_revision AS taskRevision,payload_json AS payloadJson,created_at AS createdAt
          FROM kernel_events WHERE task_id=? ORDER BY task_revision`,
      ).all(taskId) as Row[]).map(row => ({
        taskRevision: Number(row.taskRevision),
        event: JSON.parse(String(row.payloadJson)) as TaskEvent,
        createdAt: String(row.createdAt),
      }));
      return { task, attempts, decisions, timers, results, events };
    });
  }

  planAttempt(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    kind: AttemptKind;
    turnKey: string;
    content: string;
  }): AttemptRecord {
    for (const name of ['attemptId', 'turnKey'] as const) requireNonempty(input[name], name);
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      const existing = this.#database.raw.prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM kernel_attempts WHERE task_id=? AND turn_key=?`,
      ).get(input.taskId, input.turnKey) as Row | undefined;
      if (existing) {
        const attempt = attemptFromRow(existing);
        if (attempt.attemptId !== input.attemptId || attempt.kind !== input.kind ||
          attempt.content !== input.content) throw new Error('Attempt turn key conflict');
        return attempt; // Re-fetch is safe; beginDispatch still enforces at-most-once.
      }
      if (input.kind === 'initial') {
        if (input.content !== task.originalPrompt) throw new Error('Initial prompt identity mismatch');
        const first = this.#database.raw.prepare(
          "SELECT attempt_id FROM kernel_attempts WHERE task_id=? AND kind='initial' LIMIT 1",
        ).get(task.taskId);
        if (first) throw new Error('Original attempt already exists; no prompt replay');
      } else if (input.kind === 'continuation') {
        const finished = this.#database.raw.prepare(
          'SELECT result_id FROM kernel_results WHERE task_id=? LIMIT 1',
        ).get(task.taskId);
        if (!finished) throw new Error('Continuation requires a prior exact FINAL');
      }
      if (input.kind !== 'stop') {
        const unresolved = this.#database.raw.prepare(
          `SELECT a.attempt_id FROM kernel_attempts a
             LEFT JOIN kernel_results r ON r.attempt_id=a.attempt_id
             WHERE a.task_id=? AND a.kind!='stop'
               AND a.state!='failed_before_dispatch' AND r.result_id IS NULL LIMIT 1`,
        ).get(task.taskId);
        if (unresolved) throw new Error('Previous exact attempt has no correlated FINAL');
        const slot = this.#requireSlot(task.projectId, task.slotId);
        if (slot.activeTaskId !== task.taskId || slot.revision !== task.slotRevision) {
          throw new Error('Task lost its exact conversation lease');
        }
      } else {
        const earlierStop = this.#database.raw.prepare(
          "SELECT attempt_id FROM kernel_attempts WHERE task_id=? AND kind='stop' LIMIT 1",
        ).get(task.taskId);
        if (earlierStop) throw new Error('Stop already attempted; do not replay');
      }
      this.#appendEvent(task, { type: 'attempt.planned', attemptId: input.attemptId, kind: input.kind });
      const seq = Number((this.#database.raw.prepare(
        'SELECT COALESCE(MAX(sequence),0)+1 AS next FROM kernel_attempts WHERE task_id=?',
      ).get(task.taskId) as { next: number }).next);
      this.#database.raw.prepare(
        `INSERT INTO kernel_attempts(attempt_id,task_id,sequence,kind,turn_key,
          content,state,external_turn_id,dispatched_at,acknowledged_at,
          uncertain_reason,created_at)
          VALUES(?,?,?,?,?,?,'planned',NULL,NULL,NULL,NULL,?)`,
      ).run(input.attemptId, task.taskId, seq, input.kind,
        input.turnKey, input.content, this.#now());
      return this.#requireAttempt(input.attemptId, input.taskId);
    });
  }

  /**
   * Commit this transition BEFORE invoking an irreversible adapter action.
   * A crash after it returns is uncertain, even if no ACK was observed.
   */
  beginDispatch(taskId: string, clientId: string, attemptId: string): AttemptRecord {
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      const attempt = this.#requireAttempt(attemptId, taskId);
      if (attempt.state !== 'planned') throw new Error('Dispatch already consumed; never replay');
      const slot = this.#requireSlot(task.projectId, task.slotId);
      if (slot.revision !== task.slotRevision || slot.activeTaskId !== task.taskId) {
        throw new Error('Exact task lease lost before dispatch');
      }
      this.#appendEvent(task, {
        type: 'attempt.dispatched', attemptId, kind: attempt.kind,
      });
      this.#database.raw.prepare(
        "UPDATE kernel_attempts SET state='dispatched',dispatched_at=? WHERE attempt_id=? AND state='planned'",
      ).run(this.#now(), attemptId);
      return this.#requireAttempt(attemptId, taskId);
    });
  }

  /**
   * Record one exact outgoing message for a *previously dispatched* journaled
   * attempt. Called synchronously by the provider request observer if possible,
   * before an ACK is probed. Replaying the same evidence is idempotent; a
   * competing message/turn is rejected. No external network or DOM mutation.
   */
  recordDispatchEvidence(input: {
    taskId: string; clientId: string; attemptId: string;
    evidence: DispatchEvidenceRecord;
  }): DispatchEvidenceRecord {
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      const attempt = this.#requireAttempt(input.attemptId, input.taskId);
      if (!['dispatched', 'uncertain', 'acknowledged'].includes(attempt.state)) {
        throw new Error('Dispatch evidence requires a previously dispatched attempt');
      }
      const binding = this.getBindingAtRevision(task.projectId, task.slotId,
        task.slotRevision, input.clientId);
      const evidence = input.evidence;
      for (const [label, value] of Object.entries(evidence)) {
        if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
          throw new Error(`Invalid dispatch evidence ${label}`);
        }
      }
      if (evidence.conversationId !== binding.providerConversationId) {
        throw new Error('Dispatch evidence conversation is not the immutable slot binding');
      }
      const contentHash = createHash('sha256')
        .update(attempt.content.replaceAll('\r\n', '\n')).digest('hex');
      if (!/^[a-f0-9]{64}$/.test(evidence.textHash) || evidence.textHash !== contentHash) {
        throw new Error('Dispatch evidence text does not match the journaled attempt');
      }
      if (Number.isNaN(Date.parse(evidence.observedAt))) {
        throw new Error('Dispatch evidence timestamp is invalid');
      }
      const row = this.#database.raw.prepare(
        `SELECT provider_key AS providerKey,provider_conversation_id AS conversationId,
          message_id AS messageId,parent_message_id AS parentMessageId,
          text_hash AS textHash,observed_at AS observedAt
          FROM kernel_dispatch_evidence WHERE attempt_id=?`,
      ).get(input.attemptId) as (DispatchEvidenceRecord & { providerKey: string }) | undefined;
      if (row !== undefined) {
        if (row.providerKey !== binding.providerKey ||
          row.conversationId !== evidence.conversationId || row.messageId !== evidence.messageId ||
          row.parentMessageId !== evidence.parentMessageId || row.textHash !== evidence.textHash ||
          row.observedAt !== evidence.observedAt) {
          throw new Error('Conflicting dispatch evidence for the same attempt');
        }
        return evidence;
      }
      this.#database.raw.prepare(
        `INSERT INTO kernel_dispatch_evidence(
          attempt_id,task_id,provider_key,provider_conversation_id,message_id,
          parent_message_id,text_hash,observed_at
        ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(input.attemptId, input.taskId, binding.providerKey, evidence.conversationId,
        evidence.messageId, evidence.parentMessageId, evidence.textHash,
        evidence.observedAt);
      this.#appendEvent(task, {
        type: 'attempt.dispatch_evidence_recorded', attemptId: input.attemptId,
      });
      return evidence;
    });
  }

  /** Exact lookup across Core restart; never authorizes a new POST. */
  getDispatchEvidence(input: {
    taskId: string; clientId: string; attemptId: string;
  }): DispatchEvidenceRecord | null {
    const task = this.#requireTask(input.taskId, input.clientId);
    this.#requireAttempt(input.attemptId, input.taskId);
    const row = this.#database.raw.prepare(
      `SELECT provider_key AS providerKey,provider_conversation_id AS conversationId,
        message_id AS messageId,parent_message_id AS parentMessageId,
        text_hash AS textHash,observed_at AS observedAt
        FROM kernel_dispatch_evidence WHERE attempt_id=?`,
    ).get(input.attemptId) as (DispatchEvidenceRecord & { providerKey: string }) | undefined;
    if (row === undefined) return null;
    const binding = this.getBindingAtRevision(task.projectId, task.slotId,
      task.slotRevision, input.clientId);
    if (row.providerKey !== binding.providerKey ||
      row.conversationId !== binding.providerConversationId) {
      throw new Error('Stored dispatch evidence no longer matches the slot binding');
    }
    return { conversationId: row.conversationId, messageId: row.messageId,
      parentMessageId: row.parentMessageId, textHash: row.textHash, observedAt: row.observedAt };
  }

  acknowledgeAttempt(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    externalTurnId: string;
  }): AttemptRecord {
    requireNonempty(input.externalTurnId, 'externalTurnId');
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      const attempt = this.#requireAttempt(input.attemptId, task.taskId);
      if (attempt.state === 'acknowledged') {
        if (attempt.externalTurnId !== input.externalTurnId) throw new Error('ACK turn mismatch');
        return attempt;
      }
      if (attempt.state !== 'dispatched' && attempt.state !== 'uncertain') {
        throw new Error('ACK requires exact dispatched/uncertain attempt');
      }
      this.#appendEvent(task, {
        type: 'attempt.acknowledged', attemptId: input.attemptId, kind: attempt.kind,
      });
      this.#database.raw.prepare(
        `UPDATE kernel_attempts SET state='acknowledged',
          external_turn_id=?,acknowledged_at=? WHERE attempt_id=?`,
      ).run(input.externalTurnId, this.#now(), input.attemptId);
      return this.#requireAttempt(input.attemptId, task.taskId);
    });
  }

  markUncertain(taskId: string, clientId: string, attemptId: string, reason: string): TaskRecord {
    requireNonempty(reason, 'reason');
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      const attempt = this.#requireAttempt(attemptId, taskId);
      if (attempt.state === 'uncertain') return task;
      if (attempt.state !== 'dispatched') throw new Error('Only dispatched attempt may become uncertain');
      const changed = this.#appendEvent(task, { type: 'attempt.uncertain', attemptId, reason });
      this.#database.raw.prepare(
        "UPDATE kernel_attempts SET state='uncertain', uncertain_reason=? WHERE attempt_id=?",
      ).run(reason, attemptId);
      return changed;
    });
  }

  recordObservationDeferred(taskId: string, clientId: string, reason: string): TaskRecord {
    requireNonempty(reason, 'reason');
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      // Repeated reads inside one provider pacing window must not grow the
      // Task event journal or wake subscribers with identical evidence.
      const latest = this.#database.raw.prepare(
        'SELECT event_type AS eventType, payload_json AS payload FROM kernel_events' +
        ' WHERE task_id=? ORDER BY task_revision DESC LIMIT 1',
      ).get(taskId) as { eventType: string; payload: string } | undefined;
      if (latest?.eventType === 'observation.deferred') {
        const previous = JSON.parse(latest.payload) as { reason?: unknown };
        if (previous.reason === reason) return task;
      }
      return this.#appendEvent(task, { type: 'observation.deferred', reason });
    });
  }

  failBeforeDispatch(taskId: string, clientId: string, attemptId: string, reason: string): TaskRecord {
    requireNonempty(reason, 'reason');
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      const attempt = this.#requireAttempt(attemptId, taskId);
      if (attempt.state !== 'planned') throw new Error('May have dispatched: cannot label as never attempted');
      const next = this.#appendEvent(task, {
        type: 'attempt.failed_before_dispatch', attemptId, reason,
      });
      this.#database.raw.prepare(
        "UPDATE kernel_attempts SET state='failed_before_dispatch' WHERE attempt_id=?",
      ).run(attemptId);
      return next;
    });
  }

  recordFinal(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    externalTurnId: string;
    resultId: string;
    answerText: string;
    completeTask: boolean;
  }): ResultRecord {
    requireNonempty(input.resultId, 'resultId');
    requireNonempty(input.externalTurnId, 'externalTurnId');
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      const attempt = this.#requireAttempt(input.attemptId, task.taskId);
      if (attempt.kind === 'stop' || attempt.state !== 'acknowledged' ||
        attempt.externalTurnId !== input.externalTurnId) {
        throw new Error('FINAL must match an exact acknowledged answer turn');
      }
      const existing = this.#database.raw.prepare(
        `SELECT ${RESULT_COLUMNS} FROM kernel_results WHERE attempt_id=?`,
      ).get(input.attemptId) as Row | undefined;
      if (existing) {
        const result = resultFromRow(existing);
        if (result.resultId !== input.resultId ||
          result.externalTurnId !== input.externalTurnId ||
          result.answerText !== input.answerText ||
          result.completesTask !== input.completeTask) throw new Error('Conflicting FINAL evidence');
        return result;
      }
      if (isTaskTerminal(task.state) && !task.cancelRequested) {
        throw new Error('Cannot add answer to terminal task');
      }
      this.#appendEvent(task, {
        type: 'turn.final', attemptId: input.attemptId, completeTask: input.completeTask,
      });
      this.#database.raw.prepare(
        `INSERT INTO kernel_results(result_id,task_id,attempt_id,external_turn_id,
          answer_text,completes_task,observed_at) VALUES(?,?,?,?,?,?,?)`,
      ).run(input.resultId, task.taskId, input.attemptId, input.externalTurnId,
        input.answerText, input.completeTask ? 1 : 0, this.#now());
      return resultFromRow(this.#database.raw.prepare(
        `SELECT ${RESULT_COLUMNS} FROM kernel_results WHERE result_id=?`,
      ).get(input.resultId) as Row);
    });
  }

  requireDecision(input: {
    taskId: string;
    clientId: string;
    decisionId: string;
    audience: DecisionAudience;
    contextJson: string;
  }): DecisionRecord {
    requireNonempty(input.decisionId, 'decisionId');
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      // Validate a packet is JSON and persists exactly; interpretation belongs
      // to the decision gateway, never to this provider-neutral kernel.
      JSON.parse(input.contextJson);
      this.#appendEvent(task, {
        type: 'decision.required', decisionId: input.decisionId, audience: input.audience,
      });
      this.#database.raw.prepare(
        `INSERT INTO kernel_decisions(decision_id,task_id,audience,context_json,
          status,resolution_json,action_consumed,created_at,resolved_at)
          VALUES(?,?,?,?,'pending',NULL,0,?,NULL)`,
      ).run(input.decisionId, task.taskId, input.audience, input.contextJson, this.#now());
      return this.#requireDecision(input.decisionId, task.taskId);
    });
  }

  resolveDecision(input: {
    taskId: string;
    clientId: string;
    decisionId: string;
    resolutionJson: string;
  }): DecisionRecord {
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      JSON.parse(input.resolutionJson);
      const decision = this.#requireDecision(input.decisionId, task.taskId);
      if (decision.status !== 'pending') throw new Error('Decision already consumed');
      this.#appendEvent(task, { type: 'decision.resolved', decisionId: input.decisionId });
      this.#database.raw.prepare(
        `UPDATE kernel_decisions SET status='resolved',resolution_json=?,
          resolved_at=? WHERE decision_id=? AND status='pending'`,
      ).run(input.resolutionJson, this.#now(), input.decisionId);
      return this.#requireDecision(input.decisionId, task.taskId);
    });
  }

  /**
   * Record the externally observed decision effect as an idempotent receipt.
   * The initial resolution reserves the one-shot action; after a crash before
   * this receipt, the caller must see uncertainty rather than fabricated
   * success. Store the outcome and Task revision atomically.
   */
  recordDecisionOutcome(input: {
    taskId: string; clientId: string; decisionId: string;
    requestId: string; actionRef: string; inputValue: string | null;
    outcomeJson: string;
  }): DecisionRecord {
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      const decision = this.#requireDecision(input.decisionId, task.taskId);
      if (decision.status !== 'resolved' || decision.resolutionJson === null) {
        throw new Error('Only an exact resolved decision can record an outcome');
      }
      const receipt = JSON.parse(decision.resolutionJson) as Record<string, unknown>;
      if (receipt.kind !== 'semantic_action' ||
          receipt.requestId !== input.requestId ||
          receipt.actionRef !== input.actionRef ||
          receipt.input !== input.inputValue) {
        throw new Error('Decision outcome request identity conflict');
      }
      if (Buffer.byteLength(input.outcomeJson, 'utf8') > 24 * 1024) {
        throw new Error('Decision outcome receipt exceeds bound');
      }
      const outcome: unknown = JSON.parse(input.outcomeJson);
      if (!outcome || typeof outcome !== 'object' ||
          Array.isArray(outcome) ||
          !['performed', 'uncertain', 'refresh_required'].includes(
            (outcome as { kind?: unknown }).kind as string)) {
        throw new Error('Invalid decision outcome receipt');
      }
      if (receipt.outcome !== undefined) {
        if (JSON.stringify(receipt.outcome) !== JSON.stringify(outcome)) {
          throw new Error('Conflicting exact decision outcome receipt');
        }
        return decision;
      }
      if ((outcome as { kind: string }).kind === 'performed' && !decision.actionConsumed) {
        throw new Error('Unconsumed decision cannot record a performed effect');
      }
      const updated = JSON.stringify({ ...receipt, outcome });
      const result = this.#database.raw.prepare(
        "UPDATE kernel_decisions SET resolution_json=? WHERE decision_id=?" +
        " AND status='resolved' AND resolution_json=?",
      ).run(updated, input.decisionId, decision.resolutionJson);
      if (result.changes !== 1) {
        throw new Error('Concurrent decision outcome identity changed');
      }
      this.#appendEvent(task, { type: 'decision.outcome_recorded', decisionId: input.decisionId });
      return this.#requireDecision(input.decisionId, task.taskId);
    });
  }

  consumeDecisionAction(taskId: string, clientId: string, decisionId: string): boolean {
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      const decision = this.#requireDecision(decisionId, taskId);
      if (decision.status !== 'resolved' || decision.actionConsumed) return false;
      const changed = this.#database.raw.prepare(
        `UPDATE kernel_decisions SET action_consumed=1 WHERE decision_id=?
          AND status='resolved' AND action_consumed=0`,
      ).run(decisionId);
      if (changed.changes !== 1) return false;
      this.#appendEvent(task, { type: 'decision.action_consumed', decisionId });
      return true;
    });
  }

  requestCancel(taskId: string, clientId: string): TaskRecord {
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      if (task.cancelRequested) return task;
      const next = this.#appendEvent(task, { type: 'cancel.requested' });
      this.#database.raw.prepare(
        "UPDATE kernel_decisions SET status='superseded' WHERE task_id=? AND status='pending'",
      ).run(taskId);
      this.#database.raw.prepare(
        "UPDATE kernel_timers SET status='canceled' WHERE task_id=? AND status='pending'",
      ).run(taskId);
      return next;
    });
  }

  confirmCancel(taskId: string, clientId: string): TaskRecord {
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      if (task.state === 'canceled') return task;
      if (!task.cancelRequested) throw new Error('No cancellation intent');
      const uncertainStop = this.#database.raw.prepare(
        "SELECT state FROM kernel_attempts WHERE task_id=? AND kind='stop'",
      ).get(taskId) as { state: AttemptState } | undefined;
      if (uncertainStop && uncertainStop.state !== 'acknowledged' &&
        uncertainStop.state !== 'failed_before_dispatch') {
        throw new Error('Provider stop not confirmed; cancellation stays uncertain');
      }
      const unfinished = this.#database.raw.prepare(
        `SELECT a.attempt_id FROM kernel_attempts a
          LEFT JOIN kernel_results r ON r.attempt_id=a.attempt_id
          WHERE a.task_id=? AND a.kind!='stop'
            AND a.state IN ('dispatched','uncertain','acknowledged')
            AND r.result_id IS NULL LIMIT 1`,
      ).get(taskId);
      if (unfinished && uncertainStop?.state !== 'acknowledged') {
        throw new Error('External mutation unresolved; exact stop ACK required');
      }
      return this.#appendEvent(task, { type: 'cancel.confirmed' });
    });
  }

  failTask(taskId: string, clientId: string, code: string): TaskRecord {
    requireNonempty(code, 'code');
    return this.#database.transaction(() => {
      const task = this.#requireTask(taskId, clientId);
      const inFlight = this.#database.raw.prepare(
        `SELECT a.attempt_id FROM kernel_attempts a
          LEFT JOIN kernel_results r ON r.attempt_id=a.attempt_id
          WHERE a.task_id=? AND a.kind!='stop'
            AND (a.state IN ('dispatched','uncertain')
              OR (a.state='acknowledged' AND r.result_id IS NULL)) LIMIT 1`,
      ).get(taskId);
      if (inFlight) throw new Error('Unresolved external attempt cannot become failure');
      return this.#appendEvent(task, { type: 'task.failed', code });
    });
  }

  scheduleTimer(input: {
    taskId: string;
    clientId: string;
    timerId: string;
    kind: string;
    dueAt: string;
    contextJson: string;
  }): TimerRecord {
    requireNonempty(input.timerId, 'timerId');
    requireNonempty(input.kind, 'kind');
    const due = new Date(input.dueAt).toISOString();
    JSON.parse(input.contextJson);
    return this.#database.transaction(() => {
      const task = this.#requireTask(input.taskId, input.clientId);
      const row = this.#database.raw.prepare(
        `SELECT ${TIMER_COLUMNS} FROM kernel_timers WHERE timer_id=?`,
      ).get(input.timerId) as Row | undefined;
      if (row) {
        const existing = timerFromRow(row);
        if (existing.taskId !== task.taskId || existing.kind !== input.kind ||
          existing.dueAt !== due || existing.contextJson !== input.contextJson) {
          throw new Error('Timer identity conflict');
        }
        return existing;
      }
      if (task.cancelRequested || isTaskTerminal(task.state)) {
        throw new Error('No timer after cancellation/terminal state');
      }
      this.#appendEvent(task, { type: 'timer.scheduled', timerId: input.timerId });
      this.#database.raw.prepare(
        `INSERT INTO kernel_timers(timer_id,task_id,kind,due_at,context_json,
          status,created_at,fired_at) VALUES(?,?,?,?,?,'pending',?,NULL)`,
      ).run(input.timerId, task.taskId, input.kind, due, input.contextJson, this.#now());
      return timerFromRow(this.#database.raw.prepare(
        `SELECT ${TIMER_COLUMNS} FROM kernel_timers WHERE timer_id=?`,
      ).get(input.timerId) as Row);
    });
  }

  /**
   * Timer receipts are persisted before any external action. The caller must
   * independently inspect task/attempt state before issuing a new mutation.
   * A second Core after restart cannot fire the same timer twice.
   */
  claimDueTimers(nowIso: string, limit = 50, kind?: string): readonly TimerRecord[] {
    const now = new Date(nowIso).toISOString();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid timer limit');
    if (kind !== undefined) requireNonempty(kind, 'timer kind');
    return this.#database.transaction(() => {
      const rows = this.#database.raw.prepare(
        `SELECT ${TIMER_COLUMNS} FROM kernel_timers
          WHERE status='pending' AND due_at<=?${kind === undefined ? '' : ' AND kind=?'}
          ORDER BY due_at,timer_id LIMIT ?`,
      ).all(...(kind === undefined ? [now, limit] : [now, kind, limit])) as Row[];
      const claimed: TimerRecord[] = [];
      for (const row of rows) {
        const timer = timerFromRow(row);
        const taskRow = this.#database.raw.prepare(
          `SELECT ${TASK_COLUMNS} FROM kernel_tasks WHERE task_id=?`,
        ).get(timer.taskId) as Row;
        const task = taskFromRow(taskRow);
        if (task.cancelRequested || isTaskTerminal(task.state)) {
          this.#database.raw.prepare(
            "UPDATE kernel_timers SET status='canceled' WHERE timer_id=? AND status='pending'",
          ).run(timer.timerId);
          continue;
        }
        this.#appendEvent(task, { type: 'timer.fired', timerId: timer.timerId });
        const changed = this.#database.raw.prepare(
          "UPDATE kernel_timers SET status='fired',fired_at=? WHERE timer_id=? AND status='pending'",
        ).run(now, timer.timerId);
        if (changed.changes !== 1) throw new Error('Concurrent timer consumption conflict');
        claimed.push({ ...timer, status: 'fired' });
      }
      return claimed;
    });
  }

  /**
   * Restart recovery never invokes the adapter. Only potentially executed
   * dispatches are reclassified; planned (never dispatched) work is retained.
   */
  recoverInterruptedDispatches(reason = 'core_restarted_before_exact_ack'): number {
    const rows = this.#database.raw.prepare(
      `SELECT a.attempt_id AS attemptId,a.task_id AS taskId,t.client_id AS clientId
        FROM kernel_attempts a JOIN kernel_tasks t ON t.task_id=a.task_id
        WHERE a.state='dispatched' ORDER BY a.created_at,a.attempt_id`,
    ).all() as Array<{ attemptId: string; taskId: string; clientId: string }>;
    for (const row of rows) {
      this.markUncertain(row.taskId, row.clientId, row.attemptId, reason);
    }
    return rows.length;
  }

  /**
   * Admitted public Task initials ready for Core-owned dispatch. Conversation
   * identity must already be verified and bound to the current active slot;
   * a new/unprepared ChatGPT page is not an invented conversation ID.
   * Only PLANNED work is eligible: dispatched/uncertain is never replayed.
   */
  /** Exact model intent is stored at project admission, not inferred from UI. */
  publicModelIntent(projectId: string, clientId: string): string | null {
    this.#requireAccess(projectId, clientId);
    const row = this.#database.raw.prepare(
      'SELECT model_intent AS modelIntent FROM kernel_public_project_intents' +
      ' WHERE project_id=?',
    ).get(projectId) as { modelIntent: string | null } | undefined;
    return row?.modelIntent ?? null;
  }

  listPendingPublicInitials(limit = 16): readonly {
    taskId: string; clientId: string; attemptId: string; modelIntent: string | null;
  }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid public initial scan limit');
    }
    return this.#database.raw.prepare(
      `SELECT t.task_id AS taskId,t.client_id AS clientId,
          a.attempt_id AS attemptId,i.model_intent AS modelIntent
        FROM kernel_tasks t
        JOIN kernel_public_task_policies p ON p.task_id=t.task_id
        JOIN kernel_attempts a ON a.task_id=t.task_id
        JOIN kernel_slots s ON s.project_id=t.project_id AND s.slot_id=t.slot_id
          AND s.revision=t.slot_revision AND s.active_task_id=t.task_id
        LEFT JOIN kernel_public_project_intents i ON i.project_id=t.project_id
        WHERE t.cancel_requested=0 AND t.state='working'
          AND t.pending_decision_id IS NULL AND s.provider_conversation_id IS NOT NULL
          AND a.kind='initial' AND a.state='planned'
        ORDER BY t.created_at,t.task_id LIMIT ?`,
    ).all(limit) as Array<{
      taskId: string; clientId: string; attemptId: string; modelIntent: string | null;
    }>;
  }

  /** Exact public ACKs awaiting a canonical FINAL. The Core may observe
   * these without a connected RPC/MCP client or a subscriber lifecycle.
   */
  listPendingPublicFinals(limit = 32): readonly {
    taskId: string; clientId: string; attemptId: string; policyJson: string;
  }[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Invalid public final scan limit');
    }
    return this.#database.raw.prepare(
      `SELECT t.task_id AS taskId,t.client_id AS clientId,
          a.attempt_id AS attemptId,p.policy_json AS policyJson
        FROM kernel_tasks t JOIN kernel_public_task_policies p ON p.task_id=t.task_id
        JOIN kernel_attempts a ON a.task_id=t.task_id
        LEFT JOIN kernel_results r ON r.attempt_id=a.attempt_id
        WHERE t.cancel_requested=0 AND t.state='working'
          AND a.kind!='stop' AND a.state='acknowledged' AND r.result_id IS NULL
        ORDER BY t.updated_at,a.sequence LIMIT ?`,
    ).all(limit) as Array<{
      taskId: string; clientId: string; attemptId: string; policyJson: string;
    }>;
  }

  /** Standing policy is durable Task admission data, never a client wait.
   * The policy is inert until a later exact ACK permits timer activation.
   */
  listApprovedContinuationPolicies(): readonly {
    taskId: string; clientId: string; policyJson: string;
  }[] {
    return this.#database.raw.prepare(
      `SELECT t.task_id AS taskId,t.client_id AS clientId,
          p.policy_json AS policyJson
        FROM kernel_tasks t JOIN kernel_public_task_policies p ON p.task_id=t.task_id
        WHERE t.cancel_requested=0 AND t.state='working'
        ORDER BY t.created_at,t.task_id`,
    ).all() as Array<{ taskId: string; clientId: string; policyJson: string }>;
  }

  /** Core-owned timer scanner; task ownership is read from SQLite, not a client subscription. */
  listContinuationTaskOwners(): readonly { taskId: string; clientId: string }[] {
    return this.#database.raw.prepare(
      `SELECT DISTINCT t.task_id AS taskId,t.client_id AS clientId
        FROM kernel_tasks t JOIN kernel_timers timer ON timer.task_id=t.task_id
        WHERE timer.kind='continuation_due' AND t.cancel_requested=0
          AND t.state NOT IN ('completed','failed','canceled')
        ORDER BY t.task_id`,
    ).all() as Array<{ taskId: string; clientId: string }>;
  }

  listPendingDecisions(projectId: string, clientId: string): readonly DecisionRecord[] {
    this.#requireAccess(projectId, clientId);
    return this.#database.raw.prepare(
      `SELECT ${DECISION_COLUMNS} FROM kernel_decisions
        WHERE task_id IN (SELECT task_id FROM kernel_tasks WHERE project_id=?)
          AND status='pending' ORDER BY created_at,decision_id`,
    ).all(projectId).map(decisionFromRow);
  }

  #requireAccess(projectId: string, clientId: string, role?: 'owner'): void {
    const row = this.#database.raw.prepare(
      'SELECT access_role AS accessRole FROM kernel_project_access WHERE project_id=? AND client_id=?',
    ).get(projectId, clientId) as { accessRole: string } | undefined;
    if (!row || (role && row.accessRole !== role)) throw new Error('Project access denied');
  }

  #findSlot(projectId: string, slotId: string): SlotRecord | null {
    const row = this.#database.raw.prepare(
      `SELECT project_id AS projectId,slot_id AS slotId,role_key AS roleKey,
        provider_key AS providerKey,provider_conversation_id AS providerConversationId,
        revision,active_task_id AS activeTaskId FROM kernel_slots
        WHERE project_id=? AND slot_id=?`,
    ).get(projectId, slotId) as Row | undefined;
    return row ? {
      projectId: String(row.projectId),
      slotId: String(row.slotId),
      roleKey: String(row.roleKey),
      providerKey: String(row.providerKey),
      providerConversationId: row.providerConversationId as string | null,
      revision: Number(row.revision),
      activeTaskId: row.activeTaskId as string | null,
    } : null;
  }

  #requireSlot(projectId: string, slotId: string): SlotRecord {
    const slot = this.#findSlot(projectId, slotId);
    if (!slot) throw new Error('Unknown logical conversation slot');
    return slot;
  }

  #requireTask(taskId: string, clientId: string): TaskRecord {
    const row = this.#database.raw.prepare(
      `SELECT ${TASK_COLUMNS} FROM kernel_tasks WHERE task_id=?`,
    ).get(taskId) as Row | undefined;
    if (!row) throw new Error('Unknown task');
    const task = taskFromRow(row);
    this.#requireAccess(task.projectId, clientId);
    return task;
  }

  #requireAttempt(attemptId: string, taskId: string): AttemptRecord {
    const row = this.#database.raw.prepare(
      `SELECT ${ATTEMPT_COLUMNS} FROM kernel_attempts
        WHERE attempt_id=? AND task_id=?`,
    ).get(attemptId, taskId) as Row | undefined;
    if (!row) throw new Error('Attempt is not owned by this task');
    return attemptFromRow(row);
  }

  #requireDecision(decisionId: string, taskId: string): DecisionRecord {
    const row = this.#database.raw.prepare(
      `SELECT ${DECISION_COLUMNS} FROM kernel_decisions
        WHERE decision_id=? AND task_id=?`,
    ).get(decisionId, taskId) as Row | undefined;
    if (!row) throw new Error('Decision is not owned by this task');
    return decisionFromRow(row);
  }

  #appendEvent(task: TaskRecord, event: TaskEvent): TaskRecord {
    const next: TaskProjection = reduceTaskProjection(task, event);
    const at = this.#now();
    const revision = task.revision + 1;
    const changed = this.#database.raw.prepare(
      `UPDATE kernel_tasks SET state=?,cancel_requested=?,
        pending_decision_id=?,revision=?,updated_at=?
        WHERE task_id=? AND revision=?`,
    ).run(next.state, next.cancelRequested ? 1 : 0,
      next.pendingDecisionId, revision, at, task.taskId, task.revision);
    if (changed.changes !== 1) throw new Error('Concurrent task revision conflict');
    this.#database.raw.prepare(
      `INSERT INTO kernel_events(task_id,task_revision,event_type,payload_json,created_at)
        VALUES(?,?,?,?,?)`,
    ).run(task.taskId, revision, event.type, JSON.stringify(event), at);
    if (!isTaskTerminal(task.state) && isTaskTerminal(next.state)) {
      const released = this.#database.raw.prepare(
        `UPDATE kernel_slots SET active_task_id=NULL,updated_at=?
          WHERE project_id=? AND slot_id=? AND revision=? AND active_task_id=?`,
      ).run(at, task.projectId, task.slotId, task.slotRevision, task.taskId);
      if (released.changes !== 1) throw new Error('Lost task lease before terminal transition');
      this.#database.raw.prepare(
        "UPDATE kernel_timers SET status='canceled' WHERE task_id=? AND status='pending'",
      ).run(task.taskId);
      this.#database.raw.prepare(
        "UPDATE kernel_decisions SET status='superseded' WHERE task_id=? AND status='pending'",
      ).run(task.taskId);
    }
    return { ...task, ...next, revision, updatedAt: at };
  }
}
