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

  console.log(JSON.stringify({
    requestOk: true, gate: 'installed-core-public-task-smoke',
    schemaVersion: resumedHealth.schemaVersion, toolCount: MCP_TOOLS.length,
    sameTaskAcrossRpcAndMcp: true, originalProviderPosts: 0,
    cancelReceiptReplayed: true, isolatedBrowserStarted: false,
    installedCoreRestarted: true, requestIdentitySurvivedRestart: true,
    originalAttemptCountAfterRestart: resumed.evidence.attempts.length,
  }));
} finally {
  await core?.close().catch(() => undefined);
  rmSync(work, { recursive: true, force: true });
}
