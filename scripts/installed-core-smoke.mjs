#!/usr/bin/env node
/** Run the *installed tarball's* Core inside a disposable no-browser sandbox.
 * The caller must provide the verified npm-install root and package-smoke
 * tmp directory. No installed service, actual profile or user socket is read.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [installedArg, sandboxArg] = process.argv.slice(2);
if (!installedArg || !sandboxArg) throw new Error('Usage: installed-core-smoke.mjs INSTALLED_ROOT PACKAGE_SANDBOX');
const installed = path.resolve(installedArg);
const sandbox = path.resolve(sandboxArg);
if (path.dirname(sandbox) !== path.resolve(tmpdir()) ||
    !path.basename(sandbox).startsWith('sessionplane-package-smoke-') ||
    !installed.startsWith(path.join(sandbox, 'global', 'lib', 'node_modules') + path.sep) ||
    !existsSync(path.join(installed, 'dist', 'main.js'))) {
  throw new Error('Refusing non-isolated installed Core invocation');
}
const work = mkdtempSync(path.join(sandbox, 'installed-core-'));
const moduleAt = (name) => import(pathToFileURL(path.join(installed, 'dist', name)).href);
let core;
try {
  const [{ startCore }, { resolveConfig }, { callRpc },
    { invokeMcpTool, MCP_TOOLS }, { migrations }] = await Promise.all([
    moduleAt('main.js'), moduleAt('config.js'), moduleAt('cli/client.js'),
    moduleAt('mcp/tools.js'), moduleAt('storage/migrations/index.js'),
  ]);
  const config = resolveConfig({ cwd: work, env: {}, stateDir: '.state' });
  assert.ok(path.resolve(config.stateDir).startsWith(work + path.sep),
    'Installed test Core state must stay in temporary directory');
  assert.ok(path.resolve(config.socketPath).startsWith(work + path.sep),
    'Installed test Core socket must stay in temporary directory');
  assert.ok(path.resolve(config.profileDir).startsWith(work + path.sep),
    'Installed test Core profile must stay in temporary directory');
  core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  assert.equal(core.browserOwner, null);
  const rpc = (method, params) => callRpc({
    socketPath: config.socketPath, method, params, timeoutMs: 10_000,
    maxLineBytes: config.rpcMaxLineBytes,
  });
  const health = await rpc('system.health', {});
  assert.equal(health.database.schemaVersion, migrations.at(-1).version);
  assert.equal(health.schemaVersion, migrations.at(-1).version);
  assert.equal(health.browser?.state, 'not_started');
  const clientId = 'isolated-installed-package-agent';
  const open = {
    clientId, requestId: 'package-open-once', projectKey: 'isolated-installed-smoke',
    displayName: 'Disposable installed candidate', provider: 'chatgpt',
    surfaceIntent: 'chat', modelIntent: 'Pro',
  };
  const project = await rpc('project.open', open);
  const replayedProject = await rpc('project.open', open);
  assert.equal(replayedProject.projectId, project.projectId);
  assert.equal(project.mainConversationSlotId, 'main');
  const start = {
    clientId, requestId: 'package-initial-once', projectId: project.projectId,
    expectedConversationRevision: project.conversationRevision,
    prompt: 'One local smoke fixture. No browser or provider POST is allowed.',
  };
  const first = await rpc('task.start', start);
  const replayedTask = await rpc('task.start', start);
  assert.equal(first.taskId, replayedTask.taskId);
  const unrelatedProjectInput = {
    clientId, requestId: 'package-unrelated-open',
    projectKey: 'package-unrelated-project',
    displayName: 'Unrelated package project',
    provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
  };
  const unrelated = await rpc('project.open', unrelatedProjectInput);
  const replacementInput = {
    clientId, requestId: 'installed-replacement-open',
    projectKey: 'installed-replacement-project',
    displayName: 'Isolated replaced provider binding',
    provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
  };
  const replacement = await rpc('project.open', replacementInput);
  core.semanticTaskRepository.replaceBinding({
    projectId: replacement.projectId, clientId, slotId: 'main',
    expectedRevision: 1, providerKey: 'chatgpt',
    providerConversationId: 'verified-fixture-replacement-only',
  });
  assert.equal((await rpc('project.open', replacementInput)).conversationRevision, 2,
    'Replacing a provider binding must advance its public revision');
  await assert.rejects(rpc('task.start', {
    ...start, projectId: unrelated.projectId,
    prompt: 'A different project must never share an original requestId',
  }), error => error?.data?.errorCode === 'idempotency_conflict',
  'A reused caller requestId cannot create a second Task or provider POST');
  assert.equal((await rpc('project.open', unrelatedProjectInput)).conversationRevision,
    1, 'Collision must not advance an unrelated Main conversation');
  const read = await rpc('task.get', { clientId, taskId: first.taskId, view: 'evidence' });
  assert.equal(read.taskId, first.taskId);
  assert.equal(read.submission.attempted, false);
  assert.equal(read.submission.acknowledged, false);
  assert.equal(read.evidence.attempts.length, 1);
  assert.equal(read.evidence.rootPost, null);
  const waited = await rpc('task.wait', {
    clientId, taskId: first.taskId, afterRevision: read.revision, waitMs: 0,
  });
  assert.equal(waited.taskId, read.taskId);
  assert.ok(waited.revision >= read.revision);
  assert.deepEqual(MCP_TOOLS.map(tool => tool.name).sort(), [
    'sessionplane_project_open', 'sessionplane_task_start',
    'sessionplane_task_get', 'sessionplane_task_wait',
    'sessionplane_task_decide', 'sessionplane_task_cancel',
  ].sort());
  const mcp = await invokeMcpTool({
    name: 'sessionplane_task_get', arguments: { clientId, taskId: first.taskId, view: 'evidence' },
    socketPath: config.socketPath, timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes,
  });
  assert.equal(mcp.isError, false);
  assert.equal(mcp.structuredContent.taskId, first.taskId);
  assert.equal(mcp.structuredContent.evidence.attempts.length, 1);
  const canceled = await rpc('task.cancel', {
    clientId, taskId: first.taskId, requestId: 'package-cancel-once',
  });
  assert.equal(canceled.state, 'canceled');
  assert.equal(canceled.cancelOutcome, 'not_submitted');
  const replayCancel = await rpc('task.cancel', {
    clientId, taskId: first.taskId, requestId: 'package-cancel-once',
  });
  assert.deepEqual(replayCancel, canceled);

  // An explicitly scoped role from an older kernel schema can have a valid
  // immutable slot binding but no new public revision metadata at all.
  // Preserve its provider binding revision across a real package restart.
  core.teamDirectory.createRole({
    teamId: project.projectId, roleKey: 'expert.legacy',
    roleType: 'expert', reportsToRoleKey: 'main',
  });
  core.semanticTaskRepository.openSlot({
    projectId: project.projectId, clientId,
    slotId: 'expert.legacy', roleKey: 'expert.legacy',
    providerKey: 'chatgpt',
  });
  core.semanticTaskRepository.replaceBinding({
    projectId: project.projectId, clientId,
    slotId: 'expert.legacy', expectedRevision: 1,
    providerKey: 'chatgpt',
    providerConversationId: 'test-historical-provider-conversation',
  });
  core.database.raw.prepare(
    'DELETE FROM kernel_public_slot_revisions WHERE project_id=? AND slot_id=?'
  ).run(project.projectId, 'expert.legacy');

  // Second logical slots are explicitly provisioned, not invented by
  // arbitrary clients. Their public revision is persisted independently
  // from the owner's Main conversation, including in the real tarball.
  core.teamDirectory.createRole({
    teamId: project.projectId, roleKey: 'reviewer', roleType: 'reviewer',
    displayName: 'Isolated installed reviewer', reportsToRoleKey: 'main',
  });
  core.semanticTaskRepository.openSlot({
    projectId: project.projectId, clientId,
    slotId: 'reviewer', roleKey: 'reviewer', providerKey: 'chatgpt',
  });
  const reviewerStart = {
    clientId, projectId: project.projectId, conversationSlotId: 'reviewer',
    expectedConversationRevision: 1, requestId: 'installed-second-slot-once',
    prompt: 'Independent reviewer Task, no real browser/provider effect',
  };
  const reviewer = await rpc('task.start', reviewerStart);
  assert.equal(reviewer.conversationSlotId, 'reviewer');
  assert.equal(reviewer.conversationRevision, 2);
  assert.equal(core.semanticTaskRepository.getConversationRevision(
    project.projectId, 'main', clientId), 2,
    'Reviewer Task cannot alter the Main public revision');
  await assert.rejects(rpc('task.start', {
    ...reviewerStart, requestId: 'invented-slot-id',
    conversationSlotId: 'not-opened',
  }), error => error?.data?.errorCode === 'invalid_request');

  // An installed package must really reopen its own durable SQLite
  // state and recover the exact same identities, rather than merely passing
  // while all caches and MCP processes are still resident.
  await core.close();
  core = undefined;
  core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  assert.equal(core.browserOwner, null);
  assert.equal(core.actorScheduler.actorCount, 0,
    'a restart must not hydrate dormant legacy session actors');
  const resumedHealth = await rpc('system.health', {});
  assert.equal(resumedHealth.schemaVersion, health.schemaVersion);
  assert.equal(resumedHealth.sourceCommit, health.sourceCommit);
  assert.equal(resumedHealth.sourceTree, health.sourceTree);
  assert.equal(resumedHealth.packageSha256, null,
    'External package provenance cannot be guessed by the embedded runtime');
  const resumed = await rpc('task.get', {
    clientId, taskId: first.taskId, view: 'evidence',
  });
  assert.equal(resumed.taskId, first.taskId);
  assert.equal(resumed.state, 'canceled');
  assert.equal(resumed.submission.attempted, false);
  assert.equal(resumed.evidence.attempts.length, 1,
    'Core restart cannot create a duplicate original prompt attempt');
  assert.equal((await rpc('project.open', open)).projectId, project.projectId);
  assert.equal((await rpc('task.start', start)).taskId, first.taskId);
  assert.deepEqual(await rpc('task.cancel', {
    clientId, taskId: first.taskId, requestId: 'package-cancel-once',
  }), canceled, 'Cancellation receipt must replay byte-for-byte after Core restart');
  const resumedMcp = await invokeMcpTool({
    name: 'sessionplane_task_get',
    arguments: { clientId, taskId: first.taskId, view: 'evidence' },
    socketPath: config.socketPath, timeoutMs: 10_000,
    maxLineBytes: config.rpcMaxLineBytes,
  });
  assert.equal(resumedMcp.isError, false);
  assert.equal(resumedMcp.structuredContent.taskId, first.taskId);
  assert.equal(resumedMcp.structuredContent.state, 'canceled');

  const historicalInput = {
    clientId, projectId: project.projectId,
    conversationSlotId: 'expert.legacy',
    expectedConversationRevision: 2,
    requestId: 'installed-historical-slot-once',
    prompt: 'One recovered explicitly owned historical role Task',
  };
  const historical = await rpc('task.start', historicalInput);
  assert.equal(historical.conversationSlotId, 'expert.legacy');
  assert.equal(historical.conversationRevision, 3);
  assert.equal(historical.submission.attempted, false);
  assert.equal((await rpc('task.start', historicalInput)).taskId, historical.taskId);
  assert.equal(core.semanticTaskRepository.getConversationRevision(
    project.projectId, 'expert.legacy', clientId), 3);
  assert.equal(core.semanticTaskRepository.getFullTask(
    historical.taskId, clientId).attempts.length, 1);

  const reviewerResumed = await rpc('task.get', {
    clientId, taskId: reviewer.taskId, view: 'evidence',
  });
  assert.equal(reviewerResumed.conversationSlotId, 'reviewer');
  assert.equal(reviewerResumed.state, 'working');
  assert.equal(reviewerResumed.submission.attempted, false);
  assert.equal(reviewerResumed.evidence.attempts.length, 1);
  assert.equal((await rpc('task.start', reviewerStart)).taskId, reviewer.taskId);
  assert.equal(core.semanticTaskRepository.getConversationRevision(
    project.projectId, 'main', clientId), 2);
  assert.equal(core.semanticTaskRepository.getConversationRevision(
    project.projectId, 'reviewer', clientId), 2);

  assert.equal((await rpc('project.open', replacementInput)).conversationRevision, 2);
  const replacedStart = {
    clientId, projectId: replacement.projectId,
    requestId: 'replaced-binding-new-task',
    expectedConversationRevision: 1,
    prompt: 'This stale revision must not send after a conversation switch',
  };
  await assert.rejects(rpc('task.start', replacedStart),
    error => error?.data?.errorCode === 'conversation_conflict');
  const rebound = await rpc('task.start', {
    ...replacedStart, expectedConversationRevision: 2,
  });
  assert.equal(rebound.conversationRevision, 3);
  assert.equal(rebound.submission.attempted, false);
  assert.equal(core.semanticTaskRepository.getFullTask(
    rebound.taskId, clientId).attempts.length, 1);

  const managed = await verifyInstalledContinuation(moduleAt, work);
  console.log(JSON.stringify({
    requestOk: true, gate: 'installed-core-public-task-smoke',
    schemaVersion: resumedHealth.schemaVersion, toolCount: MCP_TOOLS.length,
    sameTaskAcrossRpcAndMcp: true, originalProviderPosts: 0,
    cancelReceiptReplayed: true, isolatedBrowserStarted: false,
    installedCoreRestarted: true, requestIdentitySurvivedRestart: true,
    originalAttemptCountAfterRestart: resumed.evidence.attempts.length,
    secondSlotRevisionIndependentAfterRestart: true,
    historicalSlotRecoveredAfterRestart: true,
    crossProjectRequestCollisionRejected: true,
    staleBindingReplacementRejectedAfterRestart: true,
    noIdleLegacyActorsOnRestart: true,
    ...managed,
  }));
} finally {
  await core?.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}


/** Exercise the compiled, installed modules, never a TS unit-test import.
 * Both scenarios are clock-accelerated in disposable SQLite; no real provider
 * POST, Chrome, profile, or operational Core participates.
 */
