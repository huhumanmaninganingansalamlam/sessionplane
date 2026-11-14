import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { createSemanticCoreRuntime } from '../../src/core/semantic-core-runtime.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../../src/providers/chatgpt/backend-recovery.ts';
import { startCore } from '../../src/main.ts';
import { getMcpTool, invokeMcpTool } from '../../src/mcp/tools.ts';

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-public-task-rpc-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  t.after(async () => {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  });
  const store = core.semanticTaskRepository;
  const clientId = 'alice';
  const projectId = randomUUID();
  const taskId = randomUUID();
  store.openProject({
    projectId, projectKey: 'public-task-' + taskId,
    displayName: 'Public Task fixture', clientId,
  });
  store.openSlot({
    projectId, clientId, slotId: 'main', roleKey: 'main', providerKey: 'chatgpt',
  });
  store.startTask({
    taskId, projectId, slotId: 'main', expectedSlotRevision: 1,
    clientId, requestId: 'public-start-' + taskId, prompt: 'Exact public question',
  });
  const rpc = async <T>(method: string, params: Record<string, unknown>) =>
    await callRpc<T>({ socketPath: config.socketPath, method, params,
      timeoutMs: 10_000, maxLineBytes: 2 * 1024 * 1024 });
  return { core, config, store, clientId, projectId, taskId, rpc };
}

test('Task RPC returns exact result bytes and semantic evidence without scraping browser', async t => {
  const { taskId, clientId, store, rpc } = await fixture(t);
  const empty = await rpc<any>('task.get', { taskId, clientId });
  assert.equal(empty.state, 'working');
  assert.deepEqual(empty.submission, { attempted: false, acknowledged: false });
  assert.equal(empty.decision, null);
  assert.equal(empty.resultAvailable, false);
  store.planAttempt({
    taskId, clientId, attemptId: 'original', kind: 'initial',
    turnKey: 'root', content: 'Exact public question',
  });
  store.beginDispatch(taskId, clientId, 'original');
  store.acknowledgeAttempt({
    taskId, clientId, attemptId: 'original', externalTurnId: 'turn-exact',
  });
  const answer = 'EXACT-FINAL-' + '답변💡'.repeat(5_000);
  store.recordFinal({
    taskId, clientId, attemptId: 'original', externalTurnId: 'turn-exact',
    resultId: 'exact-result', answerText: answer, completeTask: true,
  });
  const summary = await rpc<any>('task.get', { taskId, clientId });
  assert.equal(summary.state, 'completed');
  assert.equal(summary.result, null, 'summary does not silently truncate an answer');
  assert.equal(summary.resultAvailable, true);
  const exact = await rpc<any>('task.get', { taskId, clientId, view: 'result' });
  assert.equal(exact.result.answerText, answer);
  assert.equal(exact.result.answerBytes, Buffer.byteLength(answer, 'utf8'));
  assert.equal(exact.result.answerSha256,
    createHash('sha256').update(answer).digest('hex'));
  const evidence = await rpc<any>('task.get', { taskId, clientId, view: 'evidence' });
  assert.equal(evidence.evidence.conversation.providerConversationId, null);
  assert.equal(evidence.evidence.rootPost, null);
  assert.equal(evidence.evidence.attempts[0].externalTurnId, 'turn-exact');
  assert.equal(evidence.evidence.results[0].answerSha256, exact.result.answerSha256);
  assert.equal(JSON.stringify(evidence).includes(answer), false,
    'evidence view is bounded metadata, result view carries full bytes');
});

test('Task wait returns a revision and MCP get uses the same Core state', async t => {
  const { taskId, clientId, store, config, rpc } = await fixture(t);
  const original = store.getTask(taskId, clientId);
  const waiting = rpc<any>('task.wait', {
    taskId, clientId, afterRevision: original.revision, waitMs: 2_000,
  });
  setTimeout(() => store.recordObservationDeferred(taskId, clientId,
    'public-task-fixture-change'), 50);
  const seen = await waiting;
  assert.ok(seen.revision > original.revision);
  assert.equal(seen.taskId, taskId);
  const read = await rpc<any>('task.get', { taskId, clientId });
  assert.equal(read.revision, seen.revision);
  const definition = getMcpTool('sessionplane_task_get');
  assert.equal(definition?.rpcMethod, 'task.get');
  assert.equal(definition?.annotations.readOnlyHint, true);
  const mcp = await invokeMcpTool({
    name: 'sessionplane_task_get', arguments: { taskId, clientId },
    socketPath: config.socketPath, timeoutMs: 5_000, maxLineBytes: 2 * 1024 * 1024,
  });
  assert.equal(mcp.isError, false);
  assert.equal(mcp.structuredContent.taskId, taskId);
  assert.equal(mcp.structuredContent.revision, seen.revision);
  assert.equal(store.getFullTask(taskId, clientId).attempts.length, 0,
    'reads and wait never submit or plan external attempts');
});

