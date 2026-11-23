import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  CONTINUATION_DUE_READ_RESERVATION_MS, CONTINUATION_INTERVAL_MS,
  ManagedContinuationService,
} from '../../src/core/managed-continuation.ts';
import { DurableTaskKernel } from '../../src/core/durable-task-kernel.ts';
import type {
  ExactSendIntent, ExactTaskProviderPort, ExactTurnQuery,
  RecoveryOutcome, FinalObservation, SendOutcome,
} from '../../src/core/durable-task-kernel.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { createKernelStores, type KernelStores } from '../../src/storage/kernel/create-kernel-stores.ts';

class FakeProvider implements ExactTaskProviderPort {
  readonly providerKey = 'provider-fixture';
  readonly sends: ExactSendIntent[] = [];
  readonly blocked = new Set<string>();
  readonly pendingInitialFinals = new Set<string>();
  readonly readyContinuationFinals = new Set<string>();
  readonly observedFinalAttemptIds: string[] = [];
  readonly observedFinalPriorities: Array<string | undefined> = [];
  readonly finalReadReservations: Array<{ attemptId: string; notBefore: string }> = [];
  readonly preflightAttemptIds: string[] = [];
  readonly recoveredAckAttemptIds: string[] = [];
  readonly unavailableFinals = new Set<string>();
  readonly pending429Finals = new Set<string>();
  readonly pacedFinals = new Set<string>();
  pending429NextCheckAt: string | null = null;
  pacedNextCheckAt: string | null = null;
  readonly laterUserFinals = new Set<string>();
  async preflight(intent: ExactSendIntent): Promise<
    { kind: 'ready' } | { kind: 'unavailable'; reason: string }
  > {
    this.preflightAttemptIds.push(intent.attemptId);
    return this.blocked.has(intent.taskId)
      ? { kind: 'unavailable', reason: 'fixture-provider-streaming' }
      : { kind: 'ready' };
  }
  async sendOnce(intent: ExactSendIntent): Promise<SendOutcome> {
    this.sends.push(intent);
    return { kind: 'verified_ack', externalTurnId: 'turn:' + intent.attemptId };
  }
  async recoverAck(query: ExactTurnQuery): Promise<RecoveryOutcome> {
    this.recoveredAckAttemptIds.push(query.attemptId);
    return { kind: 'unavailable', reason: 'fake-no-backend' };
  }
  async reserveFinalRead(query: ExactTurnQuery, notBefore: string): Promise<void> {
    this.finalReadReservations.push({ attemptId: query.attemptId, notBefore });
  }
  async observeFinal(query: ExactTurnQuery): Promise<FinalObservation> {
    this.observedFinalAttemptIds.push(query.attemptId);
    this.observedFinalPriorities.push(query.readPriority);
    if (this.unavailableFinals.has(query.attemptId)) {
      return { kind: 'unavailable', reason: 'fixture-backend-http-429' };
    }
    if (this.pending429Finals.has(query.attemptId)) {
      return { kind: 'pending', reason: 'backend-http-429',
        nextCheckAt: this.pending429NextCheckAt };
    }
    if (this.pacedFinals.has(query.attemptId)) {
      return { kind: 'pending', reason: 'backend-conversation-probe-paced',
        nextCheckAt: this.pacedNextCheckAt };
    }
    if (this.laterUserFinals.has(query.attemptId)) {
      return { kind: 'pending', reason: 'backend-next-user-turn-before-final' };
    }
    if (this.pendingInitialFinals.has(query.attemptId) ||
        (query.attemptId.startsWith('managed-continuation:') &&
          !this.readyContinuationFinals.has(query.attemptId))) {
      return { kind: 'pending', reason: 'backend-assistant-missing' };
    }
    return { kind: 'exact_final',
      externalTurnId: query.externalTurnId!, answerText: 'Exact final for ' + query.attemptId };
  }
}

const START = Date.parse('2026-11-12T00:00:00.000Z');

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-managed-continuation-'));
  const file = join(root, 'kernel.sqlite');
  let current = START;
  let database = SessionPlaneDatabase.open(file);
  let store = createKernelStores(database, () => new Date(current).toISOString());
  const fake = new FakeProvider();
  let kernel = new DurableTaskKernel(store, [fake]);
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  store.projects.openProject({ projectId: 'project', projectKey: 'managed.test',
    displayName: 'Managed fixture', clientId: 'alice' });
  const startTask = (taskId: string, slotId: string) => {
    store.projects.openConversationSlot({ projectId: 'project', clientId: 'alice', slotId,
      roleKey: slotId, providerKey: fake.providerKey });
    store.tasks.createTask({ taskId, projectId: 'project', slotId, clientId: 'alice',
      requestId: 'request:' + taskId, expectedSlotRevision: 1,
      prompt: 'Question ' + taskId });
    store.projects.bindObservedConversation({ projectId: 'project', slotId, clientId: 'alice',
      taskId, expectedRevision: 1, providerConversationId: 'conversation:' + taskId });
    store.attempts.planAttempt({ taskId, clientId: 'alice', attemptId: 'initial:' + taskId,
      kind: 'initial', turnKey: 'original', content: 'Question ' + taskId });
  };
  const ack = async (taskId: string, withFinal = false) => {
    await kernel.dispatch(taskId, 'alice', 'initial:' + taskId);
    if (!withFinal) fake.pendingInitialFinals.add('initial:' + taskId);
    if (withFinal) await kernel.observeFinal({ taskId, clientId: 'alice',
      attemptId: 'initial:' + taskId, resultId: 'result:' + taskId,
      completeTask: false });
  };
  const createService = (requestAgentReview?: (input: {
    taskId: string; clientId: string; attemptId: string;
    cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress';
  }) => Promise<void>) => new ManagedContinuationService({
    repository: store, kernel, now: () => new Date(current),
    ...(requestAgentReview ? { requestAgentReview } : {}),
  });
  const seedPublicPolicy = (taskId: string, enabled = false, agentReviewAfterMs?: number) => {
    database.raw.prepare(
      'INSERT INTO kernel_public_task_policies' +
      '(task_id,policy_json,input_sha256,accepted_revision,created_at)' +
      ' VALUES(?,?,?,?,?)',
    ).run(taskId, JSON.stringify(enabled ? {
      enabled: true, approvalRef: 'approved-public',
      message: '계속', intervalMs: CONTINUATION_INTERVAL_MS,
      ...(agentReviewAfterMs === undefined ? {} : { agentReviewAfterMs }),
    } : { enabled: false }), 'fixture-hash', 1, new Date(current).toISOString());
  };
  const seedModelIntent = (model: string) => {
    database.raw.prepare(
      'INSERT INTO kernel_public_project_intents' +
      '(project_id,owner_client_id,public_project_key,provider_key,' +
      'surface_intent,model_intent,main_slot_id,created_at)' +
      ' VALUES(?,?,?,?,?,?,?,?)',
    ).run('project', 'alice', 'fixture-project',
      fake.providerKey, 'chat', model, 'main', new Date(current).toISOString());
  };
  return {
    fake, startTask, ack, createService, seedPublicPolicy, seedModelIntent,
    get store() { return store; },
    get database() { return database; },
    get kernel() { return kernel; },
    get now() { return current; },
    set now(value: number) { current = value; },
    reopen() {
      database.close();
      database = SessionPlaneDatabase.open(file);
      store = createKernelStores(database, () => new Date(current).toISOString());
      kernel = new DurableTaskKernel(store, [fake]);
    },
  };
}

