import type { Row } from './row-codecs.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { isTaskTerminal } from '../../domain/durable-task.ts';
import type { TaskEvent } from '../../domain/durable-task.ts';
import type { TaskRecord, AttemptState, ResultRecord, FullTaskRecord } from './records.ts';
import { TASK_COLUMNS, ATTEMPT_COLUMNS, DECISION_COLUMNS, TIMER_COLUMNS, RESULT_COLUMNS, decodeTaskRow, decodeAttemptRow, decodeDecisionRow, decodeTimerRow, decodeResultRow, requireNonempty } from './row-codecs.ts';
import type { KernelTransactionContext } from './transaction-context.ts';

export class TaskStore {
  readonly #context: KernelTransactionContext;

  constructor(context: KernelTransactionContext) {
    this.#context = context;
  }

  createTask(input: {
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
    return this.#context.database.transaction(() => {
      this.#context.requireAccess(input.projectId, input.clientId);
      const existing = this.#context.database.raw.prepare(
        `SELECT ${TASK_COLUMNS} FROM kernel_tasks
          WHERE project_id = ? AND client_id = ? AND request_id = ?`,
      ).get(input.projectId, input.clientId, input.requestId) as Row | undefined;
      if (existing) {
        const task = decodeTaskRow(existing);
        if (task.taskId !== input.taskId || task.slotId !== input.slotId ||
          task.slotRevision !== input.expectedSlotRevision ||
          task.originalPrompt !== input.prompt) {
          throw new Error('Idempotency key was reused with different task inputs');
        }
        return task;
      }
      const slot = this.#context.requireSlot(input.projectId, input.slotId);
      if (slot.revision !== input.expectedSlotRevision || slot.activeTaskId !== null) {
        throw new Error('Stale slot revision or unresolved task lease');
      }
      const at = this.#context.now();
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_tasks(task_id,project_id,slot_id,slot_revision,
          client_id,request_id,original_prompt,state,cancel_requested,
          pending_decision_id,revision,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'working',0,NULL,1,?,?)`,
      ).run(input.taskId, input.projectId, input.slotId, slot.revision,
        input.clientId, input.requestId, input.prompt, at, at);
      const claimed = this.#context.database.raw.prepare(
        `UPDATE kernel_slots SET active_task_id = ?, updated_at = ?
          WHERE project_id = ? AND slot_id = ? AND revision = ? AND active_task_id IS NULL`,
      ).run(input.taskId, at, input.projectId, input.slotId, slot.revision);
      if (claimed.changes !== 1) throw new Error('Concurrent slot lease conflict');
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_events(task_id,task_revision,event_type,payload_json,created_at)
          VALUES(?,1,'task.created',?,?)`,
      ).run(input.taskId, JSON.stringify({ type: 'task.created' }), at);
      return this.#context.requireTask(input.taskId, input.clientId);
    });
  }

  getTask(taskId: string, clientId: string): TaskRecord {
    return this.#context.requireTask(taskId, clientId);
  }

  findDispatchClientId(taskId: string): string | null {
    const row = this.#context.database.raw.prepare(
      'SELECT client_id AS clientId FROM kernel_tasks WHERE task_id = ?',
    ).get(taskId) as { clientId: string } | undefined;
    return row?.clientId ?? null;
  }

  readTaskAggregate(taskId: string, clientId: string): FullTaskRecord {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      const db = this.#context.database.raw;
      const attempts = db.prepare(
        `SELECT ${ATTEMPT_COLUMNS} FROM kernel_attempts WHERE task_id=? ORDER BY sequence`,
      ).all(taskId).map(decodeAttemptRow);
      const decisions = db.prepare(
        `SELECT ${DECISION_COLUMNS} FROM kernel_decisions WHERE task_id=? ORDER BY created_at,decision_id`,
      ).all(taskId).map(decodeDecisionRow);
      const timers = db.prepare(
        `SELECT ${TIMER_COLUMNS} FROM kernel_timers WHERE task_id=? ORDER BY due_at,timer_id`,
      ).all(taskId).map(decodeTimerRow);
      const results = db.prepare(
        `SELECT ${RESULT_COLUMNS} FROM kernel_results WHERE task_id=?
          ORDER BY (SELECT sequence FROM kernel_attempts a
            WHERE a.attempt_id=kernel_results.attempt_id)`,
      ).all(taskId).map(decodeResultRow);
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

  recordObservationDeferred(taskId: string, clientId: string, reason: string): TaskRecord {
    requireNonempty(reason, 'reason');
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      // Repeated reads inside one provider pacing window must not grow the
      // Task event journal or wake subscribers with identical evidence.
      const latest = this.#context.database.raw.prepare(
        'SELECT event_type AS eventType, payload_json AS payload FROM kernel_events' +
        ' WHERE task_id=? ORDER BY task_revision DESC LIMIT 1',
      ).get(taskId) as { eventType: string; payload: string } | undefined;
      if (latest?.eventType === 'observation.deferred') {
        const previous = JSON.parse(latest.payload) as { reason?: unknown };
        if (previous.reason === reason) return task;
      }
      return this.#context.appendEvent(task, { type: 'observation.deferred', reason });
    });
  }

  recordTaskFinal(input: {
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
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const attempt = this.#context.requireAttempt(input.attemptId, task.taskId);
      if (attempt.kind === 'stop' || attempt.state !== 'acknowledged' ||
        attempt.externalTurnId !== input.externalTurnId) {
        throw new Error('FINAL must match an exact acknowledged answer turn');
      }
      const existing = this.#context.database.raw.prepare(
        `SELECT ${RESULT_COLUMNS} FROM kernel_results WHERE attempt_id=?`,
      ).get(input.attemptId) as Row | undefined;
      if (existing) {
        const result = decodeResultRow(existing);
        if (result.resultId !== input.resultId ||
          result.externalTurnId !== input.externalTurnId ||
          result.answerText !== input.answerText ||
          result.completesTask !== input.completeTask) throw new Error('Conflicting FINAL evidence');
        return result;
      }
      if (isTaskTerminal(task.state) && !task.cancelRequested) {
        throw new Error('Cannot add answer to terminal task');
      }
      this.#context.appendEvent(task, {
        type: 'turn.final', attemptId: input.attemptId, completeTask: input.completeTask,
      });
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_results(result_id,task_id,attempt_id,external_turn_id,
          answer_text,completes_task,observed_at) VALUES(?,?,?,?,?,?,?)`,
      ).run(input.resultId, task.taskId, input.attemptId, input.externalTurnId,
        input.answerText, input.completeTask ? 1 : 0, this.#context.now());
      return decodeResultRow(this.#context.database.raw.prepare(
        `SELECT ${RESULT_COLUMNS} FROM kernel_results WHERE result_id=?`,
      ).get(input.resultId) as Row);
    });
  }

  withTaskCancellationReceipt<T>(input: {
    taskId: string; clientId: string; requestId: string;
  }, apply: () => T): T {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      requireNonempty(input.requestId, 'requestId');
      const earlier = this.#context.database.raw.prepare(
        'SELECT task_id AS taskId,result_json AS resultJson' +
        ' FROM kernel_task_cancel_receipts WHERE client_id=? AND request_id=?',
      ).get(input.clientId, input.requestId) as
        { taskId: string; resultJson: string } | undefined;
      if (earlier !== undefined) {
        if (earlier.taskId !== task.taskId) {
          throw new SessionPlaneDomainError('idempotency_conflict',
            'Cancellation requestId is already bound to another task');
        }
        return JSON.parse(earlier.resultJson) as T;
      }
      // The callback must be synchronous and only mutate this same SQLite
      // journal. Nested repository operations use transaction savepoints.
      const result = apply();
      const serialized = JSON.stringify(result);
      if (typeof serialized !== 'string') throw new Error('Cancel receipt cannot be encoded');
      this.#context.database.raw.prepare(
        'INSERT INTO kernel_task_cancel_receipts' +
        '(client_id,request_id,task_id,result_json,committed_at) VALUES(?,?,?,?,?)',
      ).run(input.clientId, input.requestId, input.taskId, serialized, this.#context.now());
      return result;
    });
  }

  requestTaskCancellation(taskId: string, clientId: string): TaskRecord {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      if (task.cancelRequested) return task;
      const next = this.#context.appendEvent(task, { type: 'cancel.requested' });
      this.#context.database.raw.prepare(
        "UPDATE kernel_decisions SET status='superseded' WHERE task_id=? AND status='pending'",
      ).run(taskId);
      this.#context.database.raw.prepare(
        "UPDATE kernel_timers SET status='canceled' WHERE task_id=? AND status='pending'",
      ).run(taskId);
      return next;
    });
  }

  confirmTaskCancellation(taskId: string, clientId: string): TaskRecord {
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      if (task.state === 'canceled') return task;
      if (!task.cancelRequested) throw new Error('No cancellation intent');
      const uncertainStop = this.#context.database.raw.prepare(
        "SELECT state FROM kernel_attempts WHERE task_id=? AND kind='stop'",
      ).get(taskId) as { state: AttemptState } | undefined;
      if (uncertainStop && uncertainStop.state !== 'acknowledged' &&
        uncertainStop.state !== 'failed_before_dispatch') {
        throw new Error('Provider stop not confirmed; cancellation stays uncertain');
      }
      const unfinished = this.#context.database.raw.prepare(
        `SELECT a.attempt_id FROM kernel_attempts a
          LEFT JOIN kernel_results r ON r.attempt_id=a.attempt_id
          WHERE a.task_id=? AND a.kind!='stop'
            AND a.state IN ('dispatched','uncertain','acknowledged')
            AND r.result_id IS NULL LIMIT 1`,
      ).get(taskId);
      if (unfinished && uncertainStop?.state !== 'acknowledged') {
        throw new Error('External mutation unresolved; exact stop ACK required');
      }
      return this.#context.appendEvent(task, { type: 'cancel.confirmed' });
    });
  }

  recordTaskFailure(taskId: string, clientId: string, code: string): TaskRecord {
    requireNonempty(code, 'code');
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(taskId, clientId);
      const inFlight = this.#context.database.raw.prepare(
        `SELECT a.attempt_id FROM kernel_attempts a
          LEFT JOIN kernel_results r ON r.attempt_id=a.attempt_id
          WHERE a.task_id=? AND a.kind!='stop'
            AND (a.state IN ('dispatched','uncertain')
              OR (a.state='acknowledged' AND r.result_id IS NULL)) LIMIT 1`,
      ).get(taskId);
      if (inFlight) throw new Error('Unresolved external attempt cannot become failure');
      return this.#context.appendEvent(task, { type: 'task.failed', code });
    });
  }

  readPublicPermissionGrants(taskId: string, clientId: string): readonly {
    appName: string; toolName: string; allowMode: 'once';
  }[] {
    this.#context.requireTask(taskId, clientId);
    const row = this.#context.database.raw.prepare(
      'SELECT policy_json AS policyJson FROM kernel_public_task_policies WHERE task_id=?',
    ).get(taskId) as { policyJson: string } | undefined;
    if (!row) return [];
    let parsed: unknown;
    try { parsed = JSON.parse(row.policyJson); } catch { return []; }
    const grants = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { agentPermissionGrants?: unknown }).agentPermissionGrants : undefined;
    if (!Array.isArray(grants) || grants.length > 32) return [];
    const exact: Array<{ appName: string; toolName: string; allowMode: 'once' }> = [];
    for (const grant of grants) {
      if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return [];
      const value = grant as { appName?: unknown; toolName?: unknown; allowMode?: unknown };
      if (typeof value.appName !== 'string' ||
          !/^hostspan(?:-[a-z0-9_-]+)?$/.test(value.appName) ||
          typeof value.toolName !== 'string' ||
          !/^[A-Za-z0-9_.-]{1,100}$/.test(value.toolName) || value.allowMode !== 'once') return [];
      exact.push({ appName: value.appName, toolName: value.toolName, allowMode: 'once' });
    }
    return exact;
  }
}
