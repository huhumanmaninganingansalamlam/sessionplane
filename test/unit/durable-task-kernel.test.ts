import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { DurableTaskKernel } from '../../src/core/durable-task-kernel.ts';
import { waitForTaskRevision } from '../../src/core/task-wait.ts';
import type {
  ExactSendIntent,
  ExactTaskProviderPort,
  ExactTurnQuery,
  FinalObservation,
  RecoveryOutcome,
  SendOutcome,
} from '../../src/core/durable-task-kernel.ts';
import {
  INITIAL_TASK_PROJECTION,
  TASK_STATES,
  reduceTaskProjection,
} from '../../src/domain/durable-task.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TaskKernelRepository } from '../../src/storage/task-kernel-repository.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sessionplane-kernel-'));
  const file = join(dir, 'kernel-test.sqlite');
  let database = SessionPlaneDatabase.open(file);
  let store = new TaskKernelRepository(database, () => '2026-11-08T00:00:00.000Z');
  t.after(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const reopen = () => {
    database.close();
    database = SessionPlaneDatabase.open(file);
    store = new TaskKernelRepository(database, () => '2026-11-08T00:00:00.000Z');
    return store;
  };
  return {
    get store() { return store; },
    get database() { return database; },
    reopen,
  };
}

function seed(store: TaskKernelRepository, providerKey = 'chatgpt-fixture') {
  store.openProject({
    projectId: 'project-1', projectKey: 'sessionplane.dev',
    displayName: 'SessionPlane', clientId: 'alice',
  });
  return store.openSlot({
    projectId: 'project-1', clientId: 'alice',
    slotId: 'main', roleKey: 'Main', providerKey,
  });
}

function start(store: TaskKernelRepository, index: number, slotId = 'main') {
  return store.startTask({
    taskId: `task-${index}`,
    projectId: 'project-1',
    slotId,
    expectedSlotRevision: 1,
    clientId: 'alice',
    requestId: `request-${index}`,
    prompt: `original question ${index}`,
  });
}

function initial(store: TaskKernelRepository, index: number) {
  return store.planAttempt({
    taskId: `task-${index}`,
    clientId: 'alice',
    attemptId: `attempt-${index}-initial`,
    kind: 'initial',
    turnKey: `turn-${index}-original`,
    content: `original question ${index}`,
  });
}

class FakeProvider implements ExactTaskProviderPort {
  readonly providerKey: string;
  readonly sends: ExactSendIntent[] = [];
  sendMode: 'ack' | 'uncertain' | 'throw' = 'ack';
  recoveredTurn: string | null = null;
  observedAnswer: string | null = 'verified final';

  constructor(providerKey: string) {
    this.providerKey = providerKey;
  }

  async sendOnce(intent: ExactSendIntent): Promise<SendOutcome> {
    this.sends.push(intent);
    if (this.sendMode === 'throw') throw new Error('simulated provider disconnect');
    if (this.sendMode === 'uncertain') {
      return { kind: 'uncertain', reason: 'ack_not_observed' };
    }
    return { kind: 'verified_ack', externalTurnId: `${this.providerKey}:${intent.attemptId}` };
  }

  async recoverAck(query: ExactTurnQuery): Promise<RecoveryOutcome> {
    if (this.recoveredTurn === null) return { kind: 'unavailable', reason: 'read_only_absent' };
    assert.equal(query.taskId, query.attemptId.split('-').slice(0, 2).join('-').replace('attempt', 'task'));
    return { kind: 'verified_ack', externalTurnId: this.recoveredTurn };
  }

  async observeFinal(query: ExactTurnQuery): Promise<FinalObservation> {
    if (this.observedAnswer === null) return { kind: 'pending' };
    return {
      kind: 'exact_final',
      externalTurnId: query.externalTurnId!,
      answerText: this.observedAnswer,
    };
  }
}