test('approved exact ACK schedules one due at 20m, no client wait, no repeated POST', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const service = env.createService();
  assert.throws(() => service.activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: '', message: '계속',
  }), /approval/);
  const approved = {
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'explicit-user-delegation', message: '계속',
  };
  const timer = service.activate(approved);
  assert.equal(timer.dueAt, '2026-11-12T00:20:00.000Z');
  assert.deepEqual(service.activate(approved), timer, 'approval is idempotent');
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts.length, 1);
  env.now = START + CONTINUATION_INTERVAL_MS - 1;
  assert.equal((await service.tick()).timersClaimed, 0);
  assert.equal(env.fake.sends.length, 1);
  env.now++;
  const run = await service.tick();
  assert.deepEqual(run, { timersClaimed: 1, dispatchesAttempted: 1, deferred: 0 });
  assert.equal(env.fake.sends.length, 2);
  assert.equal(env.fake.sends[1]!.kind, 'continuation');
  assert.equal(env.fake.sends[1]!.content, '계속');
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts[1]!.state, 'acknowledged');
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').timers
    .some(t => t.status === 'pending' && t.dueAt === '2026-11-12T00:40:00.000Z'), true);
  assert.equal((await service.tick()).timersClaimed, 0);
  assert.equal(env.fake.sends.length, 2, 'due timer and original attempt cannot replay');
});

test('approved repeated continuation policy creates one new exact attempt at each unanswered due', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const reviews: string[] = [];
  const service = new ManagedContinuationService({
    repository: env.store, kernel: env.kernel, now: () => new Date(env.now),
    requestAgentReview: async ({ attemptId }) => { reviews.push(attemptId); },
  });
  service.activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'explicit-user-delegation', message: '계속',
  });

  env.now = START + CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  assert.equal(env.fake.sends.length, 2);

  env.now = START + 2 * CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 1,
    'a new approved due is not the same execution attempt and may send one new Continue');
  const afterSecondDue = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(env.fake.sends.length, 3);
  assert.equal(afterSecondDue.attempts.length, 3);
  assert.deepEqual(afterSecondDue.attempts.map(attempt => attempt.kind),
    ['initial', 'continuation', 'continuation']);
  assert.equal(afterSecondDue.task.state, 'working');
  assert.equal(afterSecondDue.task.pendingDecisionId, null);
  assert.deepEqual(reviews, [], 'an arbitrary one-Continue limit must not manufacture a blocker');

  const latest = afterSecondDue.attempts.at(-1)!;
  env.fake.readyContinuationFinals.add(latest.attemptId);
  env.now = START + 3 * CONTINUATION_INTERVAL_MS;
  await service.tick();
  const completed = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(completed.task.state, 'completed');
  assert.equal(completed.results.length, 1);
  assert.equal(env.fake.sends.length, 3, 'the exact FINAL cancels all later automatic sends');
});

test('explicit stagnation duration hands repeated no-progress to the agent and resume performs the next due', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const reviews: Array<{ attemptId: string; cause?: string }> = [];
  const service = env.createService(async input => {
    reviews.push({ attemptId: input.attemptId, cause: input.cause });
  });
  service.activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'explicit-user-delegation', message: '계속',
    agentReviewAfterMs: 3 * CONTINUATION_INTERVAL_MS,
  });
  env.now = START + CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  env.now = START + 2 * CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  assert.equal(env.fake.sends.length, 3);

  env.now = START + 3 * CONTINUATION_INTERVAL_MS;
  const reviewed = await service.tick();
  assert.equal(reviewed.dispatchesAttempted, 0);
  assert.deepEqual(reviews, [{
    attemptId: 'managed-continuation:task-a:3', cause: 'repeated_no_progress',
  }]);
  assert.equal(env.fake.sends.length, 3,
    'the explicit review boundary does not itself authorize another Continue');

  service.resumeAfterAgentDecision({
    taskId: 'task-a', clientId: 'alice',
    attemptId: 'managed-continuation:task-a:3', mode: 'resume',
  });
  const resumed = await service.tick();
  assert.equal(resumed.dispatchesAttempted, 1);
  assert.equal(env.fake.sends.length, 4);
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts.length, 4);
  assert.deepEqual(reviews, [{
    attemptId: 'managed-continuation:task-a:3', cause: 'repeated_no_progress',
  }], 'resume resets the stagnation epoch instead of looping into the same review');
});

test('terminal FINAL completes while a human decision is pending without a connected client', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a');
  await env.ack('task-a');
  env.store.decisions.createDecision({
    taskId: 'task-a', clientId: 'alice', decisionId: 'human-help',
    audience: 'human', contextJson: JSON.stringify({ reason: 'fixture-human-action' }),
  });
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'human_input_required');
  env.fake.pendingInitialFinals.delete('initial:task-a');
  const service = env.createService();
  const run = await service.tick();
  assert.equal(run.dispatchesAttempted, 0);
  const completed = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(completed.task.state, 'completed');
  assert.equal(completed.task.pendingDecisionId, null);
  assert.equal(completed.results.length, 1);
  assert.equal(completed.results[0]!.answerText, 'Exact final for initial:task-a');
  assert.equal(completed.decisions.find(row => row.decisionId === 'human-help')?.status,
    'superseded');
  assert.equal(env.fake.sends.length, 1, 'FINAL observation never creates another provider send');
});

test('Core restart retains due timer and recovers a claimed but unplanned slot', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  env.createService().activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'approved', message: '계속',
  });
  env.reopen();
  env.now = START + CONTINUATION_INTERVAL_MS;
  assert.deepEqual(env.store.timers.claimDueTaskTimers(
    new Date(env.now).toISOString(), 50, 'continuation_due').map(t => t.status),
    ['fired'], 'simulate a crash after durable timer claim but before the send plan');
  const recovered = env.createService();
  assert.equal((await recovered.tick()).timersClaimed, 0,
    'restart does not replay an already claimed due event');
  assert.equal(env.fake.sends.length, 1);
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').timers
    .filter(t => t.status === 'pending').length, 1, 'next fixed review is durable');
  env.now += CONTINUATION_INTERVAL_MS;
  assert.equal((await recovered.tick()).dispatchesAttempted, 1);
  assert.equal(env.fake.sends.length, 2);
});

