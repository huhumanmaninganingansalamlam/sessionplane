import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** One real Core and SQLite owner: four independent public project Tasks,
 * twenty concurrent revision waits, then Core restart and exact receipt
 * replay. No browser/provider is launched: an unacknowledged prompt may never
 * be sent by a disconnected test client.
 */
test('public Task restart preserves four independent Main leases and wakes 20 concurrent clients exactly once', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-public-reliability-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const clientId = 'reliability-public-client';
  let core: CoreService | null = null;
  const rpc = async <Result = any>(method: string, params: Record<string, unknown>) =>
    await callRpc<Result>({
      socketPath: config.socketPath,
      method, params, timeoutMs: 10_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });

  try {
    core = await startCore({ config, startBrowser: false, logger: silentLogger });
    assert.equal(core.browserOwner, null);
    const opens = Array.from({ length: 4 }, (_, index) => ({
      clientId, requestId: 'reliability-open-' + index,
      projectKey: 'durable-public-reliability-' + index,
      displayName: 'Disposable independent public project ' + index,
      provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
    }));
    const projects = await Promise.all(opens.map(open => rpc('project.open', open)));
    assert.equal(new Set(projects.map(p => p.projectId)).size, 4);
    assert.ok(projects.every(p => p.mainConversationSlotId === 'main'));
    assert.ok(projects.every(p => p.conversationRevision === 1));

    const requests = projects.map((project, index) => ({
      clientId, projectId: project.projectId,
      requestId: 'reliability-initial-' + index,
      expectedConversationRevision: project.conversationRevision,
      prompt: 'Exact independent test-only question ' + index,
    }));
    const [first, repeatedFirst, ...other] = await Promise.all([
      rpc('task.start', requests[0]!),
      rpc('task.start', requests[0]!),
      ...requests.slice(1).map(request => rpc('task.start', request)),
    ]);
    assert.deepEqual(repeatedFirst, first, 'Concurrent identical starts must share one receipt');
    const tasks = [first, ...other];
    assert.equal(tasks.length, 4);
    assert.equal(new Set(tasks.map(task => task.taskId)).size, 4);
    assert.deepEqual(tasks.map(task => task.projectId), projects.map(project => project.projectId));

    const originalSnapshots = await Promise.all(tasks.map(task =>
      rpc('task.get', { clientId, taskId: task.taskId, view: 'evidence' })));
    assert.ok(originalSnapshots.every(s => s.conversationSlotId === 'main'));
    assert.ok(originalSnapshots.every(s => !s.submission.attempted && !s.submission.acknowledged));
    assert.ok(originalSnapshots.every(s => !s.resultAvailable && s.evidence.attempts.length === 1));
    assert.ok(originalSnapshots.every(s => s.evidence.attempts[0].state === 'planned'));
    assert.ok(originalSnapshots.every(s => s.evidence.rootPost === null));
    assert.ok(originalSnapshots.every(s => s.evidence.conversation.providerConversationId === null));

    // A public Task wait is only a bounded read; it has no collector/timer
    // authority. One durable cancellation wakes all twenty waiters without
    // a duplicate original attempt or cross-project completion.
    const firstTask = tasks[0]!;
    const revision = originalSnapshots[0]!.revision;
    const waits = Array.from({ length: 20 }, () =>
      rpc('task.wait', {
        clientId, taskId: firstTask.taskId,
        afterRevision: revision, waitMs: 4_000,
      }));
    await new Promise(resolve => setTimeout(resolve, 40));
    const canceled = await rpc('task.cancel', {
      clientId, taskId: firstTask.taskId, requestId: 'reliability-cancel-once',
    });
    assert.equal(canceled.state, 'canceled');
    assert.equal(canceled.cancelOutcome, 'not_submitted');
    const wake = await Promise.all(waits);
    assert.equal(wake.length, 20);
    assert.ok(wake.every(s => s.taskId === firstTask.taskId));
    assert.ok(wake.every(s => s.state === 'canceled'));
    assert.ok(wake.every(s => s.revision > revision));
    assert.ok(wake.every(s => !s.submission.attempted));

    for (const task of tasks.slice(1)) {
      const independent = await rpc('task.get', {
        clientId, taskId: task.taskId, view: 'evidence',
      });
      assert.notEqual(independent.state, 'canceled', 'Another Main Task cannot be canceled by a foreign wait');
      assert.notEqual(independent.state, 'completed', 'No provider final was ever returned');
      assert.equal(independent.evidence.attempts.length, 1);
      assert.equal(independent.submission.attempted, false);
    }
    await core.close();
    core = null;

    // No cached client/server object survives this boundary. The old database,
    // idempotency receipts and Task evidence are read from a newly opened Core.
    core = await startCore({ config, startBrowser: false, logger: silentLogger });
    assert.equal(core.browserOwner, null);
    const reopenedHealth = await rpc('system.health', {});
    assert.equal(reopenedHealth.database.readable, true);
    assert.equal(reopenedHealth.database.schemaVersion, core.database.schemaVersion);
    const reopenedProjects = await Promise.all(opens.map(open => rpc('project.open', open)));
    assert.deepEqual(reopenedProjects.map(project => project.projectId),
      projects.map(project => project.projectId));
    const reopenedTasks = await Promise.all(requests.map(request =>
      rpc('task.start', request)));
    assert.deepEqual(reopenedTasks.map(task => task.taskId), tasks.map(task => task.taskId));
    assert.deepEqual(await rpc('task.cancel', {
      clientId, taskId: firstTask.taskId, requestId: 'reliability-cancel-once',
    }), canceled, 'Cancel receipt must be exact after Core restart');

    const afterRestart = await Promise.all(tasks.map(task =>
      rpc('task.get', { clientId, taskId: task.taskId, view: 'evidence' })));
    assert.equal(afterRestart[0]!.state, 'canceled');
    for (const result of afterRestart) {
      assert.equal(result.evidence.attempts.length, 1,
        'Restart and concurrent wait may never create a second original POST');
      assert.equal(result.evidence.rootPost, null);
      assert.equal(result.submission.attempted, false);
      assert.equal(result.resultAvailable, false);
    }

    const mcp = await invokeMcpTool({
      name: 'sessionplane_task_get',
      arguments: { clientId, taskId: firstTask.taskId, view: 'evidence' },
      socketPath: config.socketPath, timeoutMs: 10_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    assert.equal(mcp.isError, false);
    assert.deepEqual(mcp.structuredContent, afterRestart[0],
      'Restarted MCP must use the same durable Task as the CLI and RPC');
    const health = await rpc('system.health', {});
    for (const field of ['duplicate_submit_total', 'focus_switch_total',
      'wrong_session_total', 'wrong_generation_total']) {
      assert.equal(health.metrics[field], 0, field + ' must remain zero');
    }
    assert.equal(health.metrics.wait_subscriber_count, 0);
    assert.equal(core.database.raw.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  } finally {
    await core?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