test('pure seven-state reducer rejects invalid transitions and cannot resurrect canceled work', () => {
  assert.deepEqual(TASK_STATES, [
    'working', 'agent_input_required', 'human_input_required', 'uncertain',
    'completed', 'failed', 'canceled',
  ]);
  let state = INITIAL_TASK_PROJECTION;
  state = reduceTaskProjection(state, {
    type: 'decision.required', decisionId: 'd1', audience: 'agent',
  });
  assert.equal(state.state, 'agent_input_required');
  assert.throws(() => reduceTaskProjection(state, {
    type: 'attempt.planned', attemptId: 'a1', kind: 'initial',
  }));
  state = reduceTaskProjection(state, { type: 'decision.resolved', decisionId: 'd1' });
  assert.equal(state.state, 'working');
  state = reduceTaskProjection(state, { type: 'cancel.requested' });
  assert.equal(state.state, 'uncertain');
  assert.equal(state.cancelRequested, true);
  assert.throws(() => reduceTaskProjection(state, {
    type: 'attempt.planned', attemptId: 'a2', kind: 'continuation',
  }));
  state = reduceTaskProjection(state, { type: 'cancel.confirmed' });
  assert.equal(state.state, 'canceled');
  assert.equal(reduceTaskProjection(state, {
    type: 'turn.final', attemptId: 'a1', completeTask: true,
  }).state, 'canceled');
  assert.throws(() => reduceTaskProjection(state, {
    type: 'decision.required', decisionId: 'd2', audience: 'human',
  }));
});

test('project authorization, stable logical slots and one unresolved task lease', t => {
  const { store } = fixture(t);
  seed(store);
  const second = store.openSlot({
    projectId: 'project-1', clientId: 'alice',
    slotId: 'review', roleKey: 'Reviewer', providerKey: 'alternate-fixture',
  });
  assert.equal(second.revision, 1);
  assert.equal(second.providerConversationId, null);
  assert.throws(() => store.openSlot({
    projectId: 'project-1', clientId: 'mallory',
    slotId: 'main', roleKey: 'Main', providerKey: 'chatgpt-fixture',
  }), /access denied/);
  const first = start(store, 1);
  assert.equal(first.slotId, 'main');
  assert.throws(() => start(store, 2), /unresolved task lease/);
  assert.equal(start(store, 3, 'review').slotId, 'review',
    'other role/slot is independent');
  assert.throws(() => store.replaceBinding({
    projectId: 'project-1', slotId: 'main', clientId: 'alice',
    expectedRevision: 1, providerKey: 'alternate-fixture',
    providerConversationId: null,
  }), /busy slot/);
  assert.throws(() => store.getTask('task-1', 'mallory'), /access denied/);
  store.grantAccess('project-1', 'alice', 'bob');
  assert.equal(store.getTask('task-1', 'bob').taskId, first.taskId);
  assert.throws(() => store.grantAccess('project-1', 'bob', 'mallory'), /access denied/);
});

test('crash points: never-before-dispatch planned, ambiguous dispatch and late ACK', async t => {
  const env = fixture(t);
  seed(env.store);
  start(env.store, 1);
  initial(env.store, 1);
  env.reopen();
  assert.equal(env.store.getFullTask('task-1', 'alice').attempts[0]!.state, 'planned');
  assert.equal(env.store.recoverInterruptedDispatches(), 0);
  env.store.beginDispatch('task-1', 'alice', 'attempt-1-initial');
  assert.throws(() => env.store.beginDispatch(
    'task-1', 'alice', 'attempt-1-initial',
  ), /Dispatch already consumed/);
  env.reopen();
  assert.equal(env.store.recoverInterruptedDispatches(), 1);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'uncertain');
  assert.equal(env.store.recoverInterruptedDispatches(), 0);
  assert.throws(() => env.store.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'another',
    kind: 'initial', turnKey: 'new', content: 'original question 1',
  }), /Original attempt already exists/);
  assert.throws(() => env.store.recordFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    externalTurnId: 'unverified', resultId: 'bad', answerText: 'wrong',
    completeTask: true,
  }), /exact acknowledged/);
  const fake = new FakeProvider('chatgpt-fixture');
  fake.recoveredTurn = 'chatgpt-fixture:attempt-1-initial';
  const kernel = new DurableTaskKernel(env.store, [fake]);
  assert.equal((await kernel.recoverAck('task-1', 'alice', 'attempt-1-initial')).state, 'working');
  assert.equal(fake.sends.length, 0, 'recovery MUST NOT submit');
  const result = await kernel.observeFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    resultId: 'result-1', completeTask: true,
  });
  assert.equal(result!.answerText, 'verified final');
  assert.equal(env.store.getTask('task-1', 'alice').state, 'completed');
  assert.equal(env.store.getFullTask('task-1', 'alice').events.length, 6);
});

