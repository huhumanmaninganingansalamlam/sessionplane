import type { Row } from './row-codecs.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { reduceTaskProjection, isTaskTerminal } from '../../domain/durable-task.ts';
import type { TaskEvent, TaskProjection } from '../../domain/durable-task.ts';
import type { SessionPlaneDatabase } from '../database.ts';
import type { SlotRecord, TaskRecord, AttemptRecord, DecisionRecord } from './records.ts';
import { TASK_COLUMNS, ATTEMPT_COLUMNS, DECISION_COLUMNS, decodeTaskRow, decodeAttemptRow, decodeDecisionRow, decodeConversationSlotRow } from './row-codecs.ts';

/** Shared authorized read/event primitives. The calling store owns each
 * transaction; these helpers never start an implicit nested transaction. */
export class KernelTransactionContext {
  readonly database: SessionPlaneDatabase;
  readonly now: () => string;

  constructor(database: SessionPlaneDatabase, now: () => string) {
    this.database = database;
    this.now = now;
  }

  requireAccess(projectId: string, clientId: string, role?: 'owner'): void {
    const row = this.database.raw.prepare(
      'SELECT access_role AS accessRole FROM kernel_project_access WHERE project_id=? AND client_id=?',
    ).get(projectId, clientId) as { accessRole: string } | undefined;
    if (!row || (role && row.accessRole !== role)) {
      throw new SessionPlaneDomainError('invalid_request', 'Project access denied');
    }
  }

  findSlot(projectId: string, slotId: string): SlotRecord | null {
    const row = this.database.raw.prepare(
      `SELECT project_id AS projectId,slot_id AS slotId,role_key AS roleKey,
        provider_key AS providerKey,provider_conversation_id AS providerConversationId,
        revision,active_task_id AS activeTaskId FROM kernel_slots
        WHERE project_id=? AND slot_id=?`,
    ).get(projectId, slotId) as Row | undefined;
    return row ? decodeConversationSlotRow(row) : null;
  }

  requireSlot(projectId: string, slotId: string): SlotRecord {
    const slot = this.findSlot(projectId, slotId);
    if (!slot) throw new Error('Unknown logical conversation slot');
    return slot;
  }

  requireTask(taskId: string, clientId: string): TaskRecord {
    const row = this.database.raw.prepare(
      `SELECT ${TASK_COLUMNS} FROM kernel_tasks WHERE task_id=?`,
    ).get(taskId) as Row | undefined;
    if (!row) throw new Error('Unknown task');
    const task = decodeTaskRow(row);
    this.requireAccess(task.projectId, clientId);
    return task;
  }

  requireAttempt(attemptId: string, taskId: string): AttemptRecord {
    const row = this.database.raw.prepare(
      `SELECT ${ATTEMPT_COLUMNS} FROM kernel_attempts
        WHERE attempt_id=? AND task_id=?`,
    ).get(attemptId, taskId) as Row | undefined;
    if (!row) throw new Error('Attempt is not owned by this task');
    return decodeAttemptRow(row);
  }

  requireDecision(decisionId: string, taskId: string): DecisionRecord {
    const row = this.database.raw.prepare(
      `SELECT ${DECISION_COLUMNS} FROM kernel_decisions
        WHERE decision_id=? AND task_id=?`,
    ).get(decisionId, taskId) as Row | undefined;
    if (!row) throw new Error('Decision is not owned by this task');
    return decodeDecisionRow(row);
  }

  appendEvent(task: TaskRecord, event: TaskEvent): TaskRecord {
    const next: TaskProjection = reduceTaskProjection(task, event);
    const at = this.now();
    const revision = task.revision + 1;
    const changed = this.database.raw.prepare(
      `UPDATE kernel_tasks SET state=?,cancel_requested=?,
        pending_decision_id=?,revision=?,updated_at=?
        WHERE task_id=? AND revision=?`,
    ).run(next.state, next.cancelRequested ? 1 : 0,
      next.pendingDecisionId, revision, at, task.taskId, task.revision);
    if (changed.changes !== 1) throw new Error('Concurrent task revision conflict');
    this.database.raw.prepare(
      `INSERT INTO kernel_events(task_id,task_revision,event_type,payload_json,created_at)
        VALUES(?,?,?,?,?)`,
    ).run(task.taskId, revision, event.type, JSON.stringify(event), at);
    if (!isTaskTerminal(task.state) && isTaskTerminal(next.state)) {
      const released = this.database.raw.prepare(
        `UPDATE kernel_slots SET active_task_id=NULL,updated_at=?
          WHERE project_id=? AND slot_id=? AND revision=? AND active_task_id=?`,
      ).run(at, task.projectId, task.slotId, task.slotRevision, task.taskId);
      if (released.changes !== 1) throw new Error('Lost task lease before terminal transition');
      this.database.raw.prepare(
        "UPDATE kernel_timers SET status='canceled' WHERE task_id=? AND status='pending'",
      ).run(task.taskId);
      this.database.raw.prepare(
        "UPDATE kernel_decisions SET status='superseded' WHERE task_id=? AND status='pending'",
      ).run(task.taskId);
    }
    return { ...task, ...next, revision, updatedAt: at };
  }
}