test('Task cancel revokes a never-submitted task; an attempted external mutation remains uncertain', async t => {
  const { taskId, clientId, store, rpc } = await fixture(t);
  store.planAttempt({
    taskId, clientId, attemptId: 'pending-original',
    kind: 'initial', turnKey: 'root', content: 'Exact public question',
  });
  const result = await rpc<any>('task.cancel', {
    taskId, clientId, requestId: 'cancel-no-post',
  });
  assert.equal(result.state, 'canceled');
  assert.equal(result.cancelOutcome, 'not_submitted');
  assert.equal(result.cancelRequested, true);
  assert.deepEqual(await rpc<any>('task.cancel', {
    taskId, clientId, requestId: 'cancel-no-post',
  }), result, 'same cancellation request replays its exact durable receipt');
  assert.equal(store.getFullTask(taskId, clientId).attempts[0].state, 'planned');
  const projectId = randomUUID();
  const other = randomUUID();
  store.openProject({ projectId, projectKey: 'cancel-other-' + other,
    displayName: 'Other project', clientId });
  store.openSlot({ projectId, clientId, slotId: 'main',
    roleKey: 'main', providerKey: 'chatgpt' });
  store.startTask({
    taskId: other, projectId, slotId: 'main', expectedSlotRevision: 1,
    clientId, requestId: 'other-start', prompt: 'Other question',
  });
  await assert.rejects(rpc('task.cancel', {
    taskId: other, clientId, requestId: 'cancel-no-post',
  }), /Cancellation requestId is already bound/);
  assert.equal(store.getTask(other, clientId).state, 'working',
    'a requestId collision cannot cancel an unrelated Task');
  store.planAttempt({
    taskId: other, clientId, attemptId: 'maybe-sent',
    kind: 'initial', turnKey: 'root', content: 'Other question',
  });
  store.beginDispatch(other, clientId, 'maybe-sent');
  const uncertain = await rpc<any>('task.cancel', {
    taskId: other, clientId, requestId: 'stop-intent',
  });
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(uncertain.cancelOutcome, 'external_stop_unverified');
  assert.equal(uncertain.cancelRequested, true);
  assert.equal(store.getFullTask(other, clientId).attempts[0].state, 'dispatched');
  store.acknowledgeAttempt({
    taskId: other, clientId, attemptId: 'maybe-sent', externalTurnId: 'late-ack-after-cancel',
  });
  assert.deepEqual(await rpc<any>('task.cancel', {
    taskId: other, clientId, requestId: 'stop-intent',
  }), uncertain, 'late canonical ACK does not rewrite the original cancel receipt');
  const observed = await rpc<any>('task.cancel', {
    taskId: other, clientId, requestId: 'different-cancel-request',
  });
  assert.equal(observed.state, 'uncertain');
  assert.equal(observed.submission.acknowledged, true,
    'a new read receipt may reflect the late ACK without reviving cancellation');
});

test('Task decide rejects arbitrary selector, stale decision and invalid typed input at schema boundary', async t => {
  const { taskId, clientId, store, rpc } = await fixture(t);
  const decisionId = randomUUID();
  const actionRef = randomUUID();
  const decisionPacket = {
    taskId, taskRevision: 2, decisionId, kind: 'provider_question',
    reason: 'fixture-question', humanOnly: false,
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
    snapshotId: 'snapshot', questionText: 'Proceed?', permission: null,
    options: [{
      actionRef, purpose: 'answer_question', effect: 'Exact choice', risk: 'send_once',
      evidenceHash: 'fixture-hash', expiresAt: new Date(Date.now() + 20_000).toISOString(),
      inputSchema: { kind: 'option', options: [
        { value: 'Proceed', enabled: true }, { value: 'Decline', enabled: false },
      ] },
    }],
    evidenceBytes: 100,
  };
  store.planAttempt({ taskId, clientId, attemptId: 'original',
    kind: 'initial', turnKey: 'root', content: 'Exact public question' });
  store.requireDecision({ taskId, clientId, decisionId, audience: 'agent',
    contextJson: JSON.stringify({
      kind: 'semantic_action', attemptId: 'original', context: {
        projectId: store.getTask(taskId,clientId).projectId,
        slotId: 'main', slotRevision: 1, taskId,
        providerConversationId: null, submittedUserMessageId: null,
        submittedUserTurnId: null, pageLease: null,
      }, purpose: 'answer_question', snapshotId: 'snapshot',
      actionRef, evidenceHash: 'fixture-hash', packet: decisionPacket,
    }),
  });
  const before = await rpc<any>('task.get', { taskId, clientId });
  assert.equal(before.state, 'agent_input_required');
  assert.equal(before.decision.decisionId, decisionId);
  await assert.rejects(rpc('task.decide', { taskId, clientId,
    decisionId, requestId: 'forged', actionRef, input: 'Proceed',
    selector: '#danger' }), (error: any) => {
      assert.equal(error.code, -32602);
      assert.equal(error.data?.errorCode, 'invalid_request');
      return true;
    });
  await assert.rejects(rpc('task.decide', { taskId, clientId,
    decisionId: randomUUID(), requestId: 'missing-choice', actionRef,
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'stale_decision');
    return true;
  });
  await assert.rejects(rpc('task.decide', { taskId, clientId,
    decisionId, requestId: 'disabled', actionRef, input: 'Decline' }),
    (error: any) => {
      assert.equal(error.data?.errorCode, 'invalid_request');
      return true;
    });
  assert.equal(store.getTask(taskId, clientId).pendingDecisionId, decisionId);
});