test('no exact FINAL at 20m sends one approved Continue; later exact FINAL ends the Task', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a', true);
  await env.ack('task-a');
  const service = env.createService();
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved-public', message: '계속' });
  env.now += CONTINUATION_INTERVAL_MS;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 1, deferred: 0 });
  assert.equal(env.fake.sends.length, 2, 'no answer at 20 minutes must dispatch exactly once');
  assert.equal(env.fake.sends[1]!.kind, 'continuation');
  assert.equal(env.fake.sends[1]!.content, '계속');
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').results.length, 0);
  env.fake.readyContinuationFinals.add('managed-continuation:initial:task-a');
  env.now += 1_000;
  await service.tick();
  const completed = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(completed.task.state, 'completed');
  assert.equal(completed.results.length, 1);
  assert.equal(completed.results[0]!.completesTask, true);
  assert.equal(completed.timers.filter(timer => timer.status === 'pending').length, 0);
  env.now += 3 * CONTINUATION_INTERVAL_MS;
  await service.tick();
  assert.equal(env.fake.sends.length, 2, 'FINAL ends all automatic continuation');
});

test('exact FINAL at the 20m due ends the Task before any Continue POST', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const service = env.createService();
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved', message: '계속' });
  env.fake.pendingInitialFinals.delete('initial:task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 0, deferred: 0 });
  const completed = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(completed.task.state, 'completed');
  assert.equal(completed.results[0]!.completesTask, true);
  assert.equal(completed.timers.filter(timer => timer.status === 'pending').length, 0);
  assert.equal(env.fake.sends.length, 1);
});

test('unavailable canonical FINAL read at due defers without speculative Continue', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const service = env.createService();
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved', message: '계속' });
  env.fake.unavailableFinals.add('initial:task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 0, deferred: 1 });
  assert.equal(env.fake.sends.length, 1);
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts.length, 1);
  env.fake.unavailableFinals.delete('initial:task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  assert.equal(env.fake.sends.length, 2);
});


test('a direct 429 FINAL read retries at its exact fence without speculative Continue', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const service = env.createService();
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved', message: '계속' });
  env.fake.pending429Finals.add('initial:task-a');
  env.fake.pending429NextCheckAt =
    new Date(START + CONTINUATION_INTERVAL_MS + 61_000).toISOString();
  env.now += CONTINUATION_INTERVAL_MS;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 0, deferred: 1 });
  let full = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(env.fake.sends.length, 1);
  assert.equal(full.attempts.length, 1);
  assert.equal(full.timers.some(timer => timer.status === 'pending' &&
    timer.dueAt === env.fake.pending429NextCheckAt &&
    timer.timerId.startsWith('continuation-read-review:')), true);

  env.fake.pending429Finals.delete('initial:task-a');
  env.now = Date.parse(env.fake.pending429NextCheckAt);
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  full = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(env.fake.sends.length, 2);
  assert.equal(full.attempts.filter(attempt => attempt.kind === 'continuation').length, 1);
});

test('provider canonical read is reserved from exact ACK through an approved due', async t => {
  const env = fixture(t);
  for (let index = 0; index < 9; index++) {
    const taskId = 'task-' + String(index).padStart(2, '0');
    env.startTask(taskId, 'slot-' + taskId);
    env.seedPublicPolicy(taskId);
    await env.ack(taskId);
  }
  env.startTask('task-z', 'main');
  env.seedPublicPolicy('task-z', true);
  await env.ack('task-z');
  const service = env.createService();
  service.activate({ taskId: 'task-z', clientId: 'alice',
    sourceAttemptId: 'initial:task-z', approvalRef: 'approved-public', message: '계속' });

  assert.equal(CONTINUATION_DUE_READ_RESERVATION_MS, CONTINUATION_INTERVAL_MS,
    'an approved due owns its canonical read from the exact ACK');
  env.now = START;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 0, dispatchesAttempted: 0, deferred: 0 });
  assert.equal(env.fake.finalReadReservations.some(reservation =>
    reservation.attemptId === 'initial:task-z' &&
    reservation.notBefore === new Date(START + CONTINUATION_INTERVAL_MS).toISOString()), true,
  'the exact due must reserve its canonical read immediately, even outside the FINAL batch');

  env.now = START + CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  assert.equal(env.fake.sends.length, 11);
  assert.equal(env.fake.observedFinalAttemptIds.some((attemptId, index) =>
    attemptId === 'initial:task-z' && env.fake.observedFinalPriorities[index] === 'due'), true,
  'the actual due performs a selected canonical read');
});

test('transient paced FINAL read retries at its read fence, then sends only after fresh no-FINAL', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const service = env.createService();
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved', message: '계속' });
  env.fake.pacedFinals.add('initial:task-a');
  env.fake.pacedNextCheckAt = new Date(START + CONTINUATION_INTERVAL_MS + 7_000).toISOString();
  env.now += CONTINUATION_INTERVAL_MS;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 0, deferred: 1 });
  let full = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(env.fake.sends.length, 1, 'paced read never licenses Continue');
  assert.equal(full.attempts.length, 1);
  assert.equal(full.timers.some(timer => timer.status === 'pending' &&
    timer.dueAt === env.fake.pacedNextCheckAt &&
    timer.timerId.startsWith('continuation-read-review:')), true);

  env.fake.pacedFinals.delete('initial:task-a');
  env.now = Date.parse(env.fake.pacedNextCheckAt);
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 1, deferred: 0 });
  full = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(env.fake.sends.length, 2);
  assert.equal(full.attempts.filter(attempt => attempt.kind === 'continuation').length, 1);
});

test('fresh no-FINAL observer repairs an older full-interval pacing review without sending directly', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a', true);
  await env.ack('task-a');
  const service = env.createService();
  const original = service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved-public', message: '계속' });
  env.fake.pacedFinals.add('initial:task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  env.store.timers.claimDueTaskTimers(new Date(env.now).toISOString(), 1, 'continuation_due');
  env.store.timers.scheduleTaskTimer({ taskId: 'task-a', clientId: 'alice',
    timerId: 'continuation-review:initial:task-a:' + (env.now + CONTINUATION_INTERVAL_MS),
    kind: 'continuation_due',
    dueAt: new Date(env.now + CONTINUATION_INTERVAL_MS).toISOString(),
    contextJson: original.contextJson });
  env.fake.pacedFinals.delete('initial:task-a');

  assert.deepEqual(await service.tick(),
    { timersClaimed: 0, dispatchesAttempted: 0, deferred: 0 });
  let full = env.store.tasks.readTaskAggregate('task-a', 'alice');
  const repaired = full.timers.find(timer => timer.status === 'pending' &&
    timer.timerId.startsWith('continuation-read-review:'))!;
  assert.ok(repaired, 'fresh canonical no-FINAL schedules a read-only repair review');
  assert.equal(env.fake.sends.length, 1, 'observer never sends directly');

  env.now = Date.parse(repaired.dueAt);
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  full = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(env.fake.sends.length, 2);
  assert.equal(full.attempts.filter(attempt => attempt.kind === 'continuation').length, 1);
});

