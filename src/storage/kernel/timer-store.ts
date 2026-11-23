import type { Row } from './row-codecs.ts';
import { isTaskTerminal } from '../../domain/durable-task.ts';
import type { TimerRecord } from './records.ts';
import { TASK_COLUMNS, TIMER_COLUMNS, decodeTaskRow, decodeTimerRow, requireNonempty } from './row-codecs.ts';
import type { KernelTransactionContext } from './transaction-context.ts';

export class TimerStore {
  readonly #context: KernelTransactionContext;

  constructor(context: KernelTransactionContext) {
    this.#context = context;
  }

  scheduleTaskTimer(input: {
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
    return this.#context.database.transaction(() => {
      const task = this.#context.requireTask(input.taskId, input.clientId);
      const row = this.#context.database.raw.prepare(
        `SELECT ${TIMER_COLUMNS} FROM kernel_timers WHERE timer_id=?`,
      ).get(input.timerId) as Row | undefined;
      if (row) {
        const existing = decodeTimerRow(row);
        if (existing.taskId !== task.taskId || existing.kind !== input.kind ||
          existing.dueAt !== due || existing.contextJson !== input.contextJson) {
          throw new Error('Timer identity conflict');
        }
        return existing;
      }
      if (task.cancelRequested || isTaskTerminal(task.state)) {
        throw new Error('No timer after cancellation/terminal state');
      }
      this.#context.appendEvent(task, { type: 'timer.scheduled', timerId: input.timerId });
      this.#context.database.raw.prepare(
        `INSERT INTO kernel_timers(timer_id,task_id,kind,due_at,context_json,
          status,created_at,fired_at) VALUES(?,?,?,?,?,'pending',?,NULL)`,
      ).run(input.timerId, task.taskId, input.kind, due, input.contextJson, this.#context.now());
      return decodeTimerRow(this.#context.database.raw.prepare(
        `SELECT ${TIMER_COLUMNS} FROM kernel_timers WHERE timer_id=?`,
      ).get(input.timerId) as Row);
    });
  }

  claimDueTaskTimers(nowIso: string, limit = 50, kind?: string): readonly TimerRecord[] {
    const now = new Date(nowIso).toISOString();
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid timer limit');
    if (kind !== undefined) requireNonempty(kind, 'timer kind');
    return this.#context.database.transaction(() => {
      const rows = this.#context.database.raw.prepare(
        `SELECT ${TIMER_COLUMNS} FROM kernel_timers
          WHERE status='pending' AND due_at<=?${kind === undefined ? '' : ' AND kind=?'}
          ORDER BY due_at,timer_id LIMIT ?`,
      ).all(...(kind === undefined ? [now, limit] : [now, kind, limit])) as Row[];
      const claimed: TimerRecord[] = [];
      for (const row of rows) {
        const timer = decodeTimerRow(row);
        const taskRow = this.#context.database.raw.prepare(
          `SELECT ${TASK_COLUMNS} FROM kernel_tasks WHERE task_id=?`,
        ).get(timer.taskId) as Row;
        const task = decodeTaskRow(taskRow);
        if (task.cancelRequested || isTaskTerminal(task.state)) {
          this.#context.database.raw.prepare(
            "UPDATE kernel_timers SET status='canceled' WHERE timer_id=? AND status='pending'",
          ).run(timer.timerId);
          continue;
        }
        this.#context.appendEvent(task, { type: 'timer.fired', timerId: timer.timerId });
        const changed = this.#context.database.raw.prepare(
          "UPDATE kernel_timers SET status='fired',fired_at=? WHERE timer_id=? AND status='pending'",
        ).run(now, timer.timerId);
        if (changed.changes !== 1) throw new Error('Concurrent timer consumption conflict');
        claimed.push({ ...timer, status: 'fired' });
      }
      return claimed;
    });
  }
}