test('two fake providers share one protocol-neutral dispatch/ACK/FINAL path', async t => {
  const env = fixture(t);
  seed(env.store);
  env.store.openSlot({
    projectId: 'project-1', clientId: 'alice',
    slotId: 'review', roleKey: 'Reviewer', providerKey: 'alternate-fixture',
  });
  start(env.store, 1);
  start(env.store, 2, 'review');
  initial(env.store, 1);
  initial(env.store, 2);
  const one = new FakeProvider('chatgpt-fixture');
  const two = new FakeProvider('alternate-fixture');
  const kernel = new DurableTaskKernel(env.store, [one, two]);
  await Promise.all([
    kernel.dispatch('task-1', 'alice', 'attempt-1-initial'),
    kernel.dispatch('task-2', 'alice', 'attempt-2-initial'),
  ]);
  assert.equal(one.sends.length, 1);
  assert.equal(two.sends.length, 1);
  assert.equal(one.sends[0]!.slotId, 'main');
  assert.equal(two.sends[0]!.slotId, 'review');
  assert.equal(env.store.getTask('task-1', 'alice').state, 'working');
  assert.equal(env.store.getTask('task-2', 'alice').state, 'working');
  const a = await kernel.observeFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    resultId: 'result-1', completeTask: true,
  });
  assert.equal(a!.externalTurnId, 'chatgpt-fixture:attempt-1-initial');
  env.store.requireDecision({
    taskId: 'task-2', clientId: 'alice', decisionId: 'decision-2',
    audience: 'agent', contextJson: JSON.stringify({ reason: 'more_context' }),
  });
  assert.equal(env.store.getTask('task-2', 'alice').state, 'agent_input_required');
  assert.equal(env.store.getTask('task-1', 'alice').state, 'completed');
  assert.deepEqual(env.store.listPendingDecisions('project-1', 'alice').map(d => d.decisionId),
    ['decision-2']);
  assert.throws(() => env.store.recordFinal({
    taskId: 'task-2', clientId: 'alice', attemptId: 'attempt-1-initial',
    externalTurnId: a!.externalTurnId, resultId: 'foreign',
    answerText: 'wrong task', completeTask: true,
  }), /not owned by this task/);
});

test('same Main three questions each retain separate task, root/continue turns and answers', async t => {
  const env = fixture(t);
  seed(env.store);
  const fake = new FakeProvider('chatgpt-fixture');
  const kernel = new DurableTaskKernel(env.store, [fake]);
  const results = [];
  for (const n of [1, 2, 3]) {
    start(env.store, n);
    initial(env.store, n);
    await kernel.dispatch(`task-${n}`, 'alice', `attempt-${n}-initial`);
    const root = await kernel.observeFinal({
      taskId: `task-${n}`, clientId: 'alice',
      attemptId: `attempt-${n}-initial`, resultId: `result-${n}-original`,
      completeTask: n !== 2,
    });
    results.push(root!.resultId);
    if (n === 2) {
      env.store.planAttempt({
        taskId: 'task-2', clientId: 'alice', attemptId: 'attempt-2-continue',
        kind: 'continuation', turnKey: 'turn-2-continue', content: 'continue',
      });
      await kernel.dispatch('task-2', 'alice', 'attempt-2-continue');
      const continued = await kernel.observeFinal({
        taskId: 'task-2', clientId: 'alice', attemptId: 'attempt-2-continue',
        resultId: 'result-2-continue', completeTask: true,
      });
      assert.equal(continued!.attemptId, 'attempt-2-continue');
    }
    assert.equal(env.store.getTask(`task-${n}`, 'alice').state, 'completed');
    assert.equal(env.store.getSlot('project-1', 'main', 'alice').activeTaskId, null);
  }
  assert.deepEqual(results, ['result-1-original', 'result-2-original', 'result-3-original']);
  assert.deepEqual(env.store.getFullTask('task-2', 'alice').results.map(r => r.resultId),
    ['result-2-original', 'result-2-continue']);
  assert.equal(env.store.getFullTask('task-2', 'alice').attempts.length, 2);
  assert.equal(fake.sends.length, 4);
});

