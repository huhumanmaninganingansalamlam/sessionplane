import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import {
  getMcpTool, invokeMcpTool, MCP_TOOLS, McpToolNotFoundError,
} from '../../src/mcp/tools.ts';

const expected = [
  'sessionplane_project_open',
  'sessionplane_task_start',
  'sessionplane_task_get',
  'sessionplane_task_wait',
  'sessionplane_task_decide',
  'sessionplane_task_cancel',
];

test('published MCP catalog contains six source-schema tools, no legacy selectors or request refs', () => {
  assert.deepEqual(MCP_TOOLS.map(tool => tool.name).sort(), expected.sort());
  for (const tool of MCP_TOOLS) {
    assert.equal(tool.rpcMethod, tool.name.replace('sessionplane_', '').replace('_', '.'));
    assert.ok(tool.description.length < 450, tool.name);
    assert.ok(JSON.stringify(tool.inputSchema).length < 5500, tool.name);
    assert.doesNotMatch(JSON.stringify(tool.inputSchema),
      /"selector"|"script"|"roleRef"|"requestRef"|"generation"|"collector"/);
    assert.equal(tool.annotations.openWorldHint, false);
    assert.equal(getMcpTool(tool.name), tool);
  }
  assert.equal(getMcpTool('sessionplane_team_get'), null);
  assert.equal(getMcpTool('sessionplane_send'), null);
  assert.equal(getMcpTool('sessionplane_decide'), null);
  assert.equal(MCP_TOOLS.find(t => t.name === 'sessionplane_task_get')!.annotations.readOnlyHint, true);
  assert.equal(MCP_TOOLS.find(t => t.name === 'sessionplane_task_wait')!.annotations.readOnlyHint, true);
  assert.equal(MCP_TOOLS.find(t => t.name === 'sessionplane_task_cancel')!.annotations.destructiveHint, true);
});

test('MCP refuses unregistered legacy mutation before opening a socket', async () => {
  await assert.rejects(invokeMcpTool({
    name: 'sessionplane_send',
    arguments: { prompt: 'unauthorized' },
    socketPath: '/missing-public-core.sock', timeoutMs: 200, maxLineBytes: 4096,
  }), McpToolNotFoundError);
});

test('MCP cannot classify disconnected or unacknowledged provider mutation as success', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-public-mcp-transport-'));
  try {
    for (const mode of ['missing', 'closed', 'timeout'] as const) {
      const socketPath = path.join(root, mode + '.sock');
      const sockets = new Set<net.Socket>();
      const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('data', () => { if (mode === 'closed') socket.end(); });
      });
      try {
        if (mode !== 'missing') {
          await new Promise<void>(resolve => server.listen(socketPath, resolve));
        }
        const result = await invokeMcpTool({
          name: 'sessionplane_task_start',
          arguments: { clientId: 'agent', projectId: 'f'.repeat(36),
            requestId: 'one-request', expectedConversationRevision: 1,
            prompt: 'Do not resend when unacknowledged' },
          socketPath, timeoutMs: mode === 'timeout' ? 200 : 5000, maxLineBytes: 4096,
        });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent.errorCode, {
          missing: 'core.unavailable', closed: 'core.connection-lost',
          timeout: 'core.timeout',
        }[mode]);
        assert.equal((result.structuredContent.details as { requestDispatched: boolean })
          .requestDispatched, mode !== 'missing');
        assert.equal(result.structuredContent.state, undefined,
          'transport failure cannot be fabricated into a durable Task state');
      } finally {
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>(resolve => server.close(resolve));
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('MCP direct project/task calls share the same Core and never schedule a client loop', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-mcp-task-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const call = async (name: string, args: Record<string, unknown>) =>
    await invokeMcpTool({
      name, arguments: args, socketPath: config.socketPath,
      timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes,
    });
  const clientId = 'mcp-only-agent';
  try {
    const project = (await call('sessionplane_project_open', {
      clientId, requestId: 'open', projectKey: 'mcp-exact',
      displayName: 'Exact MCP state', modelIntent: 'Pro',
    })).structuredContent;
    const args = { clientId, requestId: 'start', projectId: project.projectId,
      expectedConversationRevision: project.conversationRevision,
      prompt: 'Exactly one task from MCP' };
    const first = await call('sessionplane_task_start', args);
    const replay = await call('sessionplane_task_start', args);
    assert.equal(first.isError, false);
    assert.equal(first.structuredContent.taskId, replay.structuredContent.taskId);
    const taskId = String(first.structuredContent.taskId);
    assert.equal(core.semanticTaskRepository.tasks.readTaskAggregate(taskId, clientId).attempts.length, 1);
    const read = await call('sessionplane_task_get', { clientId, taskId });
    assert.equal(read.structuredContent.state, 'working');
    assert.equal((read.structuredContent.submission as { attempted: boolean }).attempted, false);
    const wait = await call('sessionplane_task_wait', {
      clientId, taskId, afterRevision: read.structuredContent.revision, waitMs: 0,
    });
    assert.equal(wait.structuredContent.revision, read.structuredContent.revision);
    assert.equal(core.semanticTaskRepository.tasks.readTaskAggregate(taskId, clientId).attempts.length, 1);
    const cancel = await call('sessionplane_task_cancel', {
      clientId, taskId, requestId: 'cancel-once',
    });
    assert.equal(cancel.structuredContent.state, 'canceled');
    assert.equal(core.semanticTaskRepository.tasks.readTaskAggregate(taskId, clientId).attempts.length, 1);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