test('project.open is owner-scoped and persists one canonical Main identity and intent', async t => {
  const { config, rpc } = await fixture(t);
  const first = await rpc<any>('project.open', {
    clientId: 'alice', requestId: 'open-project-1',
    projectKey: 'Project Alpha', displayName: 'Alpha',
    provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'pro',
  });
  assert.match(first.projectId, /^[0-9a-f-]{36}$/i);
  assert.equal(first.mainConversationSlotId, 'main');
  assert.equal(first.conversationRevision, 1);
  assert.equal(first.provider, 'chatgpt');
  assert.equal(first.modelIntent, 'Pro', 'public Pro intent is canonicalized');
  assert.equal(first.currentTaskId, null);
  const repeated = await rpc<any>('project.open', {
    clientId: 'alice', requestId: 'open-project-1',
    projectKey: 'Project Alpha', displayName: 'Alpha',
    provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'pro',
  });
  assert.deepEqual(repeated, first);
  const renamed = await rpc<any>('project.open', {
    clientId: 'alice', requestId: 'open-project-2',
    projectKey: 'project alpha', displayName: 'Another display name',
    provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'pro',
  });
  assert.equal(renamed.projectId, first.projectId);
  assert.equal(renamed.displayName, 'Alpha', 'reopening a key does not create a second project');
  const other = await rpc<any>('project.open', {
    clientId: 'bob', requestId: 'open-project-1',
    projectKey: 'Project Alpha', displayName: 'Bob Alpha',
    provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'pro',
  });
  assert.notEqual(other.projectId, first.projectId,
    'a project key is scoped by owner, not a global shared alias');
  await assert.rejects(rpc('task.start', {
    clientId: 'bob', requestId: 'unauthorized-task',
    projectId: first.projectId, expectedConversationRevision: 1,
    prompt: 'Not your project',
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'invalid_request');
    return true;
  });
  await assert.rejects(rpc('project.open', {
    clientId: 'alice', requestId: 'open-project-1',
    projectKey: 'Another key', displayName: 'Alpha',
    provider: 'chatgpt', surfaceIntent: 'chat',
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'idempotency_conflict');
    return true;
  });
  await assert.rejects(rpc('project.open', {
    clientId: 'alice', requestId: 'open-project-3',
    projectKey: 'project alpha', displayName: 'Alpha',
    provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'different-model',
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'project_conflict');
    return true;
  });
  const mcp = await invokeMcpTool({
    name: 'sessionplane_project_open',
    arguments: { clientId: 'alice', requestId: 'open-project-1',
      projectKey: 'Project Alpha', displayName: 'Alpha',
      provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'pro' },
    socketPath: config.socketPath, timeoutMs: 5_000, maxLineBytes: 2 * 1024 * 1024,
  });
  assert.equal(mcp.isError, false);
  assert.equal(mcp.structuredContent.projectId, first.projectId);
});

test('task.start atomically plans one original attempt and returns current slot revision', async t => {
  const { rpc, store, config } = await fixture(t);
  const project = await rpc<any>('project.open', {
    clientId: 'alice', requestId: 'open-for-task',
    projectKey: 'fresh-start', displayName: 'Fresh',
    provider: 'chatgpt', surfaceIntent: 'chat',
  });
  const input = {
    clientId: 'alice', requestId: 'submit-first',
    projectId: project.projectId,
    expectedConversationRevision: project.conversationRevision,
    prompt: 'Exact new substantive question',
    continuationPolicy: {
      enabled: true, intervalMs: 1_200_000,
      message: '계속', approvalRef: 'user-delegated-review',
    },
  };
  const started = await rpc<any>('task.start', input);
  assert.match(started.taskId, /^[0-9a-f-]{36}$/i);
  assert.equal(started.conversationSlotId, 'main');
  assert.equal(started.conversationRevision, 2);
  assert.equal(started.state, 'working');
  assert.equal(started.submission.attempted, false);
  assert.equal(started.preparation, 'not_bound',
    'without a verified provider conversation Task persists before any POST');
  const full = store.getFullTask(started.taskId, 'alice');
  assert.equal(full.attempts.length, 1);
  assert.equal(full.attempts[0]!.state, 'planned');
  assert.equal(full.attempts[0]!.content, input.prompt);
  assert.equal((await rpc<any>('task.get', {
    clientId: 'alice', taskId: started.taskId,
  })).conversationRevision, 2);
  assert.deepEqual(await rpc('task.start', input), started);
  assert.equal(store.getFullTask(started.taskId, 'alice').attempts.length, 1,
    'a replay must not submit the initial prompt or plan a duplicate attempt');
  await assert.rejects(rpc('task.start', {
    ...input, requestId: 'competing-start',
  }), /Conversation revision conflict/i);
  await assert.rejects(rpc('task.start', {
    ...input, requestId: 'busy-current-revision', expectedConversationRevision: 2,
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'conversation_busy');
    return true;
  });
  await assert.rejects(rpc('task.start', {
    ...input, requestId: 'different-prompt', expectedConversationRevision: 1,
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'conversation_conflict');
    return true;
  });
  await assert.rejects(rpc('task.start', {
    ...input, prompt: 'Change the original question under one requestId',
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'idempotency_conflict');
    return true;
  });
  await assert.rejects(rpc('task.start', {
    ...input, continuationPolicy: { ...input.continuationPolicy, message: 'not exact 계속' },
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'invalid_request');
    return true;
  });
  const mcp = await invokeMcpTool({
    name: 'sessionplane_task_start', arguments: input,
    socketPath: config.socketPath, timeoutMs: 5_000, maxLineBytes: 2 * 1024 * 1024,
  });
  assert.equal(mcp.isError, false);
  assert.equal(mcp.structuredContent.taskId, started.taskId);
});