test('due timers survive restart, do not share wait lifecycle, and fire once', t => {
  const env = fixture(t);
  seed(env.store);
  env.store.openSlot({
    projectId: 'project-1', clientId: 'alice',
    slotId: 'review', roleKey: 'Reviewer', providerKey: 'alternate-fixture',
  });
  start(env.store, 1);
  start(env.store, 2, 'review');
  for (const n of [1, 2]) {
    env.store.scheduleTimer({
      taskId: `task-${n}`, clientId: 'alice', timerId: `timer-${n}`,
      kind: 'continuation_due', dueAt: '2026-11-08T00:20:00.000Z',
      contextJson: JSON.stringify({ intervalMs: 1200000 }),
    });
  }
  env.reopen();
  assert.equal(env.store.claimDueTimers('2026-11-08T00:19:59.999Z').length, 0);
  assert.deepEqual(
    env.store.claimDueTimers('2026-11-08T00:20:00.000Z').map(r => r.timerId),
    ['timer-1', 'timer-2'],
  );
  assert.equal(env.store.claimDueTimers('2026-11-09T00:00:00.000Z').length, 0);
  assert.equal(env.store.getFullTask('task-1', 'alice').timers[0]!.status, 'fired');
  assert.equal(env.store.getFullTask('task-2', 'alice').timers[0]!.status, 'fired');
  assert.equal(env.store.getTask('task-1', 'alice').state, 'working');
  assert.equal(env.store.getTask('task-2', 'alice').state, 'working');
});

test('agent decision persists offline, ACL holds, and action is consumed only once', t => {
  const env = fixture(t);
  seed(env.store);
  start(env.store, 1);
  env.store.requireDecision({
    taskId: 'task-1', clientId: 'alice', decisionId: 'decision-1',
    audience: 'agent', contextJson: JSON.stringify({
      options: [{ actionRef: 'observed-control', risk: 'configuration_only' }],
    }),
  });
  const before = env.store.getTask('task-1', 'alice');
  env.reopen();
  assert.equal(env.store.getTask('task-1', 'alice').revision, before.revision);
  assert.equal(env.store.listPendingDecisions('project-1', 'alice').length, 1);
  assert.throws(() => env.store.resolveDecision({
    taskId: 'task-1', clientId: 'mallory', decisionId: 'decision-1',
    resolutionJson: '{}',
  }), /access denied/);
  assert.equal(env.store.resolveDecision({
    taskId: 'task-1', clientId: 'alice', decisionId: 'decision-1',
    resolutionJson: JSON.stringify({ selectedRef: 'observed-control' }),
  }).status, 'resolved');
  assert.equal(env.store.consumeDecisionAction('task-1', 'alice', 'decision-1'), true);
  assert.equal(env.store.consumeDecisionAction('task-1', 'alice', 'decision-1'), false);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'working');
  assert.equal(env.store.listPendingDecisions('project-1', 'alice').length, 0);
});

