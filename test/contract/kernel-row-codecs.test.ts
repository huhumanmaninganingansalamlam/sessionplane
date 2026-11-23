import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeAttemptRow, decodeConversationSlotRow, decodeDecisionRow, decodeProjectRow,
  decodeResultRow, decodeSlotBindingRow, decodeTaskRow, decodeTimerRow,
} from '../../src/storage/kernel/row-codecs.ts';

const task = {
  taskId: 'task-1', projectId: 'project-1', slotId: 'main', slotRevision: 2,
  clientId: 'agent-1', requestId: 'r1', originalPrompt: 'exact text',
  state: 'working', cancelRequested: 0, pendingDecisionId: null,
  revision: 3, createdAt: '2026-11-23T00:00:00Z', updatedAt: '2026-11-23T00:01:00Z',
};
test('Task rows preserve exact text, nullable decision and strict numeric flags', () => {
  assert.deepEqual(decodeTaskRow(task), {
    ...task, cancelRequested: false,
  });
  assert.equal(decodeTaskRow({ ...task, cancelRequested: 1 }).cancelRequested, true);
  assert.throws(() => decodeTaskRow({ ...task, cancelRequested: 2 }), /cancelRequested/);
  assert.throws(() => decodeTaskRow({ ...task, slotRevision: '2' }), /slotRevision/);
  assert.throws(() => decodeTaskRow({ ...task, pendingDecisionId: undefined }), /pendingDecisionId/);
  assert.throws(() => decodeTaskRow({ ...task, state: 'finished' }), /state/);
  assert.throws(() => decodeTaskRow(null), /expected an object/);
});

test('attempt and decision rows reject unrecognized persisted state rather than guessing', () => {
  const attempt = { attemptId: 'a', taskId: 'task-1', sequence: 0, kind: 'initial',
    turnKey: 'root', content: '\n exact ', state: 'dispatched',
    externalTurnId: null, dispatchedAt: 'now', acknowledgedAt: null };
  assert.equal(decodeAttemptRow(attempt).content, '\n exact ');
  assert.throws(() => decodeAttemptRow({ ...attempt, kind: 'retry' }), /kind/);
  assert.throws(() => decodeAttemptRow({ ...attempt, state: 'done' }), /state/);
  const decision = { decisionId: 'd', taskId: 'task-1', audience: 'agent',
    contextJson: '{}', status: 'pending', resolutionJson: null, actionConsumed: 0 };
  assert.equal(decodeDecisionRow(decision).actionConsumed, false);
  assert.throws(() => decodeDecisionRow({ ...decision, actionConsumed: 3 }), /actionConsumed/);
});

test('project, slot, immutable binding, Timer and Result reject missing or corrupted SQLite fields', () => {
  assert.equal(decodeProjectRow({ projectId: 'p', projectKey: 'key', displayName: 'Name' }).projectId, 'p');
  assert.throws(() => decodeProjectRow({ projectId: 'p', projectKey: null, displayName: 'x' }), /projectKey/);
  const slot = { projectId: 'p', slotId: 'main', roleKey: 'main', providerKey: 'chatgpt',
    providerConversationId: null, revision: 1, activeTaskId: null };
  assert.equal(decodeConversationSlotRow(slot).activeTaskId, null);
  assert.throws(() => decodeConversationSlotRow({ ...slot, providerConversationId: 0 }), /providerConversationId/);
  assert.equal(decodeSlotBindingRow({ projectId: 'p', slotId: 'main', providerKey: 'chatgpt',
    providerConversationId: null, revision: 1 }).revision, 1);
  const timer = { timerId: 'timer-1', taskId: 'task-1', kind: 'continue',
    dueAt: 'later', contextJson: '{}', status: 'pending' };
  assert.equal(decodeTimerRow(timer).dueAt, 'later');
  assert.throws(() => decodeTimerRow({ ...timer, status: 'done' }), /status/);
  const result = { resultId: 'res', taskId: 'task-1', attemptId: 'a',
    externalTurnId: 'turn', answerText: '답변', completesTask: 1, observedAt: 'now' };
  assert.equal(decodeResultRow(result).completesTask, true);
  assert.throws(() => decodeResultRow({ ...result, completesTask: '1' }), /completesTask/);
});