test('approved task.start policy automatically arms on exact ACK without any client wait', async t => {
  const { core, store, rpc } = await fixture(t);
  const project = await rpc<any>('project.open', {
    clientId: 'alice', requestId: 'open-policy',
    projectKey: 'managed-admission', displayName: 'Managed',
    provider: 'chatgpt', surfaceIntent: 'chat',
  });
  const started = await rpc<any>('task.start', {
    clientId: 'alice', requestId: 'start-policy', projectId: project.projectId,
    expectedConversationRevision: project.conversationRevision,
    prompt: 'Long-running approved task',
    continuationPolicy: {
      enabled: true, intervalMs: 1_200_000,
      message: '계속', approvalRef: 'explicit-delegation',
    },
  });
  const attempt = store.getFullTask(started.taskId, 'alice').attempts[0]!;
  assert.equal((await core.semanticManagedContinuation.tick()).timersClaimed, 0);
  assert.equal(store.getFullTask(started.taskId, 'alice').timers.length, 0,
    'approval alone cannot create a timer before provider ACK');
  store.observeConversation({
    projectId: project.projectId, clientId: 'alice',
    slotId: 'main', expectedRevision: 1, taskId: started.taskId,
    providerConversationId: 'verified-fixture-conversation',
  });
  store.beginDispatch(started.taskId, 'alice', attempt.attemptId);
  store.acknowledgeAttempt({
    taskId: started.taskId, clientId: 'alice',
    attemptId: attempt.attemptId, externalTurnId: 'verified-turn',
  });
  const acknowledged = store.getFullTask(started.taskId, 'alice').attempts[0]!;
  const expectedDue = new Date(
    Date.parse(acknowledged.acknowledgedAt!) + 1_200_000).toISOString();
  assert.equal((await core.semanticManagedContinuation.tick()).timersClaimed, 0);
  const tasks = store.getFullTask(started.taskId, 'alice');
  assert.equal(tasks.timers.length, 1);
  assert.equal(tasks.timers[0]?.dueAt, expectedDue);
  assert.equal(tasks.timers[0]?.status, 'pending');
  assert.equal((await rpc<any>('task.get', {
    clientId: 'alice', taskId: started.taskId,
  })).nextAutomaticActionAt, expectedDue);
  assert.equal((await core.semanticManagedContinuation.tick()).timersClaimed, 0);
  assert.equal(store.getFullTask(started.taskId, 'alice').timers.length, 1,
    'same ACK does not create a second continuation timer');
  const cancellation = await rpc<any>('task.cancel', {
    clientId: 'alice', taskId: started.taskId, requestId: 'cancel-approved-task',
  });
  assert.equal(cancellation.cancelRequested, true);
  assert.equal(store.getFullTask(started.taskId, 'alice').timers[0]?.status, 'canceled');
});