test('uncertain stop is not canceled; confirmed stop prevents future continuation and late FINAL resurrection', t => {
  const env = fixture(t);
  seed(env.store);
  start(env.store, 1);
  initial(env.store, 1);
  env.store.beginDispatch('task-1', 'alice', 'attempt-1-initial');
  env.store.markUncertain('task-1', 'alice', 'attempt-1-initial', 'ack_absent');
  assert.equal(env.store.requestCancel('task-1', 'alice').cancelRequested, true);
  assert.throws(() => env.store.confirmCancel('task-1', 'alice'), /stop ACK required/);
  env.store.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'stop-1',
    kind: 'stop', turnKey: 'stop-action-1', content: '',
  });
  env.store.beginDispatch('task-1', 'alice', 'stop-1');
  env.store.markUncertain('task-1', 'alice', 'stop-1', 'stop_unverified');
  assert.throws(() => env.store.confirmCancel('task-1', 'alice'), /stop not confirmed/);
  env.store.acknowledgeAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'stop-1',
    externalTurnId: 'confirmed-stop-receipt',
  });
  assert.equal(env.store.confirmCancel('task-1', 'alice').state, 'canceled');
  env.store.acknowledgeAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    externalTurnId: 'late-initial-ack',
  });
  env.store.recordFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    externalTurnId: 'late-initial-ack', resultId: 'late-evidence',
    answerText: 'already generated', completeTask: true,
  });
  assert.equal(env.store.getTask('task-1', 'alice').state, 'canceled');
  assert.equal(env.store.getFullTask('task-1', 'alice').results[0]!.answerText,
    'already generated');
  assert.throws(() => env.store.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'wrong-continue',
    kind: 'continuation', turnKey: 'wrong', content: 'continue',
  }), /lease|Invalid task transition/);
});

test('failed dispatch path is never silently replayed and large answer is exact', async t => {
  const env = fixture(t);
  seed(env.store);
  start(env.store, 1);
  initial(env.store, 1);
  const fake = new FakeProvider('chatgpt-fixture');
  fake.sendMode = 'throw';
  const kernel = new DurableTaskKernel(env.store, [fake]);
  assert.equal((await kernel.dispatch('task-1', 'alice', 'attempt-1-initial')).state,
    'uncertain');
  assert.equal(fake.sends.length, 1);
  await assert.rejects(() => kernel.dispatch(
    'task-1', 'alice', 'attempt-1-initial',
  ), /no replay/);
  const acknowledged = 'chatgpt-fixture:attempt-1-initial';
  fake.recoveredTurn = acknowledged;
  await kernel.recoverAck('task-1', 'alice', 'attempt-1-initial');
  fake.observedAnswer = '한국어 답변 '.repeat(30000);
  const stored = await kernel.observeFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    resultId: 'large-result', completeTask: true,
  });
  assert.equal(stored!.answerText, fake.observedAnswer);
  assert.equal(env.store.getFullTask('task-1', 'alice').results[0]!.answerText,
    fake.observedAnswer);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'completed');
});

test('transactional event journal replays the exact materialized public projection', t => {
  const env = fixture(t);
  seed(env.store);
  start(env.store, 1);
  initial(env.store, 1);
  env.store.beginDispatch('task-1', 'alice', 'attempt-1-initial');
  env.store.markUncertain('task-1', 'alice', 'attempt-1-initial', 'crash');
  env.store.acknowledgeAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    externalTurnId: 'verified',
  });
  env.store.scheduleTimer({
    taskId: 'task-1', clientId: 'alice', timerId: 'timer-x', kind: 'review',
    dueAt: '2026-11-08T00:20:00Z', contextJson: '{}',
  });
  env.store.claimDueTimers('2026-11-08T00:20:00Z');
  const full = env.store.getFullTask('task-1', 'alice');
  let replay = INITIAL_TASK_PROJECTION;
  for (const event of full.events.slice(1)) {
    replay = reduceTaskProjection(replay, event.event);
  }
  assert.deepEqual({
    state: replay.state,
    cancelRequested: replay.cancelRequested,
    pendingDecisionId: replay.pendingDecisionId,
  }, {
    state: full.task.state,
    cancelRequested: full.task.cancelRequested,
    pendingDecisionId: full.task.pendingDecisionId,
  });
  assert.deepEqual(full.events.map(r => r.taskRevision),
    full.events.map((_, index) => index + 1));
});