test('pending unbound root POSTs recover ACK fairly across a sixteen-slot limit', async t => {
  const env = fixture(t);
  const ids = Array.from({ length: 18 }, (_, index) => 'root-ack-' + String(index).padStart(2, '0'));
  for (const taskId of ids) {
    env.store.projects.openConversationSlot({
      projectId: 'project', slotId: 'slot-' + taskId, clientId: 'alice',
      roleKey: 'slot-' + taskId, providerKey: env.fake.providerKey,
    });
    env.store.tasks.createTask({
      taskId, projectId: 'project', slotId: 'slot-' + taskId,
      clientId: 'alice', requestId: 'request:' + taskId,
      expectedSlotRevision: 1, prompt: 'Question ' + taskId,
    });
    const attemptId = 'initial:' + taskId;
    env.store.attempts.planAttempt({
      taskId, clientId: 'alice', attemptId,
      kind: 'initial', turnKey: 'original', content: 'Question ' + taskId,
    });
    env.seedPublicPolicy(taskId);
    env.store.attempts.reserveAttemptDispatch(taskId, 'alice', attemptId);
    env.store.attempts.recordRootDispatchEvidence({
      taskId, clientId: 'alice', attemptId,
      evidence: {
        sessionId: 'session-' + taskId, generation: 1,
        pageKey: 'owned-' + taskId, targetId: 'target-' + taskId,
        bindingEpoch: 1, messageId: 'message-' + taskId,
        parentMessageId: 'parent-' + taskId,
        textHash: createHash('sha256').update('Question ' + taskId).digest('hex'),
        observedAt: new Date(env.now).toISOString(), requestConversationId: null,
      },
    });
  }
  const first = env.createService();
  await first.tick();
  await first.close();
  env.reopen();
  await env.createService().tick();
  const recovered = new Set(env.fake.recoveredAckAttemptIds);
  assert.ok(ids.every(taskId => recovered.has('initial:' + taskId)),
    'every retained root POST must have a read-only canonical ACK recovery chance');
  assert.equal(env.fake.sends.length, 0, 'root reconciliation never resends initial POST');
  assert.ok(ids.every(taskId => env.store.tasks.readTaskAggregate(taskId, 'alice')
    .attempts[0]!.state === 'uncertain'));
});

test('unbound root initial scans visit all waiting Tasks despite an eight-slot limit', async t => {
  const env = fixture(t);
  const ids = Array.from({ length: 12 }, (_, index) => 'root-' + String(index).padStart(2, '0'));
  for (const taskId of ids) {
    env.store.projects.openConversationSlot({
      projectId: 'project', slotId: 'slot-' + taskId, clientId: 'alice',
      roleKey: 'slot-' + taskId, providerKey: env.fake.providerKey,
    });
    env.store.tasks.createTask({
      taskId, projectId: 'project', slotId: 'slot-' + taskId,
      clientId: 'alice', requestId: 'request:' + taskId,
      expectedSlotRevision: 1, prompt: 'Question ' + taskId,
    });
    env.store.attempts.planAttempt({
      taskId, clientId: 'alice', attemptId: 'initial:' + taskId,
      kind: 'initial', turnKey: 'original', content: 'Question ' + taskId,
    });
    env.seedPublicPolicy(taskId);
    // Known not-ready preflight: no POST, only a durable defer.
    env.fake.blocked.add(taskId);
  }
  const first = env.createService();
  await first.tick();
  await first.close();
  env.reopen();
  await env.createService().tick();
  const observed = new Set(env.fake.preflightAttemptIds);
  assert.ok(ids.every(taskId => observed.has('initial:' + taskId)),
    'bounded root scan must rotate past the first eight blocked Tasks');
  assert.equal(env.fake.sends.length, 0);
  assert.ok(ids.every(taskId => env.store.tasks.readTaskAggregate(taskId, 'alice')
    .attempts[0]!.state === 'planned'));
});

test('read-only ACK reconciliation rotates past eight uncertain exact attempts', async t => {
  const env = fixture(t);
  const ids = Array.from({ length: 12 }, (_, index) => 'ack-' + String(index).padStart(2, '0'));
  for (const taskId of ids) {
    env.startTask(taskId, 'slot-' + taskId);
    env.seedPublicPolicy(taskId);
    const attemptId = 'initial:' + taskId;
    env.store.attempts.reserveAttemptDispatch(taskId, 'alice', attemptId);
    env.store.attempts.recordDispatchEvidence({
      taskId, clientId: 'alice', attemptId,
      evidence: {
        conversationId: 'conversation:' + taskId,
        messageId: 'message:' + taskId, parentMessageId: 'parent:' + taskId,
        textHash: createHash('sha256').update('Question ' + taskId).digest('hex'),
        observedAt: new Date(env.now).toISOString(),
      },
    });
    env.store.attempts.markAttemptUncertain(taskId, 'alice', attemptId, 'fixture-lost-ack');
  }
  const first = env.createService();
  await first.tick();
  await first.close();
  env.reopen();
  await env.createService().tick();
  const observed = new Set(env.fake.recoveredAckAttemptIds);
  assert.ok(ids.every(taskId => observed.has('initial:' + taskId)),
    'all uncertain attempts must get read-only ACK recovery opportunities');
  assert.equal(env.fake.sends.length, 0, 'ACK recovery must never replay a POST');
  assert.ok(ids.every(taskId =>
    env.store.tasks.readTaskAggregate(taskId, 'alice').attempts[0]!.state === 'uncertain'));
});

test('unready early public initials never starve later safe Tasks past the scan limit', async t => {
  const env = fixture(t);
  const ids = Array.from({ length: 12 }, (_, index) => 'task-' + String(index).padStart(2, '0'));
  for (const [index, taskId] of ids.entries()) {
    env.startTask(taskId, 'slot-' + taskId);
    env.seedPublicPolicy(taskId);
    if (index < 8) env.fake.blocked.add(taskId);
  }
  const first = env.createService();
  await first.tick();
  await first.close();
  env.reopen();
  await env.createService().tick();
  const sentIds = env.fake.sends.map(sent => sent.taskId);
  assert.deepEqual(sentIds.slice().sort(), ids.slice(8),
    'a blocked leading batch cannot monopolize every future initial scan');
  assert.ok(ids.slice(0, 8).every(taskId =>
    env.store.tasks.readTaskAggregate(taskId, 'alice').attempts[0]!.state === 'planned'));
});