test('Core independently recovers delayed public ACK and exact FINAL without a client or browser', async t => {
  const { core, rpc, store } = await fixture(t);
  const project = await rpc<any>('project.open', {
    clientId: 'alice', requestId: 'open-autonomous-final',
    projectKey: 'autonomous-final', displayName: 'Autonomous final',
    provider: 'chatgpt', surfaceIntent: 'chat',
  });
  const started = await rpc<any>('task.start', {
    clientId: 'alice', requestId: 'start-autonomous-final',
    projectId: project.projectId,
    expectedConversationRevision: project.conversationRevision,
    prompt: 'Exact public final prompt',
  });
  const attempt = store.getFullTask(started.taskId, 'alice').attempts[0]!;
  store.observeConversation({
    projectId: project.projectId, slotId: 'main', expectedRevision: 1,
    clientId: 'alice', taskId: started.taskId,
    providerConversationId: 'public-fixture-conversation',
  });
  store.beginDispatch(started.taskId, 'alice', attempt.attemptId);
  store.recordDispatchEvidence({
    taskId: started.taskId, clientId: 'alice', attemptId: attempt.attemptId,
    evidence: {
      conversationId: 'public-fixture-conversation',
      messageId: 'public-user-one', parentMessageId: 'root',
      textHash: createHash('sha256').update('Exact public final prompt').digest('hex'),
      observedAt: new Date().toISOString(),
    },
  });
  store.markUncertain(started.taskId, 'alice', attempt.attemptId,
    'canonical-ack-still-unverified');
  const payload = {
    id: 'public-fixture-conversation', current_node: 'assistant-one',
    mapping: {
      root: { id: 'root', parent: null, children: [], message: null },
      'public-user-node': {
        id: 'public-user-node', parent: 'root', children: [],
        message: { id: 'public-user-one', turn_id: 'public-turn-one',
          author: { role: 'user' }, content: { parts: ['Exact public final prompt'] } },
      },
      'assistant-one': {
        id: 'assistant-one', parent: 'public-user-node', children: [],
        message: { id: 'assistant-one', author: { role: 'assistant' },
          channel: 'final', status: 'finished_successfully', end_turn: true,
          content: { parts: ['Autonomous exact FINAL 🌟'] }, metadata: {} },
      },
    },
  };
  let reads = 0;
  let backendNow = Date.now();
  const backend: BackendJsonClient = {
    authScope: {},
    async get(url) {
      reads++;
      return url.endsWith('/api/auth/session')
        ? { status: 200, headers: {}, body: { accessToken: 'fixture-token' } }
        : { status: 200, headers: {}, body: payload };
    },
  };
  const runtime = createSemanticCoreRuntime({
    database: core.database,
    browserOwner: null, pageRegistry: core.pageRegistry,
    teamDirectory: core.teamDirectory, pageMutationMutex: core.pageMutationMutex,
    enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
    backendClientProvider: () => backend,
    backendRecovery: new ChatGptBackendRecovery({
      requestTimeoutMs: 500, tokenCacheTtlMs: 10_000,
      now: () => new Date(backendNow),
    }),
  });
  assert.equal(store.getTask(started.taskId, 'alice').state, 'uncertain');
  assert.equal((await runtime.managedContinuation.tick()).dispatchesAttempted, 0);
  assert.equal(store.getTask(started.taskId, 'alice').state, 'working',
    'canonical ACK restores working while the next GET respects pacing');
  assert.equal(store.getFullTask(started.taskId, 'alice').attempts[0]!.state, 'acknowledged');
  backendNow += 60_000;
  await runtime.managedContinuation.tick();
  const exact = await rpc<any>('task.get', {
    clientId: 'alice', taskId: started.taskId, view: 'result',
  });
  assert.equal(exact.state, 'completed');
  assert.equal(exact.submission.acknowledged, true);
  assert.equal(exact.result.externalTurnId, 'public-turn-one');
  assert.equal(exact.result.answerText, 'Autonomous exact FINAL 🌟');
  assert.equal(exact.result.completesTask, true);
  assert.equal(store.getFullTask(started.taskId, 'alice').attempts.length, 1,
    'the Final observer cannot create another POST attempt');
  const before = reads;
  await runtime.managedContinuation.tick();
  assert.equal(reads, before, 'completed public task is not read again');
  await runtime.managedContinuation.close();
});


test('approved public Task completes on exact FINAL and cancels its pending 20m Continue', async t => {
  const { core, rpc, store } = await fixture(t);
  const project = await rpc<any>('project.open', {
    clientId: 'alice', requestId: 'open-managed-public-final',
    projectKey: 'managed-public-final', displayName: 'Managed exact final',
    provider: 'chatgpt', surfaceIntent: 'chat',
  });
  const started = await rpc<any>('task.start', {
    clientId: 'alice', requestId: 'start-managed-public-final',
    projectId: project.projectId,
    expectedConversationRevision: project.conversationRevision,
    prompt: 'Continue pending project',
    continuationPolicy: {
      enabled: true, approvalRef: 'user-authorized-task',
      intervalMs: 1_200_000, message: '계속',
    },
  });
  const attempt = store.getFullTask(started.taskId, 'alice').attempts[0]!;
  store.observeConversation({
    projectId: project.projectId, slotId: 'main',
    expectedRevision: 1, clientId: 'alice', taskId: started.taskId,
    providerConversationId: 'managed-public-conversation',
  });
  store.beginDispatch(started.taskId, 'alice', attempt.attemptId);
  store.recordDispatchEvidence({
    taskId: started.taskId, clientId: 'alice', attemptId: attempt.attemptId,
    evidence: {
      conversationId: 'managed-public-conversation',
      messageId: 'managed-public-user', parentMessageId: 'root',
      textHash: createHash('sha256').update('Continue pending project').digest('hex'),
      observedAt: new Date().toISOString(),
    },
  });
  store.acknowledgeAttempt({
    taskId: started.taskId, clientId: 'alice', attemptId: attempt.attemptId,
    externalTurnId: 'managed-public-turn',
  });
  const payload = {
    id: 'managed-public-conversation', current_node: 'assistant-final',
    mapping: {
      root: { id: 'root', parent: null, children: [], message: null },
      question: {
        id: 'question', parent: 'root', children: [],
        message: { id: 'managed-public-user', turn_id: 'managed-public-turn',
          author: { role: 'user' }, content: { parts: ['Continue pending project'] } },
      },
      'assistant-final': {
        id: 'assistant-final', parent: 'question', children: [],
        message: { id: 'answer-managed', author: { role: 'assistant' },
          channel: 'final', status: 'finished_successfully', end_turn: true,
          content: { parts: ['Current stage done, policy still approved'] }, metadata: {} },
      },
    },
  };
  let conversationReads = 0;
  const backend: BackendJsonClient = {
    authScope: {},
    async get(url) {
      if (url.endsWith('/api/auth/session')) {
        return { status: 200, headers: {}, body: { accessToken: 'fixture-token' } };
      }
      conversationReads++;
      return { status: 200, headers: {}, body: payload };
    },
  };
  const runtime = createSemanticCoreRuntime({
    database: core.database, browserOwner: null,
    pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
    pageMutationMutex: core.pageMutationMutex,
    enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
    backendClientProvider: () => backend,
    backendRecovery: new ChatGptBackendRecovery({
      requestTimeoutMs: 500, tokenCacheTtlMs: 10_000,
    }),
  });
  const result = await runtime.managedContinuation.tick();
  assert.equal(result.dispatchesAttempted, 0);
  assert.equal(conversationReads, 1);
  const exact = await rpc<any>('task.get', {
    clientId: 'alice', taskId: started.taskId, view: 'result',
  });
  assert.equal(exact.state, 'completed');
  assert.equal(exact.result.answerText, 'Current stage done, policy still approved');
  assert.equal(exact.result.completesTask, true,
    'a verified FINAL ends this Task even when the continuation policy was approved');
  assert.equal(exact.nextAutomaticActionAt, null);
  assert.equal(store.getFullTask(started.taskId, 'alice').timers
    .filter(timer => timer.status === 'pending').length, 0);
  assert.equal(store.getFullTask(started.taskId, 'alice').attempts.length, 1,
    'no client and no active page mean no early continuation POST');
  await runtime.managedContinuation.tick();
  assert.equal(conversationReads, 1, 'exact FINAL is not re-read on the next tick');
  await runtime.managedContinuation.close();
});

