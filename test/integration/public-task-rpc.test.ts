import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
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
  assert.equal((await rpc<any>('task.cancel', {
    taskId, clientId, requestId: 'cancel-no-post',
  })).state, 'canceled');
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
    selector: '#danger' }), /Invalid params/);
  await assert.rejects(rpc('task.decide', { taskId, clientId,
    decisionId, requestId: 'disabled', actionRef, input: 'Decline' }),
    /Internal error|selected input/i);
  assert.equal(store.getTask(taskId, clientId).pendingDecisionId, decisionId);
});