test('stable single-Task scan does not rewrite the same durable cursor every tick', async t => {
  const env = fixture(t);
  env.startTask('only-task', 'main');
  env.seedPublicPolicy('only-task');
  await env.ack('only-task');
  assert.deepEqual(env.store.scans.scanPendingFinals(8)
    .map(item => item.taskId), ['only-task']);
  const cursor = env.database.raw.prepare(
    "SELECT scan_kind AS kind,last_task_id AS taskId FROM kernel_public_scan_cursors").all();
  assert.deepEqual(cursor.map(row => ({
    kind: String(row.kind), taskId: String(row.taskId),
  })), [{ kind: 'final', taskId: 'only-task' }]);
  const writesAfterFirst = Number((env.database.raw.prepare(
    'SELECT total_changes() AS changes').get() as { changes: number }).changes);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(env.store.scans.scanPendingFinals(8)
      .map(item => item.taskId), ['only-task']);
  }
  const writesAfterRepeat = Number((env.database.raw.prepare(
    'SELECT total_changes() AS changes').get() as { changes: number }).changes);
  assert.equal(writesAfterRepeat, writesAfterFirst,
    'an unchanged cursor cannot inflate SQLite writes or Task revisions');
});

test('durable FINAL scan selection advances atomically without changing Task evidence', async t => {
  const env = fixture(t);
  const ids = Array.from({ length: 12 }, (_, index) =>
    'cursor-final-' + String(index).padStart(2, '0'));
  for (const taskId of ids) {
    env.startTask(taskId, 'slot-' + taskId);
    env.seedPublicPolicy(taskId);
    await env.ack(taskId);
  }
  const before = ids.map(taskId => env.store.tasks.getTask(taskId, 'alice').revision);
  const first = env.store.scans.scanPendingFinals(8);
  assert.deepEqual(first.map(row => row.taskId), ids.slice(0, 8));
  assert.deepEqual(ids.map(taskId => env.store.tasks.getTask(taskId, 'alice').revision), before,
    'fairness selection is not a durable Task event');
  env.reopen();
  const second = env.store.scans.scanPendingFinals(8);
  assert.deepEqual(second.map(row => row.taskId), [...ids.slice(8), ...ids.slice(0, 4)]);
  const third = env.store.scans.scanPendingFinals(8);
  assert.deepEqual(third.map(row => row.taskId), ids.slice(4));
  assert.deepEqual(ids.map(taskId => env.store.tasks.getTask(taskId, 'alice').revision), before);
  assert.equal(env.fake.sends.length, 12);
});

test('FINAL scan fairness survives SQLite/Core reopen after every bounded tick', async t => {
  const env = fixture(t);
  const ids = Array.from({ length: 12 }, (_, index) =>
    'restart-final-' + String(index).padStart(2, '0'));
  for (const taskId of ids) {
    env.startTask(taskId, 'slot-' + taskId);
    env.seedPublicPolicy(taskId);
    await env.ack(taskId);
  }
  for (let scan = 0; scan < 4; scan++) {
    const service = env.createService();
    await service.tick();
    await service.close();
    env.reopen(); // new repository and Core service each time
  }
  const readCounts = ids.map(taskId => env.fake.observedFinalAttemptIds
    .filter(id => id === 'initial:' + taskId).length);
  assert.ok(readCounts.every(count => count >= 2),
    'each restart must resume the bounded cursor, not reset to first eight: ' +
    JSON.stringify(readCounts));
  assert.equal(env.fake.sends.length, 12, 'recovery never replays POST');
  assert.ok(ids.every(taskId => env.store.tasks.getTask(taskId, 'alice').state === 'working'));
});

test('bounded public FINAL observer revisits every Task beyond its eight-slot limit', async t => {
  const env = fixture(t);
  const ids = Array.from({ length: 12 }, (_, index) => 'task-' + String(index).padStart(2, '0'));
  for (const taskId of ids) {
    env.startTask(taskId, 'slot-' + taskId);
    env.seedPublicPolicy(taskId);
    await env.ack(taskId);
  }
  const service = env.createService();
  // Identical 'backend-assistant-missing' results are durably deduplicated.
  // An updated_at-ordered LIMIT 8 would therefore starve some Tasks forever.
  for (let scan = 1; scan <= 4; scan++) {
    env.now = START + scan * 1_000;
    await service.tick();
  }
  const readCounts = ids.map(taskId => env.fake.observedFinalAttemptIds
    .filter(id => id === 'initial:' + taskId).length);
  assert.ok(readCounts.every(count => count >= 2),
    'every Task needs a second opportunity despite identical deferred observations: ' +
    JSON.stringify(readCounts));
  assert.equal(env.fake.sends.length, ids.length, 'read-only rotation never sends a follow-up');
  assert.ok(ids.every(taskId => env.store.tasks.getTask(taskId, 'alice').state === 'working'));
});

test('public FINAL 429/pacing never invents an agent-review threshold without explicit policy', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a');
  await env.ack('task-a');
  env.fake.pending429Finals.add('initial:task-a');
  const reviews: string[] = [];
  const service = env.createService(async owner => { reviews.push(owner.attemptId); });
  await service.tick();
  env.fake.pending429Finals.delete('initial:task-a');
  env.fake.pacedFinals.add('initial:task-a');
  for (let interval = 1; interval <= 8; interval++) {
    env.now = START + interval * CONTINUATION_INTERVAL_MS;
    await service.tick();
  }
  assert.deepEqual(reviews, [], 'elapsed time and probe count are not hidden escalation policy');
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'working');
  assert.equal(env.fake.sends.length, 1, 'read throttling never licenses another POST');
});

test('a successful canonical observation resets 429 escalation and exact FINAL closes normally', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a');
  await env.ack('task-a');
  env.fake.pending429Finals.add('initial:task-a');
  const reviews: string[] = [];
  const service = env.createService(async owner => { reviews.push(owner.attemptId); });
  await service.tick();
  env.fake.pending429Finals.delete('initial:task-a');
  env.now = START + CONTINUATION_INTERVAL_MS / 2;
  await service.tick(); // verified missing answer breaks the continuous throttle
  env.fake.pending429Finals.add('initial:task-a');
  env.now = START + 2 * CONTINUATION_INTERVAL_MS;
  await service.tick();
  env.fake.pending429Finals.delete('initial:task-a');
  env.fake.pacedFinals.add('initial:task-a');
  env.now = START + 4 * CONTINUATION_INTERVAL_MS;
  await service.tick();
  assert.deepEqual(reviews, [], 'old 429 cannot leak across a successful read');
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'working');
  env.fake.pacedFinals.delete('initial:task-a');
  env.fake.pendingInitialFinals.delete('initial:task-a');
  env.now += 1_000;
  await service.tick();
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'completed');
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').results[0]!.completesTask, true);
  assert.equal(env.fake.sends.length, 1);
});