async function verifyInstalledContinuation(moduleAt, work) {
  const [{ SessionPlaneDatabase }, { TaskKernelRepository },
    { DurableTaskKernel }, { ManagedContinuationService, CONTINUATION_INTERVAL_MS }] =
    await Promise.all([
      moduleAt('storage/database.js'),
      moduleAt('storage/task-kernel-repository.js'),
      moduleAt('core/durable-task-kernel.js'),
      moduleAt('core/managed-continuation.js'),
    ]);
  const db = SessionPlaneDatabase.open(path.join(work, 'compiled-continuation.sqlite'));
  let nowMs = Date.parse('2026-11-14T00:00:00.000Z');
  const clientId = 'compiled-fixture-agent';
  const store = new TaskKernelRepository(db, () => new Date(nowMs).toISOString());
  const pending = new Set(['initial:no-final', 'initial:rate-limited']);
  const rateLimited = new Set(['initial:rate-limited']);
  const ready = new Set();
  const sends = [];
  const provider = {
    providerKey: 'compiled-fixture',
    async preflight() { return { kind: 'ready' }; },
    async sendOnce(intent) {
      sends.push(intent);
      return { kind: 'verified_ack', externalTurnId: 'ack:' + intent.attemptId };
    },
    async recoverAck() { return { kind: 'unavailable', reason: 'fixture-no-recovery' }; },
    async observeFinal(query) {
      if (rateLimited.has(query.attemptId)) {
        return { kind: 'pending', reason: 'backend-http-429' };
      }
      if (pending.has(query.attemptId) ||
          (query.attemptId.startsWith('managed-continuation:') && !ready.has(query.attemptId))) {
        return { kind: 'pending', reason: 'backend-assistant-missing' };
      }
      return {
        kind: 'exact_final', externalTurnId: query.externalTurnId,
        answerText: 'Exact installed final for ' + query.attemptId,
      };
    },
  };
  const kernel = new DurableTaskKernel(store, [provider]);
  const service = new ManagedContinuationService({
    repository: store, kernel, now: () => new Date(nowMs),
  });
  const projectId = 'installed-continuation-project';
  try {
    store.openProject({
      projectId, projectKey: 'installed.continuation',
      displayName: 'No real browser package contract', clientId,
    });
    const prepare = async (name, slotId) => {
      const taskId = 'task:' + name;
      const attemptId = 'initial:' + name;
      store.openSlot({ projectId, slotId, roleKey: slotId,
        providerKey: provider.providerKey, clientId });
      store.startTask({ taskId, projectId, slotId, clientId,
        requestId: 'request:' + name, expectedSlotRevision: 1,
        prompt: 'Fixture question ' + name });
      store.observeConversation({ projectId, slotId, clientId, taskId,
        expectedRevision: 1, providerConversationId: 'conversation:' + name });
      store.planAttempt({ taskId, clientId, attemptId, kind: 'initial',
        turnKey: 'original', content: 'Fixture question ' + name });
      db.raw.prepare(
        'INSERT INTO kernel_public_task_policies' +
        '(task_id,policy_json,input_sha256,accepted_revision,created_at)' +
        ' VALUES(?,?,?,?,?)',
      ).run(taskId, JSON.stringify({
        enabled: true, approvalRef: 'explicit-compiled-fixture-approval',
        message: '계속', intervalMs: CONTINUATION_INTERVAL_MS,
      }), 'compiled-fixture-hash', 1, new Date(nowMs).toISOString());
      await kernel.dispatch(taskId, clientId, attemptId);
      service.activate({ taskId, clientId, sourceAttemptId: attemptId,
        approvalRef: 'explicit-compiled-fixture-approval', message: '계속' });
      return taskId;
    };
    const noFinal = await prepare('no-final', 'main');
    nowMs += CONTINUATION_INTERVAL_MS;
    assert.equal((await service.tick()).dispatchesAttempted, 1);
    assert.deepEqual(sends.filter(send => send.taskId === noFinal)
      .map(send => send.kind), ['initial', 'continuation'],
      'installed JS must submit exactly one Continue with no source FINAL');
    const continuationId = 'managed-continuation:initial:no-final';
    ready.add(continuationId);
    nowMs += 1_000;
    await service.tick();
    const completed = store.getFullTask(noFinal, clientId);
    assert.equal(completed.task.state, 'completed');
    assert.equal(completed.results[0].completesTask, true);
    assert.equal(completed.timers.filter(timer => timer.status === 'pending').length, 0);
    nowMs += 2 * CONTINUATION_INTERVAL_MS;
    await service.tick();
    assert.equal(sends.filter(send => send.taskId === noFinal).length, 2,
      'exact installed FINAL must revoke future Continue');

    const withFinal = await prepare('with-final', 'final');
    nowMs += CONTINUATION_INTERVAL_MS;
    assert.equal((await service.tick()).dispatchesAttempted, 0);
    assert.equal(store.getTask(withFinal, clientId).state, 'completed');
    assert.deepEqual(sends.filter(send => send.taskId === withFinal)
      .map(send => send.kind), ['initial'],
      'installed JS must never Continue after source FINAL');

    const rateTask = await prepare('rate-limited', 'rate');
    nowMs += CONTINUATION_INTERVAL_MS;
    assert.equal((await service.tick()).dispatchesAttempted, 0);
    assert.equal(store.getFullTask(rateTask, clientId).attempts.length, 1,
      'canonical 429 cannot authorize an installed Continue');
    rateLimited.delete('initial:rate-limited');
    nowMs += CONTINUATION_INTERVAL_MS;
    assert.equal((await service.tick()).dispatchesAttempted, 1);
    assert.deepEqual(sends.filter(send => send.taskId === rateTask)
      .map(send => send.kind), ['initial', 'continuation']);
    return {
      installedNoFinal20MinuteContinue: true,
      installedExactFinalStopsContinuation: true,
      installed429NeverLicensesContinue: true,
    };
  } finally {
    await service.close();
    db.close();
  }
}