test('public exact FINAL 429 remains working, without fabricated answer or new attempt', async t => {
  const { core, rpc, store } = await fixture(t);
  const project = await rpc<any>('project.open', {
    clientId: 'alice', requestId: 'open-final-429',
    projectKey: 'public-final-429', displayName: 'Rate limit fixture',
    provider: 'chatgpt', surfaceIntent: 'chat',
  });
  const started = await rpc<any>('task.start', {
    clientId: 'alice', requestId: 'start-final-429',
    projectId: project.projectId,
    expectedConversationRevision: project.conversationRevision,
    prompt: 'Do not infer a final',
  });
  const attempt = store.getFullTask(started.taskId, 'alice').attempts[0]!;
  store.observeConversation({
    projectId: project.projectId, slotId: 'main',
    expectedRevision: 1, clientId: 'alice', taskId: started.taskId,
    providerConversationId: 'final-429-conversation',
  });
  store.beginDispatch(started.taskId, 'alice', attempt.attemptId);
  store.recordDispatchEvidence({
    taskId: started.taskId, clientId: 'alice', attemptId: attempt.attemptId,
    evidence: {
      conversationId: 'final-429-conversation', messageId: 'final-user',
      parentMessageId: 'root',
      textHash: createHash('sha256').update('Do not infer a final').digest('hex'),
      observedAt: new Date().toISOString(),
    },
  });
  store.acknowledgeAttempt({
    taskId: started.taskId, clientId: 'alice', attemptId: attempt.attemptId,
    externalTurnId: 'final-user-turn',
  });
  let detailReads = 0;
  const backend: BackendJsonClient = {
    authScope: {},
    async get(url) {
      if (url.endsWith('/api/auth/session')) {
        return { status: 200, headers: {}, body: { accessToken: 'fixture-token' } };
      }
      detailReads++;
      return { status: 429, headers: { 'retry-after': '120' }, body: {} };
    },
  };
  const runtime = createSemanticCoreRuntime({
    database: core.database, browserOwner: null,
    pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
    pageMutationMutex: core.pageMutationMutex,
    enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
    backendClientProvider: () => backend,
    backendRecovery: new ChatGptBackendRecovery({
      requestTimeoutMs: 500, tokenCacheTtlMs: 10_000,
    }),
  });
  await runtime.managedContinuation.tick();
  const pending = await rpc<any>('task.get', {
    clientId: 'alice', taskId: started.taskId, view: 'result',
  });
  assert.equal(pending.state, 'working');
  assert.equal(pending.result, null);
  assert.equal(pending.resultAvailable, false);
  assert.equal(store.getFullTask(started.taskId, 'alice').attempts.length, 1);
  assert.equal(detailReads, 1);
  await runtime.managedContinuation.tick();
  assert.equal(detailReads, 1, 'Retry-After prevents premature repeated GET');
  await runtime.managedContinuation.close();
});