test('standalone approved due 429 raises review only after the explicit policy duration', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  env.fake.pending429Finals.add('initial:task-a');
  const reviews: string[] = [];
  const service = env.createService(async owner => {
    reviews.push(owner.cause ?? 'missing-cause');
    env.store.decisions.createDecision({
      taskId: owner.taskId, clientId: owner.clientId,
      decisionId: 'due-429-review', audience: 'agent',
      contextJson: JSON.stringify({ reason: owner.cause }),
    });
  });
  service.activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'approved', message: '계속',
    agentReviewAfterMs: 4 * CONTINUATION_INTERVAL_MS,
  });
  for (let slot = 1; slot < 5; slot++) {
    env.now = START + slot * CONTINUATION_INTERVAL_MS;
    assert.equal((await service.tick()).dispatchesAttempted, 0);
    assert.deepEqual(reviews, [], 'pre-threshold interval ' + slot + ' must not escalate');
    assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'working');
    assert.equal(env.fake.sends.length, 1);
  }
  env.now = START + 5 * CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 0);
  assert.deepEqual(reviews, ['persistent_backend_read_throttle']);
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'agent_input_required');
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').timers
    .filter(timer => timer.status === 'pending').length, 0);
  assert.equal(env.fake.sends.length, 1);
});

test('explicit agent release resets only the prior policy-duration 429 streak', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a', true, 4 * CONTINUATION_INTERVAL_MS);
  await env.ack('task-a');
  const policyService = env.createService();
  policyService.activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'approved-public', message: '계속',
    agentReviewAfterMs: 4 * CONTINUATION_INTERVAL_MS,
  });
  env.fake.pending429Finals.add('initial:task-a');
  const reviews: string[] = [];
  const review = async (owner: {
    taskId: string; clientId: string; attemptId: string;
    cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress';
  }) => {
    const decisionId = 'rate-review-' + (reviews.length + 1);
    reviews.push(decisionId);
    env.store.decisions.createDecision({
      taskId: owner.taskId, clientId: owner.clientId, decisionId,
      audience: 'agent', contextJson: JSON.stringify({
        kind: 'semantic_action', attemptId: owner.attemptId,
        packet: { reason: 'canonical-final-rate-limit-persistent' },
      }),
    });
  };
  let service = env.createService(review);
  await service.tick(); // actual 429 is blocked review slot one
  env.fake.pending429Finals.delete('initial:task-a');
  env.fake.pacedFinals.add('initial:task-a');
  env.now += 4 * CONTINUATION_INTERVAL_MS;
  await service.tick();
  assert.deepEqual(reviews, ['rate-review-1']);
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'agent_input_required');
  env.store.decisions.resolveDecision({
    taskId: 'task-a', clientId: 'alice', decisionId: reviews[0]!,
    resolutionJson: JSON.stringify({ kind: 'read_only_refresh', requestId: 'agent-resume-1' }),
  });
  env.reopen();
  service = env.createService(review);
  await service.tick();
  assert.deepEqual(reviews, ['rate-review-1'], 'an old throttle must not re-escalate on resume');
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'working');
  assert.equal(env.fake.sends.length, 1);
  env.now += CONTINUATION_INTERVAL_MS;
  await service.tick();
  assert.deepEqual(reviews, ['rate-review-1'], 'paced GET alone is not a new real 429');
  env.fake.pacedFinals.delete('initial:task-a');
  env.fake.pending429Finals.add('initial:task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  await service.tick(); // a new actual 429 opens the next streak
  env.fake.pending429Finals.delete('initial:task-a');
  env.fake.pacedFinals.add('initial:task-a');
  env.now += 4 * CONTINUATION_INTERVAL_MS - 1;
  await service.tick();
  assert.deepEqual(reviews, ['rate-review-1']);
  env.now += 5_001;
  await service.tick();
  assert.deepEqual(reviews, ['rate-review-1', 'rate-review-2']);
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'agent_input_required');
  assert.equal(env.fake.sends.length, 1, 'explicit review never permits a speculative POST');
});

test('approved policy-duration 429 review resumes one fixed due without catch-up POST', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a', true, 4 * CONTINUATION_INTERVAL_MS);
  await env.ack('task-a');
  env.fake.pending429Finals.add('initial:task-a');
  const reviews: string[] = [];
  const review = async (owner: {
    taskId: string; clientId: string; attemptId: string;
    cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress';
  }) => {
    reviews.push(owner.cause ?? 'missing-cause');
    env.store.decisions.createDecision({
      taskId: owner.taskId, clientId: owner.clientId,
      decisionId: 'policy-duration-approved-review', audience: 'agent',
      contextJson: JSON.stringify({
        attemptId: owner.attemptId,
        packet: { reason: 'canonical-final-rate-limit-persistent' },
      }),
    });
  };
  env.createService(review).activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'approved-public', message: '계속',
    agentReviewAfterMs: 4 * CONTINUATION_INTERVAL_MS,
  });
  const service = env.createService(review);
  for (let slot = 1; slot <= 5; slot++) {
    env.now = START + slot * CONTINUATION_INTERVAL_MS;
    await service.tick();
    assert.equal(env.fake.sends.length, 1);
  }
  assert.deepEqual(reviews, ['persistent_backend_read_throttle']);
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'agent_input_required');
  env.fake.pending429Finals.delete('initial:task-a');
  env.fake.pacedFinals.add('initial:task-a');
  env.now = START + 6 * CONTINUATION_INTERVAL_MS - 1;
  await service.tick(); // hold stays durable while agent is away
  assert.equal(env.fake.sends.length, 1);
  env.store.decisions.resolveDecision({
    taskId: 'task-a', clientId: 'alice', decisionId: 'policy-duration-approved-review',
    resolutionJson: JSON.stringify({ kind: 'read_only_refresh', requestId: 'agent-checked-429' }),
  });
  env.reopen();
  const resumed = env.createService(review);
  await resumed.tick();
  const pending = env.store.tasks.readTaskAggregate('task-a', 'alice').timers
    .filter(timer => timer.status === 'pending' && timer.kind === 'continuation_due');
  assert.equal(pending.length, 1, 'existing approval resumes one due after agent review');
  assert.equal(pending[0]!.dueAt,
    new Date(START + 6 * CONTINUATION_INTERVAL_MS).toISOString());
  assert.equal(env.fake.sends.length, 1);
  env.now = START + 6 * CONTINUATION_INTERVAL_MS;
  await resumed.tick();
  assert.equal(env.fake.sends.length, 1, 'pacing remains non-authoritative for POST');
  env.fake.pacedFinals.delete('initial:task-a');
  env.now = START + 7 * CONTINUATION_INTERVAL_MS;
  await resumed.tick();
  assert.equal(env.fake.sends.length, 2, 'later verified absence permits one approved Continue');
  assert.equal(env.fake.sends[1]!.kind, 'continuation');
  assert.equal(env.fake.sends[1]!.content, '계속');
  assert.deepEqual(reviews, ['persistent_backend_read_throttle']);
});

test('a later foreign user turn becomes an agent decision, never another automatic POST', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const reviews: string[] = [];
  const service = env.createService(async owner => {
    reviews.push(owner.attemptId);
    env.store.decisions.createDecision({
      taskId: owner.taskId, clientId: owner.clientId,
      decisionId: 'foreign-review', audience: 'agent',
      contextJson: JSON.stringify({ kind: 'foreign-user-review', attemptId: owner.attemptId }),
    });
  });
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved', message: '계속' });
  env.fake.laterUserFinals.add('initial:task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 0, deferred: 1 });
  assert.deepEqual(reviews, ['initial:task-a']);
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'agent_input_required');
  assert.equal(env.fake.sends.length, 1);
});

