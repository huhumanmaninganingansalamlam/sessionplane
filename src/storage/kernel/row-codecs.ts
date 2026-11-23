import { TASK_STATES, type AttemptKind, type DecisionAudience, type TaskState } from '../../domain/durable-task.ts';
import type {
  ProjectRecord, SlotRecord, SlotBindingRecord, TaskRecord, AttemptRecord, AttemptState,
  DecisionRecord, TimerRecord, ResultRecord,
} from './records.ts';

// SQLite returns untyped rows. Check each durable field before exposing it to
// the scheduler, rather than coercing absent columns into "undefined"/NaN.
export type Row = Record<string, unknown>;
function asRow(input: unknown, name: string): Row {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Invalid ${name} row: expected an object`);
  }
  return input as Row;
}

function requiredString(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(`Invalid SQLite ${field}: expected text`);
  return value;
}
function optionalString(row: Row, field: string): string | null {
  const value = row[field];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid SQLite ${field}: expected text or null`);
  return value;
}
function requiredInt(row: Row, field: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid SQLite ${field}: expected a safe integer`);
  }
  return value;
}
function flag(row: Row, field: string): boolean {
  const value = requiredInt(row, field);
  if (value !== 0 && value !== 1) throw new Error(`Invalid SQLite ${field}: expected 0 or 1`);
  return value === 1;
}
function enumValue<const T extends readonly string[]>(row: Row, field: string, options: T): T[number] {
  const value = requiredString(row, field);
  if (!options.includes(value)) throw new Error(`Invalid SQLite ${field}: unsupported value`);
  return value as T[number];
}

export const TASK_COLUMNS = `task_id AS taskId, project_id AS projectId,
  slot_id AS slotId, slot_revision AS slotRevision, client_id AS clientId,
  request_id AS requestId, original_prompt AS originalPrompt, state,
  cancel_requested AS cancelRequested, pending_decision_id AS pendingDecisionId,
  revision, created_at AS createdAt, updated_at AS updatedAt`;
export const ATTEMPT_COLUMNS = `attempt_id AS attemptId, task_id AS taskId,
  sequence, kind, turn_key AS turnKey, content, state,
  external_turn_id AS externalTurnId, dispatched_at AS dispatchedAt,
  acknowledged_at AS acknowledgedAt`;
export const DECISION_COLUMNS = `decision_id AS decisionId, task_id AS taskId,
  audience, context_json AS contextJson, status,
  resolution_json AS resolutionJson, action_consumed AS actionConsumed`;
export const TIMER_COLUMNS = `timer_id AS timerId, task_id AS taskId, kind,
  due_at AS dueAt, context_json AS contextJson, status`;
export const RESULT_COLUMNS = `result_id AS resultId, task_id AS taskId,
  attempt_id AS attemptId, external_turn_id AS externalTurnId,
  answer_text AS answerText, completes_task AS completesTask,
  observed_at AS observedAt`;

export function decodeProjectRow(input: unknown): ProjectRecord {
  const row = asRow(input, 'project');
  return {
    projectId: requiredString(row, 'projectId'),
    projectKey: requiredString(row, 'projectKey'),
    displayName: requiredString(row, 'displayName'),
  };
}

export function decodeConversationSlotRow(input: unknown): SlotRecord {
  const row = asRow(input, 'conversation slot');
  return {
    projectId: requiredString(row, 'projectId'),
    slotId: requiredString(row, 'slotId'),
    roleKey: requiredString(row, 'roleKey'),
    providerKey: requiredString(row, 'providerKey'),
    providerConversationId: optionalString(row, 'providerConversationId'),
    revision: requiredInt(row, 'revision'),
    activeTaskId: optionalString(row, 'activeTaskId'),
  };
}

export function decodeSlotBindingRow(input: unknown): SlotBindingRecord {
  const row = asRow(input, 'slot binding');
  return {
    projectId: requiredString(row, 'projectId'),
    slotId: requiredString(row, 'slotId'),
    providerKey: requiredString(row, 'providerKey'),
    providerConversationId: optionalString(row, 'providerConversationId'),
    revision: requiredInt(row, 'revision'),
  };
}

export function decodeTaskRow(input: unknown): TaskRecord {
  const row = asRow(input, 'task');
  return {
    taskId: requiredString(row, 'taskId'),
    projectId: requiredString(row, 'projectId'),
    slotId: requiredString(row, 'slotId'),
    slotRevision: requiredInt(row, 'slotRevision'),
    clientId: requiredString(row, 'clientId'),
    requestId: requiredString(row, 'requestId'),
    originalPrompt: requiredString(row, 'originalPrompt'),
    state: enumValue(row, 'state', TASK_STATES) as TaskState,
    cancelRequested: flag(row, 'cancelRequested'),
    pendingDecisionId: optionalString(row, 'pendingDecisionId'),
    revision: requiredInt(row, 'revision'),
    createdAt: requiredString(row, 'createdAt'),
    updatedAt: requiredString(row, 'updatedAt'),
  };
}

export function decodeAttemptRow(input: unknown): AttemptRecord {
  const row = asRow(input, 'attempt');
  return {
    attemptId: requiredString(row, 'attemptId'),
    taskId: requiredString(row, 'taskId'),
    sequence: requiredInt(row, 'sequence'),
    kind: enumValue(row, 'kind', ['initial', 'continuation', 'stop'] as const) as AttemptKind,
    turnKey: requiredString(row, 'turnKey'),
    content: requiredString(row, 'content'),
    state: enumValue(row, 'state',
      ['planned', 'dispatched', 'acknowledged', 'uncertain', 'failed_before_dispatch'] as const) as AttemptState,
    externalTurnId: optionalString(row, 'externalTurnId'),
    dispatchedAt: optionalString(row, 'dispatchedAt'),
    acknowledgedAt: optionalString(row, 'acknowledgedAt'),
  };
}

export function decodeDecisionRow(input: unknown): DecisionRecord {
  const row = asRow(input, 'decision');
  return {
    decisionId: requiredString(row, 'decisionId'),
    taskId: requiredString(row, 'taskId'),
    audience: enumValue(row, 'audience', ['agent', 'human'] as const) as DecisionAudience,
    contextJson: requiredString(row, 'contextJson'),
    status: enumValue(row, 'status', ['pending', 'resolved', 'superseded'] as const),
    resolutionJson: optionalString(row, 'resolutionJson'),
    actionConsumed: flag(row, 'actionConsumed'),
  };
}

export function decodeTimerRow(input: unknown): TimerRecord {
  const row = asRow(input, 'timer');
  return {
    timerId: requiredString(row, 'timerId'),
    taskId: requiredString(row, 'taskId'),
    kind: requiredString(row, 'kind'),
    dueAt: requiredString(row, 'dueAt'),
    contextJson: requiredString(row, 'contextJson'),
    status: enumValue(row, 'status', ['pending', 'fired', 'canceled'] as const),
  };
}

export function decodeResultRow(input: unknown): ResultRecord {
  const row = asRow(input, 'result');
  return {
    resultId: requiredString(row, 'resultId'),
    taskId: requiredString(row, 'taskId'),
    attemptId: requiredString(row, 'attemptId'),
    externalTurnId: requiredString(row, 'externalTurnId'),
    answerText: requiredString(row, 'answerText'),
    completesTask: flag(row, 'completesTask'),
    observedAt: requiredString(row, 'observedAt'),
  };
}

export function requireNonempty(value: string, name: string): void {
  if (value.trim() === '') throw new Error(`${name} must be nonempty`);
}