test('three independent public questions reuse one Main conversation and never splice old answers', async t => {
  const { rpc, store, clientId } = await fixture(t);
  const project = await rpc<any>('project.open', {
    clientId, requestId: 'multi-main-project',
    projectKey: 'multi-main-reuse', displayName: 'Main reuse',
    provider: 'chatgpt', surfaceIntent: 'chat',
  });
  const questions = ['First work', 'Second work', 'Third work'];
  let revision = project.conversationRevision;
  const ids: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const requestId = 'multi-start-' + i;
    const started = await rpc<any>('task.start', {
      clientId, requestId, projectId: project.projectId,
      expectedConversationRevision: revision, prompt: questions[i],
    });
    ids.push(started.taskId);
    revision = started.conversationRevision;
    assert.equal(started.conversationSlotId, 'main');
    assert.equal(started.state, 'working');
    assert.equal(started.submission.attempted, false);
    if (i === 0) {
      store.observeConversation({
        projectId: project.projectId, slotId: 'main', clientId,
        expectedRevision: 1, taskId: started.taskId,
        providerConversationId: 'single-provider-conversation',
      });
    } else {
      assert.equal(store.getSlot(project.projectId, 'main', clientId)
        .providerConversationId, 'single-provider-conversation');
    }
    const initial = store.getFullTask(started.taskId, clientId).attempts[0]!;
    assert.equal(initial.kind, 'initial');
    assert.equal(initial.content, questions[i]);
    store.beginDispatch(started.taskId, clientId, initial.attemptId);
    store.acknowledgeAttempt({
      taskId: started.taskId, clientId, attemptId: initial.attemptId,
      externalTurnId: 'turn-' + i,
    });
    store.recordFinal({
      taskId: started.taskId, clientId, attemptId: initial.attemptId,
      externalTurnId: 'turn-' + i, resultId: 'final-' + i,
      answerText: 'Answer to ' + questions[i], completeTask: true,
    });
    const done = await rpc<any>('task.get', {
      clientId, taskId: started.taskId, view: 'result',
    });
    assert.equal(done.state, 'completed');
    assert.equal(done.result.answerText, 'Answer to ' + questions[i]);
    assert.equal(done.result.externalTurnId, 'turn-' + i);
    assert.equal(store.getSlot(project.projectId, 'main', clientId)
      .activeTaskId, null, 'terminal Task releases only the slot lease');
    assert.equal((await rpc<any>('task.start', {
      clientId, requestId, projectId: project.projectId,
      expectedConversationRevision: revision - 1, prompt: questions[i],
    })).taskId, started.taskId, 'idempotent replay still resolves the original Task');
    const projectRead = await rpc<any>('project.open', {
      clientId, requestId: 'reopen-multi-' + i,
      projectKey: 'multi-main-reuse', displayName: 'Main reuse',
      provider: 'chatgpt', surfaceIntent: 'chat',
    });
    assert.equal(projectRead.currentTaskId, null);
    assert.equal(projectRead.conversationRevision, revision);
  }
  assert.equal(new Set(ids).size, questions.length);
  for (let i = 0; i < ids.length; i++) {
    assert.equal((await rpc<any>('task.get', {
      clientId, taskId: ids[i], view: 'result',
    })).result.answerText, 'Answer to ' + questions[i]);
  }
});


test('public Task evidence exposes canonical root identity without adopting a later conversation', async t => {
  const { core, clientId, store, rpc } = await fixture(t);
  const team = core.teamDirectory.createTeam({
    clientId, name: 'Exact root evidence fixture', primaryRoleKey: 'main',
  });
  const projectId = team.teamId;
  const taskId = randomUUID();
  store.openProject({ projectId, clientId, projectKey: 'root-evidence-' + taskId,
    displayName: 'Root evidence fixture' });
  store.openSlot({ projectId, clientId, slotId: 'main',
    roleKey: 'main', providerKey: 'chatgpt' });
  store.startTask({ taskId, projectId, clientId, slotId: 'main',
    expectedSlotRevision: 1, requestId: 'initial-' + taskId,
    prompt: 'Exact public question' });
  store.planAttempt({ taskId, clientId, attemptId: 'exact-root', kind: 'initial',
    turnKey: 'root', content: 'Exact public question' });
  store.beginDispatch(taskId, clientId, 'exact-root');
  const session = core.teamDirectory.createSession({
    teamId: projectId, roleKey: 'main', provider: 'chatgpt',
  });
  const original = {
    sessionId: session.sessionId, generation: 1, pageKey: 'fixture-page',
    targetId: 'fixture-target', bindingEpoch: 1,
    messageId: 'original-user-message', parentMessageId: 'original-parent',
    textHash: createHash('sha256').update('Exact public question').digest('hex'),
    observedAt: new Date().toISOString(), requestConversationId: null,
  };
  store.recordRootPost({ taskId, clientId, attemptId: 'exact-root', evidence: original });
  const before = await rpc<any>('task.get', { taskId, clientId, view: 'evidence' });
  assert.equal(before.evidence.conversation.providerConversationId, null);
  assert.equal(before.evidence.rootPost.observationCount, 1);
  assert.equal(before.evidence.rootPost.ambiguous, false);
  assert.equal(before.evidence.rootPost.contentSha256, original.textHash);
  assert.equal(before.evidence.rootPost.canonicalConversationId, null);
  assert.equal(before.evidence.rootPost.userMessageId, original.messageId);
  assert.equal(JSON.stringify(before).includes('Exact public question'), false,
    'Evidence contains only bounded provenance, not the original prompt');

  store.promoteRootPost({ taskId, clientId, attemptId: 'exact-root',
    conversationId: 'verified-conversation', messageId: original.messageId,
    externalTurnId: 'verified-turn' });
  const acknowledged = await rpc<any>('task.get', { taskId, clientId, view: 'evidence' });
  assert.equal(acknowledged.submission.acknowledged, true);
  assert.equal(acknowledged.evidence.conversation.providerConversationId, 'verified-conversation');
  assert.equal(acknowledged.evidence.rootPost.canonicalConversationId, 'verified-conversation');
  store.recordFinal({ taskId, clientId, attemptId: 'exact-root',
    externalTurnId: 'verified-turn', resultId: 'root-result',
    answerText: 'Exact root answer', completeTask: true });
  store.replaceBinding({
    projectId: store.getTask(taskId, clientId).projectId,
    clientId, slotId: 'main', expectedRevision: 1,
    providerKey: 'chatgpt', providerConversationId: 'later-conversation',
  });
  const historical = await rpc<any>('task.get', { taskId, clientId, view: 'evidence' });
  assert.equal(historical.evidence.conversation.providerConversationId, 'verified-conversation',
    'Historical Task evidence cannot adopt the new slot binding');
  assert.equal(historical.evidence.rootPost.canonicalConversationId, 'verified-conversation');
});