test('an unsafe composer yields a durable agent decision without starving other due Tasks', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.startTask('task-b', 'review');
  await env.ack('task-a');
  await env.ack('task-b');
  const reviews: string[] = [];
  const service = env.createService(async owner => {
    reviews.push(owner.taskId);
    env.store.decisions.createDecision({
      taskId: owner.taskId, clientId: owner.clientId,
      decisionId: 'review:' + owner.taskId, audience: 'agent',
      contextJson: JSON.stringify({ kind: 'blocked-send-review', attemptId: owner.attemptId }),
    });
  });
  for (const taskId of ['task-a', 'task-b']) {
    service.activate({ taskId, clientId: 'alice', sourceAttemptId: 'initial:' + taskId,
      approvalRef: 'approved-' + taskId, message: '계속' });
  }
  env.fake.blocked.add('task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 2, dispatchesAttempted: 1, deferred: 1 });
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts[1]!.state, 'planned');
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'agent_input_required');
  assert.deepEqual(reviews, ['task-a']);
  assert.equal(env.fake.sends.filter(s => s.taskId === 'task-a').length, 1);
  assert.equal(env.fake.sends.filter(s => s.taskId === 'task-b').length, 2);
  env.fake.blocked.delete('task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  await service.tick();
  assert.equal(env.fake.sends.filter(s => s.taskId === 'task-a').length, 1,
    'an agent decision cannot silently replay the unsent Continue');
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts.length, 2);
});

test('cancellation revokes pending due timers and prevents later continuation', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const service = env.createService();
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved', message: '계속' });
  env.store.tasks.requestTaskCancellation('task-a', 'alice');
  env.now += 2 * CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).timersClaimed, 0);
  assert.equal(env.fake.sends.length, 1);
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').timers[0]!.status, 'canceled');
});

test('maintenance pause preserves due policy and resumes without catch-up burst', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  let maintenancePaused = true;
  const service = new ManagedContinuationService({
    repository: env.store, kernel: env.kernel, now: () => new Date(env.now),
    canRun: () => !maintenancePaused,
  });
  service.activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'approved', message: '계속',
  });
  env.now = START + CONTINUATION_INTERVAL_MS * 4 + 25_000;
  assert.equal((await service.tick()).timersClaimed, 0);
  assert.equal(env.fake.sends.length, 1);
  maintenancePaused = false;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 1, deferred: 0 });
  assert.equal(env.fake.sends.length, 2, 'missed intervals never burst Continue');
  assert.equal((await service.tick()).timersClaimed, 0);
  assert.equal(env.fake.sends.length, 2);
});

test('Core continuation does not claim another component timer kind', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const service = env.createService();
  service.activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'approved', message: '계속',
  });
  env.store.timers.scheduleTaskTimer({
    taskId: 'task-a', clientId: 'alice', timerId: 'independent-review',
    kind: 'unrelated_due', dueAt: new Date(START + CONTINUATION_INTERVAL_MS).toISOString(),
    contextJson: '{}',
  });
  env.now += CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).timersClaimed, 1);
  const independent = env.store.tasks.readTaskAggregate('task-a', 'alice')
    .timers.find(timer => timer.timerId === 'independent-review');
  assert.equal(independent?.status, 'pending',
    'managed scanner cannot consume timers owned by other Core workflows');
});

test('Core restart after continuation ACK but before next timer rearm restores one due', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  env.createService().activate({
    taskId: 'task-a', clientId: 'alice', sourceAttemptId: 'initial:task-a',
    approvalRef: 'approved', message: '계속',
  });
  env.now += CONTINUATION_INTERVAL_MS;
  assert.equal(env.store.timers.claimDueTaskTimers(
    new Date(env.now).toISOString(), 50, 'continuation_due').length, 1);
  const plannedId = 'managed-continuation:initial:task-a';
  env.store.attempts.planAttempt({
    taskId: 'task-a', clientId: 'alice', attemptId: plannedId,
    kind: 'continuation', turnKey: plannedId, content: '계속',
  });
  await env.kernel.dispatch('task-a', 'alice', plannedId);
  assert.equal(env.fake.sends.length, 2);
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').timers
    .filter(timer => timer.status === 'pending' && timer.kind === 'continuation_due').length, 0);
  env.reopen();
  const restored = env.createService();
  assert.equal((await restored.tick()).timersClaimed, 0);
  const full = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(full.timers.filter(timer => timer.status === 'pending' &&
    timer.timerId === 'continuation-due:' + plannedId).length, 1,
    'exact ACK restores its next due without reissuing the POST');
  assert.equal(env.fake.sends.length, 2);
});


test('Core drives one planned public initial send after exact bound conversation becomes ready', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a');
  const service = env.createService();
  env.fake.blocked.add('task-a');
  await service.tick();
  assert.equal(env.fake.sends.length, 0);
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts[0]!.state, 'planned');
  env.fake.blocked.delete('task-a');
  await service.tick();
  assert.equal(env.fake.sends.length, 1);
  assert.equal(env.fake.sends[0]!.content, 'Question task-a');
  assert.equal(env.fake.sends[0]!.kind, 'initial');
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'completed',
    'Core also observes exact FINAL for the public standalone task');
  await service.tick();
  assert.equal(env.fake.sends.length, 1, 'completed public initial never resubmits');
});