test('slot replacement preserves exact historical provider binding and late result evidence', async t => {
  const env = fixture(t);
  seed(env.store);
  start(env.store, 1);
  initial(env.store, 1);
  env.store.beginDispatch('task-1', 'alice', 'attempt-1-initial');
  env.store.observeConversation({
    projectId: 'project-1', clientId: 'alice', slotId: 'main',
    expectedRevision: 1, taskId: 'task-1', providerConversationId: 'old-exact-conversation',
  });
  env.store.markUncertain('task-1', 'alice', 'attempt-1-initial', 'lost_ack');
  env.store.requestCancel('task-1', 'alice');
  env.store.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'old-stop',
    kind: 'stop', turnKey: 'old-stop-key', content: '',
  });
  env.store.beginDispatch('task-1', 'alice', 'old-stop');
  env.store.acknowledgeAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'old-stop',
    externalTurnId: 'stop-ack',
  });
  env.store.confirmCancel('task-1', 'alice');
  const replaced = env.store.replaceBinding({
    projectId: 'project-1', slotId: 'main', clientId: 'alice',
    expectedRevision: 1, providerKey: 'alternate-fixture',
    providerConversationId: 'replacement-conversation',
  });
  assert.equal(replaced.revision, 2);
  assert.equal(env.store.getBindingAtRevision('project-1', 'main', 1, 'alice')
    .providerConversationId, 'old-exact-conversation');
  assert.equal(env.store.getBindingAtRevision('project-1', 'main', 1, 'alice')
    .providerKey, 'chatgpt-fixture');
  const oldAdapter = new FakeProvider('chatgpt-fixture');
  oldAdapter.recoveredTurn = 'late-old-turn';
  const newAdapter = new FakeProvider('alternate-fixture');
  const kernel = new DurableTaskKernel(env.store, [oldAdapter, newAdapter]);
  await kernel.recoverAck('task-1', 'alice', 'attempt-1-initial');
  const late = await kernel.observeFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    resultId: 'late-result', completeTask: true,
  });
  assert.equal(late!.externalTurnId, 'late-old-turn');
  assert.equal(oldAdapter.sends.length, 0);
  assert.equal(newAdapter.sends.length, 0);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'canceled');

  env.store.startTask({
    taskId: 'task-2', projectId: 'project-1', slotId: 'main',
    expectedSlotRevision: 2, clientId: 'alice',
    requestId: 'new-unique-request', prompt: 'new conversation question',
  });
  env.store.planAttempt({
    taskId: 'task-2', clientId: 'alice', attemptId: 'new-attempt',
    kind: 'initial', turnKey: 'new-turn', content: 'new conversation question',
  });
  await kernel.dispatch('task-2', 'alice', 'new-attempt');
  assert.equal(newAdapter.sends.length, 1);
  assert.equal(newAdapter.sends[0]!.providerConversationId, 'replacement-conversation');
  assert.equal(newAdapter.sends[0]!.slotRevision, 2);
  assert.equal(oldAdapter.sends.length, 0);
});

test('wrong-turn FINAL and unavailable observation never fabricate completion', async t => {
  const env = fixture(t);
  seed(env.store);
  start(env.store, 1);
  initial(env.store, 1);
  class WrongTurnProvider extends FakeProvider {
    override async observeFinal(_query: ExactTurnQuery): Promise<FinalObservation> {
      return { kind: 'exact_final', externalTurnId: 'different-turn', answerText: 'wrong' };
    }
  }
  const bad = new WrongTurnProvider('chatgpt-fixture');
  const kernel = new DurableTaskKernel(env.store, [bad]);
  await kernel.dispatch('task-1', 'alice', 'attempt-1-initial');
  await assert.rejects(() => kernel.observeFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    resultId: 'wrong', completeTask: true,
  }), /wrong turn/);
  assert.equal(env.store.getFullTask('task-1', 'alice').results.length, 0);
  assert.throws(() => env.store.failTask('task-1', 'alice', 'timeout'),
    /Unresolved external attempt/);
  assert.equal(env.store.recordObservationDeferred(
    'task-1', 'alice', 'observation_rate_limited',
  ).state, 'working');
  assert.equal(env.store.getFullTask('task-1', 'alice').results.length, 0);
  const good = new FakeProvider('chatgpt-fixture');
  const recovered = new DurableTaskKernel(env.store, [good]);
  const observed = await recovered.observeFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    resultId: 'true-final', completeTask: true,
  });
  assert.equal(observed!.answerText, 'verified final');
  const repeat = await recovered.observeFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1-initial',
    resultId: 'true-final', completeTask: true,
  });
  assert.equal(repeat!.resultId, 'true-final');
  assert.equal(env.store.getFullTask('task-1', 'alice').results.length, 1);
});

