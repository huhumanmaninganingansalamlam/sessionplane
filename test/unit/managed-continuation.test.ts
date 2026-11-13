import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  CONTINUATION_INTERVAL_MS, ManagedContinuationService,
} from '../../src/core/managed-continuation.ts';
import { DurableTaskKernel } from '../../src/core/durable-task-kernel.ts';
import type {
  ExactSendIntent, ExactTaskProviderPort, ExactTurnQuery,
  RecoveryOutcome, FinalObservation, SendOutcome,
} from '../../src/core/durable-task-kernel.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TaskKernelRepository } from '../../src/storage/task-kernel-repository.ts';

class FakeProvider implements ExactTaskProviderPort {
  readonly providerKey = 'provider-fixture';
  readonly sends: ExactSendIntent[] = [];
  readonly blocked = new Set<string>();
  async preflight(intent: ExactSendIntent): Promise<
    { kind: 'ready' } | { kind: 'unavailable'; reason: string }
  > {
    return this.blocked.has(intent.taskId)
      ? { kind: 'unavailable', reason: 'fixture-provider-streaming' }
      : { kind: 'ready' };
  }
  async sendOnce(intent: ExactSendIntent): Promise<SendOutcome> {
    this.sends.push(intent);
    return { kind: 'verified_ack', externalTurnId: 'turn:' + intent.attemptId };
  }
  async recoverAck(_query: ExactTurnQuery): Promise<RecoveryOutcome> {
    return { kind: 'unavailable', reason: 'fake-no-backend' };
  }
  async observeFinal(query: ExactTurnQuery): Promise<FinalObservation> {
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
  let store = new TaskKernelRepository(database, () => new Date(current).toISOString());
  const fake = new FakeProvider();
  let kernel = new DurableTaskKernel(store, [fake]);
  t.after(() => { database.close(); rmSync(root, { recursive: true, force: true }); });
  store.openProject({ projectId: 'project', projectKey: 'managed.test',
    displayName: 'Managed fixture', clientId: 'alice' });
  const startTask = (taskId: string, slotId: string) => {
    store.openSlot({ projectId: 'project', clientId: 'alice', slotId,
      roleKey: slotId, providerKey: fake.providerKey });
    store.startTask({ taskId, projectId: 'project', slotId, clientId: 'alice',
      requestId: 'request:' + taskId, expectedSlotRevision: 1,
      prompt: 'Question ' + taskId });
    store.observeConversation({ projectId: 'project', slotId, clientId: 'alice',
      taskId, expectedRevision: 1, providerConversationId: 'conversation:' + taskId });
    store.planAttempt({ taskId, clientId: 'alice', attemptId: 'initial:' + taskId,
      kind: 'initial', turnKey: 'original', content: 'Question ' + taskId });
  };
  const ack = async (taskId: string, withFinal = true) => {
    await kernel.dispatch(taskId, 'alice', 'initial:' + taskId);
    if (withFinal) await kernel.observeFinal({ taskId, clientId: 'alice',
      attemptId: 'initial:' + taskId, resultId: 'result:' + taskId,
      completeTask: false });
  };
  const createService = () => new ManagedContinuationService({
    repository: store, kernel, now: () => new Date(current),
  });
  const seedPublicPolicy = (taskId: string, enabled = false) => {
    database.raw.prepare(
      'INSERT INTO kernel_public_task_policies' +
      '(task_id,policy_json,input_sha256,accepted_revision,created_at)' +
      ' VALUES(?,?,?,?,?)',
    ).run(taskId, JSON.stringify(enabled ? {
      enabled: true, approvalRef: 'approved-public',
      message: '계속', intervalMs: CONTINUATION_INTERVAL_MS,
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
    get kernel() { return kernel; },
    get now() { return current; },
    set now(value: number) { current = value; },
    reopen() {
      database.close();
      database = SessionPlaneDatabase.open(file);
      store = new TaskKernelRepository(database, () => new Date(current).toISOString());
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
  assert.equal(env.store.getFullTask('task-a', 'alice').attempts.length, 1);
  env.now = START + CONTINUATION_INTERVAL_MS - 1;
  assert.equal((await service.tick()).timersClaimed, 0);
  assert.equal(env.fake.sends.length, 1);
  env.now++;
  const run = await service.tick();
  assert.deepEqual(run, { timersClaimed: 1, dispatchesAttempted: 1, deferred: 0 });
  assert.equal(env.fake.sends.length, 2);
  assert.equal(env.fake.sends[1]!.kind, 'continuation');
  assert.equal(env.fake.sends[1]!.content, '계속');
  assert.equal(env.store.getFullTask('task-a', 'alice').attempts[1]!.state, 'acknowledged');
  assert.equal(env.store.getFullTask('task-a', 'alice').timers
    .some(t => t.status === 'pending' && t.dueAt === '2026-11-12T00:40:00.000Z'), true);
  assert.equal((await service.tick()).timersClaimed, 0);
  assert.equal(env.fake.sends.length, 2, 'due timer and original attempt cannot replay');
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
  assert.deepEqual(env.store.claimDueTimers(
    new Date(env.now).toISOString(), 50, 'continuation_due').map(t => t.status),
    ['fired'], 'simulate a crash after durable timer claim but before the send plan');
  const recovered = env.createService();
  assert.equal((await recovered.tick()).timersClaimed, 0,
    'restart does not replay an already claimed due event');
  assert.equal(env.fake.sends.length, 1);
  assert.equal(env.store.getFullTask('task-a', 'alice').timers
    .filter(t => t.status === 'pending').length, 1, 'next fixed review is durable');
  env.now += CONTINUATION_INTERVAL_MS;
  assert.equal((await recovered.tick()).dispatchesAttempted, 1);
  assert.equal(env.fake.sends.length, 2);
});

test('no exact final defers without consuming a send, then resumes next fixed slot', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a', false);
  const service = env.createService();
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved', message: '계속' });
  env.now += CONTINUATION_INTERVAL_MS;
  assert.deepEqual(await service.tick(),
    { timersClaimed: 1, dispatchesAttempted: 0, deferred: 1 });
  assert.equal(env.fake.sends.length, 1);
  assert.equal(env.store.getFullTask('task-a', 'alice').attempts.length, 1);
  await env.kernel.observeFinal({ taskId: 'task-a', clientId: 'alice',
    attemptId: 'initial:task-a', resultId: 'delayed-result', completeTask: false });
  env.now += CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  assert.equal(env.fake.sends.length, 2);
});

test('blocked task does not starve another; next due retries only the same planned attempt', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  env.startTask('task-b', 'review');
  await env.ack('task-a');
  await env.ack('task-b');
  const service = env.createService();
  for (const taskId of ['task-a', 'task-b']) {
    service.activate({ taskId, clientId: 'alice', sourceAttemptId: 'initial:' + taskId,
      approvalRef: 'approved-' + taskId, message: '계속' });
  }
  env.fake.blocked.add('task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  const first = await service.tick();
  assert.deepEqual(first, { timersClaimed: 2, dispatchesAttempted: 1, deferred: 1 });
  assert.equal(env.store.getFullTask('task-a', 'alice').attempts[1]!.state, 'planned');
  assert.equal(env.fake.sends.filter(s => s.taskId === 'task-a').length, 1);
  assert.equal(env.fake.sends.filter(s => s.taskId === 'task-b').length, 2);
  env.fake.blocked.delete('task-a');
  env.now += CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).dispatchesAttempted, 1);
  assert.equal(env.fake.sends.filter(s => s.taskId === 'task-a').length, 2);
  assert.equal(env.store.getFullTask('task-a', 'alice').attempts.length, 2,
    'a retry review does not invent another continuation attempt');
});

test('cancellation revokes pending due timers and prevents later continuation', async t => {
  const env = fixture(t);
  env.startTask('task-a', 'main');
  await env.ack('task-a');
  const service = env.createService();
  service.activate({ taskId: 'task-a', clientId: 'alice',
    sourceAttemptId: 'initial:task-a', approvalRef: 'approved', message: '계속' });
  env.store.requestCancel('task-a', 'alice');
  env.now += 2 * CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).timersClaimed, 0);
  assert.equal(env.fake.sends.length, 1);
  assert.equal(env.store.getFullTask('task-a', 'alice').timers[0]!.status, 'canceled');
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
  env.store.scheduleTimer({
    taskId: 'task-a', clientId: 'alice', timerId: 'independent-review',
    kind: 'unrelated_due', dueAt: new Date(START + CONTINUATION_INTERVAL_MS).toISOString(),
    contextJson: '{}',
  });
  env.now += CONTINUATION_INTERVAL_MS;
  assert.equal((await service.tick()).timersClaimed, 1);
  const independent = env.store.getFullTask('task-a', 'alice')
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
  assert.equal(env.store.claimDueTimers(
    new Date(env.now).toISOString(), 50, 'continuation_due').length, 1);
  const plannedId = 'managed-continuation:initial:task-a';
  env.store.planAttempt({
    taskId: 'task-a', clientId: 'alice', attemptId: plannedId,
    kind: 'continuation', turnKey: plannedId, content: '계속',
  });
  await env.kernel.dispatch('task-a', 'alice', plannedId);
  assert.equal(env.fake.sends.length, 2);
  assert.equal(env.store.getFullTask('task-a', 'alice').timers
    .filter(timer => timer.status === 'pending' && timer.kind === 'continuation_due').length, 0);
  env.reopen();
  const restored = env.createService();
  assert.equal((await restored.tick()).timersClaimed, 0);
  const full = env.store.getFullTask('task-a', 'alice');
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
  assert.equal(env.store.getFullTask('task-a', 'alice').attempts[0]!.state, 'planned');
  env.fake.blocked.delete('task-a');
  await service.tick();
  assert.equal(env.fake.sends.length, 1);
  assert.equal(env.fake.sends[0]!.content, 'Question task-a');
  assert.equal(env.fake.sends[0]!.kind, 'initial');
  assert.equal(env.store.getTask('task-a', 'alice').state, 'completed',
    'Core also observes exact FINAL for the public standalone task');
  await service.tick();
  assert.equal(env.fake.sends.length, 1, 'completed public initial never resubmits');
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
      env.store.recordDispatchEvidence({
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
  assert.equal(env.store.getTask('task-a', 'alice').state, 'uncertain');
  assert.deepEqual(recovered, ['initial:task-a'],
    'missing POST evidence is never inferred from an uncertain state');
  ackReady = true;
  await service.tick();
  const exact = env.store.getFullTask('task-a', 'alice');
  assert.equal(exact.task.state, 'completed');
  assert.equal(exact.attempts[0]!.externalTurnId, 'exact-delayed-turn');
  assert.equal(exact.results[0]!.answerText, 'Exact final for initial:task-a');
  assert.equal(exact.attempts.length, 1);
  assert.equal(env.store.getTask('no-evidence', 'alice').state, 'uncertain');
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
  env.store.requestCancel('task-a', 'alice');
  const service = env.createService();
  await service.tick();
  assert.equal(env.fake.sends.length, 0);
  assert.equal(env.store.getFullTask('task-a', 'alice').attempts[0]!.state, 'planned');
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
  assert.equal(env.store.getFullTask('task-a', 'alice').attempts[0]!.state, 'planned');
  assert.ok(env.store.getFullTask('task-a', 'alice').events.some(event =>
    event.event.type === 'observation.deferred' &&
    event.event.reason === 'public-initial-model-intent-unverified'));
  await service.tick();
  assert.equal(env.fake.sends.length, 0, 'repeated review never substitutes a model');
});