test('public ACK scanner admits only the latest evidence-free uncertain continuation on its exact binding', t => {
  const env = fixture(t);
  const seedAcknowledgedSource = (taskId: string, slotId: string) => {
    env.startTask(taskId, slotId);
    env.seedPublicPolicy(taskId);
    const attemptId = 'initial:' + taskId;
    env.store.attempts.reserveAttemptDispatch(taskId, 'alice', attemptId);
    env.store.attempts.recordDispatchEvidence({
      taskId, clientId: 'alice', attemptId,
      evidence: {
        conversationId: 'conversation:' + taskId,
        messageId: 'source-user:' + taskId,
        parentMessageId: 'root:' + taskId,
        textHash: createHash('sha256').update('Question ' + taskId).digest('hex'),
        observedAt: new Date(env.now).toISOString(),
      },
    });
    env.store.attempts.acknowledgeAttempt({
      taskId, clientId: 'alice', attemptId, externalTurnId: 'source-turn:' + taskId,
    });
  };
  const seedUncertainContinuation = (taskId: string) => {
    const attemptId = 'continue:' + taskId;
    env.store.attempts.planAttempt({
      taskId, clientId: 'alice', attemptId,
      kind: 'continuation', turnKey: attemptId, content: '계속',
    });
    env.store.attempts.reserveAttemptDispatch(taskId, 'alice', attemptId);
    env.store.attempts.markAttemptUncertain(taskId, 'alice', attemptId, 'semantic-action-not-verified');
    return attemptId;
  };

  seedAcknowledgedSource('recoverable', 'scan-recoverable');
  const recoverable = seedUncertainContinuation('recoverable');

  env.startTask('initial-no-evidence', 'scan-initial-no-evidence');
  env.seedPublicPolicy('initial-no-evidence');
  env.store.attempts.reserveAttemptDispatch('initial-no-evidence', 'alice', 'initial:initial-no-evidence');
  env.store.attempts.markAttemptUncertain('initial-no-evidence', 'alice',
    'initial:initial-no-evidence', 'semantic-action-not-verified');

  seedAcknowledgedSource('stop-only', 'scan-stop');
  env.database.raw.prepare(
    `INSERT INTO kernel_attempts(
      attempt_id,task_id,sequence,kind,turn_key,content,state,external_turn_id,
      dispatched_at,acknowledged_at,uncertain_reason,created_at)
      VALUES(?,?,2,'stop',?,?,'uncertain',NULL,?,NULL,?,?)`,
  ).run('stop:stop-only', 'stop-only', 'stop:stop-only', '',
    new Date(env.now).toISOString(), 'semantic-action-not-verified',
    new Date(env.now).toISOString());

  seedAcknowledgedSource('superseded', 'scan-superseded');
  const superseded = seedUncertainContinuation('superseded');
  env.database.raw.prepare(
    `INSERT INTO kernel_attempts(
      attempt_id,task_id,sequence,kind,turn_key,content,state,external_turn_id,
      dispatched_at,acknowledged_at,uncertain_reason,created_at)
      VALUES(?,?,3,'continuation',?,?,'planned',NULL,NULL,NULL,NULL,?)`,
  ).run('newer:superseded', 'superseded', 'newer:superseded', '계속',
    new Date(env.now).toISOString());

  seedAcknowledgedSource('stale-slot', 'scan-stale-slot');
  const staleSlot = seedUncertainContinuation('stale-slot');
  env.database.raw.prepare(
    'UPDATE kernel_slots SET active_task_id=NULL WHERE project_id=? AND slot_id=?',
  ).run('project', 'scan-stale-slot');

  seedAcknowledgedSource('foreign-evidence', 'scan-foreign-evidence');
  const foreignEvidence = seedUncertainContinuation('foreign-evidence');
  env.store.attempts.recordDispatchEvidence({
    taskId: 'foreign-evidence', clientId: 'alice', attemptId: foreignEvidence,
    evidence: {
      conversationId: 'conversation:foreign-evidence',
      messageId: 'continued-user:foreign-evidence',
      parentMessageId: 'source-assistant:foreign-evidence',
      textHash: createHash('sha256').update('계속').digest('hex'),
      observedAt: new Date(env.now).toISOString(),
    },
  });
  env.database.raw.prepare(
    'UPDATE kernel_dispatch_evidence SET provider_conversation_id=? WHERE attempt_id=?',
  ).run('conversation:foreign', foreignEvidence);

  const pending = env.store.scans.scanPendingAcknowledgements(100);
  assert.equal(pending.length, 1);
  assert.deepEqual({ ...pending[0]! }, {
    taskId: 'recoverable', clientId: 'alice', attemptId: recoverable,
  });
  assert.equal(env.store.attempts.getDispatchEvidence({
    taskId: 'recoverable', clientId: 'alice', attemptId: recoverable,
  }), null);
  assert.equal(env.store.tasks.readTaskAggregate('recoverable', 'alice').attempts.at(-1)?.state,
    'uncertain');
});

test('Core recovers journaled public ACK after restart without another send', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a');
  env.startTask('no-evidence', 'review');
  env.seedPublicPolicy('no-evidence');
  env.fake.sendOnce = async intent => {
    env.fake.sends.push(intent);
    if (intent.taskId === 'task-a') {
      env.store.attempts.recordDispatchEvidence({
        taskId: intent.taskId, clientId: 'alice', attemptId: intent.attemptId,
        evidence: {
          conversationId: intent.providerConversationId!,
          messageId: 'exact-user', parentMessageId: 'previous-final',
          textHash: createHash('sha256').update(intent.content).digest('hex'),
          observedAt: new Date(env.now).toISOString(),
        },
      });
    }
    return { kind: 'uncertain', reason: 'canonical-ack-still-unverified' };
  };
  await env.kernel.dispatch('task-a', 'alice', 'initial:task-a');
  await env.kernel.dispatch('no-evidence', 'alice', 'initial:no-evidence');
  env.reopen();

  const recovered: string[] = [];
  let ackReady = false;
  env.fake.recoverAck = async query => {
    recovered.push(query.attemptId);
    return ackReady
      ? { kind: 'verified_ack', externalTurnId: 'exact-delayed-turn' }
      : { kind: 'pending', reason: 'backend-read-paced' };
  };
  const service = env.createService();
  await service.tick();
  assert.equal(env.store.tasks.getTask('task-a', 'alice').state, 'uncertain');
  assert.deepEqual(recovered, ['initial:task-a'],
    'missing POST evidence is never inferred from an uncertain state');
  ackReady = true;
  await service.tick();
  const exact = env.store.tasks.readTaskAggregate('task-a', 'alice');
  assert.equal(exact.task.state, 'completed');
  assert.equal(exact.attempts[0]!.externalTurnId, 'exact-delayed-turn');
  assert.equal(exact.results[0]!.answerText, 'Exact final for initial:task-a');
  assert.equal(exact.attempts.length, 1);
  assert.equal(env.store.tasks.getTask('no-evidence', 'alice').state, 'uncertain');
  assert.equal(env.fake.sends.filter(send => send.taskId === 'task-a').length, 1,
    'read-only ACK recovery cannot resend the existing prompt');
  assert.equal(env.fake.sends.length, 2);
  await service.tick();
  assert.deepEqual(recovered, ['initial:task-a', 'initial:task-a'],
    'completed work and evidence-free attempts are excluded');
  await service.close();
});

test('Core public initial scanner never dispatches canceled public work', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a');
  env.store.tasks.requestTaskCancellation('task-a', 'alice');
  const service = env.createService();
  await service.tick();
  assert.equal(env.fake.sends.length, 0);
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts[0]!.state, 'planned');
});


test('explicit project model intent never silently sends the initial prompt with another model', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.seedPublicPolicy('task-a');
  env.seedModelIntent('Pro');
  const service = env.createService();
  await service.tick();
  assert.equal(env.fake.sends.length, 0,
    'configured model intent requires exact observed model verification');
  assert.equal(env.store.tasks.readTaskAggregate('task-a', 'alice').attempts[0]!.state, 'planned');
  assert.ok(env.store.tasks.readTaskAggregate('task-a', 'alice').events.some(event =>
    event.event.type === 'observation.deferred' &&
    event.event.reason === 'public-initial-model-intent-unverified'));
  await service.tick();
  assert.equal(env.fake.sends.length, 0, 'repeated review never substitutes a model');
});