test('canceling a waiting decision supersedes its packet and pending timer without affecting other slots', t => {
  const env = fixture(t);
  seed(env.store);
  env.store.openSlot({
    projectId: 'project-1', clientId: 'alice',
    slotId: 'review', roleKey: 'Reviewer', providerKey: 'alternate-fixture',
  });
  start(env.store, 1);
  start(env.store, 2, 'review');
  env.store.requireDecision({
    taskId: 'task-1', clientId: 'alice', decisionId: 'pending-agent',
    audience: 'agent', contextJson: '{}',
  });
  for (const n of [1, 2]) {
    env.store.scheduleTimer({
      taskId: `task-${n}`, clientId: 'alice', timerId: `cancel-timer-${n}`,
      kind: 'due', dueAt: '2026-11-08T00:20:00Z', contextJson: '{}',
    });
  }
  env.store.requestCancel('task-1', 'alice');
  assert.deepEqual(env.store.listPendingDecisions('project-1', 'alice'), []);
  assert.equal(env.store.getFullTask('task-1', 'alice').decisions[0]!.status, 'superseded');
  assert.equal(env.store.getFullTask('task-1', 'alice').timers[0]!.status, 'canceled');
  assert.deepEqual(env.store.claimDueTimers('2026-11-08T00:20:00Z').map(r => r.taskId),
    ['task-2']);
  assert.equal(env.store.getTask('task-2', 'alice').state, 'working');
  assert.equal(env.store.confirmCancel('task-1', 'alice').state, 'canceled',
    'no provider mutation means stop not needed');
});

test('aborting one transient wait never cancels another slot or its durable timer', async t => {
  const env = fixture(t);
  seed(env.store);
  env.store.openSlot({
    projectId: 'project-1', clientId: 'alice',
    slotId: 'review', roleKey: 'Reviewer', providerKey: 'alternate-fixture',
  });
  start(env.store, 1);
  start(env.store, 2, 'review');
  const initialRevision = env.store.getTask('task-2', 'alice').revision;
  const controller = new AbortController();
  const abandoned = waitForTaskRevision(env.store, {
    taskId: 'task-1', clientId: 'alice', afterRevision: 1,
    waitMs: 250, signal: controller.signal,
  });
  const active = waitForTaskRevision(env.store, {
    taskId: 'task-2', clientId: 'alice', afterRevision: initialRevision,
    waitMs: 500,
  });
  controller.abort();
  await assert.rejects(abandoned, /aborted/i);
  env.store.scheduleTimer({
    taskId: 'task-2', clientId: 'alice', timerId: 'still-due',
    kind: 'continuation_due', dueAt: '2026-11-08T00:20:00Z',
    contextJson: '{}',
  });
  const updated = await active;
  assert.equal(updated.taskId, 'task-2');
  assert.ok(updated.revision > initialRevision);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'working');
  assert.deepEqual(env.store.claimDueTimers('2026-11-08T00:20:00Z')
    .map(timer => timer.timerId), ['still-due']);
});
test('consecutive identical FINAL deferrals remain one durable event across Core reopen', t => {
  const env = fixture(t);
  seed(env.store);
  start(env.store, 1);
  const reason = 'final:attempt-1-initial:pending:backend-conversation-pacing';
  const first = env.store.recordObservationDeferred('task-1', 'alice', reason);
  const second = env.store.recordObservationDeferred('task-1', 'alice', reason);
  assert.equal(second.revision, first.revision,
    'the same paced FINAL cannot flood a durable Task with repeated events');
  const changed = env.store.recordObservationDeferred('task-1', 'alice',
    'final:attempt-1-initial:unavailable:backend-http-429');
  assert.equal(changed.revision, first.revision + 1,
    'a materially different read reason must still be retained');
  env.reopen();
  assert.deepEqual(env.store.getFullTask('task-1', 'alice').events
    .filter(e => e.event.type === 'observation.deferred')
    .map(e => (e.event as { reason: string }).reason), [
      reason, 'final:attempt-1-initial:unavailable:backend-http-429',
    ]);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'working');
});