test('an ambiguous initial POST is visible as durable evidence, never a fabricated ACK', async t => {
  const { taskId, clientId, store, rpc } = await fixture(t);
  store.planAttempt({ taskId, clientId, attemptId: 'uncertain-root',
    kind: 'initial', turnKey: 'root', content: 'Exact public question' });
  store.beginDispatch(taskId, clientId, 'uncertain-root');
  const original = {
    sessionId: 'one-session', generation: 1, pageKey: 'root-page', targetId: 'target',
    bindingEpoch: 1, messageId: 'post-one', parentMessageId: 'parent-one',
    textHash: createHash('sha256').update('Exact public question').digest('hex'),
    observedAt: new Date().toISOString(), requestConversationId: null,
  };
  store.recordRootPost({ taskId, clientId, attemptId: 'uncertain-root', evidence: original });
  assert.throws(() => store.recordRootPost({
    taskId, clientId, attemptId: 'uncertain-root',
    evidence: { ...original, messageId: 'post-two' },
  }), /Conflicting root POST evidence/);
  const evidence = await rpc<any>('task.get', { taskId, clientId, view: 'evidence' });
  assert.equal(evidence.evidence.rootPost.ambiguous, true);
  assert.equal(evidence.evidence.rootPost.observationCount, 2);
  assert.equal(evidence.evidence.rootPost.canonicalConversationId, null);
  assert.equal(evidence.submission.acknowledged, false);
  assert.throws(() => store.promoteRootPost({
    taskId, clientId, attemptId: 'uncertain-root',
    conversationId: 'untrusted', messageId: 'post-one', externalTurnId: 'bad-turn',
  }), /one unambiguous observed POST/);
});

test('caller-scoped task.start requestId cannot create a second Task in another project', async t => {
  const { rpc, core } = await fixture(t);
  const clientId = 'alice';
  const projects = [];
  for (const i of [1, 2]) {
    projects.push(await rpc<any>('project.open', {
      clientId, requestId: 'cross-project-open-' + i,
      projectKey: 'cross-project-idempotency-' + i,
      displayName: 'Independent project ' + i,
      provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
    }));
  }
  const a = projects[0]!;
  const b = projects[1]!;
  const original = {
    clientId, projectId: a.projectId,
    requestId: 'one-client-idempotency-key',
    expectedConversationRevision: a.conversationRevision,
    prompt: 'A single original prompt in project A',
  };
  const admitted = await rpc<any>('task.start', original);
  assert.equal((await rpc<any>('task.start', original)).taskId, admitted.taskId);
  await assert.rejects(rpc('task.start', {
    ...original, projectId: b.projectId, prompt: 'A foreign second project prompt',
  }), (error: any) => {
    assert.equal(error.data?.errorCode, 'idempotency_conflict');
    return true;
  });
  const projectB = await rpc<any>('project.open', {
    clientId, requestId: 'cross-project-open-2',
    projectKey: 'cross-project-idempotency-2',
    displayName: 'Independent project 2',
    provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
  });
  assert.equal(projectB.conversationRevision, 1,
    'An identity collision must not advance a different project revision');
  assert.equal(projectB.currentTaskId, null,
    'An identity collision must not admit a foreign Task');
  assert.equal(core.database.raw.prepare(
    'SELECT COUNT(*) AS n FROM kernel_tasks WHERE client_id=? AND request_id=?'
  ).get(clientId, original.requestId)!.n, 1);
  const independent = await rpc<any>('task.start', {
    ...original, projectId: b.projectId, requestId: 'distinct-project-b-task',
    prompt: 'Allowed independent question for the second project',
  });
  assert.notEqual(independent.taskId, admitted.taskId);
  assert.equal(independent.conversationRevision, 2,
    'Distinct idempotency identity must still allow an independent Task');
});
