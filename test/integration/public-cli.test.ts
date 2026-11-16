import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { runCli } from '../../src/cli/main.ts';
import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { runMcpServer } from '../../src/mcp/server.ts';
import { MCP_MODERN_PROTOCOL_VERSION } from '../../src/mcp/schemas.ts';
import { invokeMcpTool, PROJECT_MCP_TOOL, TASK_MCP_TOOLS } from '../../src/mcp/tools.ts';

function capture() {
  let stdout = '', stderr = '';
  return {
    io: {
      stdin: Readable.from([]),
      stdout: new Writable({ write(chunk, _encoding, next) {
        stdout += String(chunk); next();
      } }),
      stderr: new Writable({ write(chunk, _encoding, next) {
        stderr += String(chunk); next();
      } }),
    },
    output: () => ({ stdout, stderr }),
  };
}

test('new public CLI and MCP share one durable project/task contract without owning a browser or wait loop', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-public-cli-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const owner = 'public-cli-fixture';
  const cli = async (...args: string[]) => {
    const captureResult = capture();
    const code = await runCli([...args, '--socket', config.socketPath,
      '--client-id', owner, '--json'], captureResult.io);
    return { code, ...captureResult.output() };
  };
  try {
    const opened = await cli('project', 'open', '--key', 'public-cli-core',
      '--name', 'CLI public project', '--model', 'Pro', '--request-id', 'open-exact-project');
    assert.equal(opened.code, 0, opened.stderr);
    const project = JSON.parse(opened.stdout);
    assert.equal(project.modelIntent, 'Pro');
    assert.ok(project.projectId);
    assert.ok(project.mainConversationSlotId);
    const openingReplay = await cli('project', 'open', '--key', 'public-cli-core',
      '--name', 'CLI public project', '--model', 'Pro', '--request-id', 'open-exact-project');
    assert.equal(openingReplay.code, 0);
    assert.deepEqual(JSON.parse(openingReplay.stdout), project);

    const prompt = 'Prompt from a retained file.\nKeep the exact new line.';
    const promptFile = path.join(root, 'prompt.txt');
    writeFileSync(promptFile, prompt);
    const startArgs = ['task', 'start', project.projectId,
      '--expected-conversation-revision', String(project.conversationRevision),
      '--prompt-file', promptFile, '--request-id', 'start-exact-question'];
    const started = await cli(...startArgs);
    assert.equal(started.code, 0, started.stderr);
    const task = JSON.parse(started.stdout);
    assert.equal(task.taskId?.length > 0, true);
    assert.equal(core.semanticTaskRepository.getFullTask(task.taskId, owner)
      .attempts[0]?.content, prompt, 'CLI passes unchanged bytes into one durable initial attempt');
    const replay = await cli(...startArgs);
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).taskId, task.taskId);

    const get = await cli('task', 'get', task.taskId, '--view', 'summary');
    assert.equal(get.code, 0, get.stderr);
    const summary = JSON.parse(get.stdout);
    assert.equal(summary.state, 'working');
    assert.equal(summary.submission.attempted, false);
    const mcp = await invokeMcpTool({
      name: 'sessionplane_task_get',
      arguments: { clientId: owner, taskId: task.taskId, view: 'summary' },
      socketPath: config.socketPath, timeoutMs: 15_000, maxLineBytes: 2_000_000,
    });
    assert.equal(mcp.isError, false);
    assert.deepEqual(mcp.structuredContent, summary);

    const waited = await cli('task', 'wait', task.taskId,
      '--after-revision', String(summary.revision), '--wait-ms', '0', '--until-change');
    assert.equal(waited.code, 0, waited.stderr);
    assert.equal(JSON.parse(waited.stdout).revision, summary.revision);
    assert.equal(core.semanticTaskRepository.getFullTask(task.taskId, owner)
      .attempts[0]?.state, 'planned', 'bounded client exit does not drive or abandon execution');

    const canceled = await cli('task', 'cancel', task.taskId, '--request-id', 'cancel-without-send');
    assert.equal(canceled.code, 0, canceled.stderr);
    assert.equal(JSON.parse(canceled.stdout).cancelOutcome, 'not_submitted');
    assert.equal(core.semanticTaskRepository.getTask(task.taskId, owner).state, 'canceled');
    assert.equal(core.semanticTaskRepository.getFullTask(task.taskId, owner).attempts.length, 1);

    const publicTools = [PROJECT_MCP_TOOL, ...TASK_MCP_TOOLS];
    assert.deepEqual(publicTools.map(item => item.name).sort(), [
      'sessionplane_project_open', 'sessionplane_task_cancel',
      'sessionplane_task_decide', 'sessionplane_task_get',
      'sessionplane_task_start', 'sessionplane_task_wait',
    ].sort());
    for (const tool of publicTools) {
      assert.ok(tool.description.length < 600);
      assert.doesNotMatch(JSON.stringify(tool.inputSchema),
        /"selector"|"script"|"roleRef"|"requestRef"|"generation"/);
    }
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('public CLI rejects ambiguous prompts and unauthorized flags before any RPC', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-public-cli-params-'));
  const socketPath = path.join(root, 'fixture.sock');
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const { id, method, params } = JSON.parse(buffer.split('\n')[0]!);
      requests.push({ method, params });
      socket.end(JSON.stringify({ jsonrpc: '2.0', id, result: { requestOk: true } }) + '\n');
    });
  });
  const taskId = '00000000-0000-4000-8000-000000000011';
  const decisionId = '00000000-0000-4000-8000-000000000022';
  const grantsFile = path.join(root, 'permission-grants.json');
  writeFileSync(grantsFile, JSON.stringify([{
    appName: 'hostspan-git', toolName: 'repository_read', allowMode: 'once',
  }]));
  const decisionInputFile = path.join(root, 'decision-input.txt');
  writeFileSync(decisionInputFile, 'Exact long-form decision input from file');
  const validStart = ['task', 'start', taskId,
    '--expected-conversation-revision', '1', '--request-id', 'safe-send'];
  const cli = async (...args: string[]) => {
    const target = capture();
    const code = await runCli([...args, '--socket', socketPath, '--json'], target.io);
    return { code, ...target.output() };
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(socketPath, resolve);
    });
    for (const args of [
      [...validStart, '--prompt', 'one', '--prompt-file', path.join(root, 'other.txt')],
      [...validStart, '--prompt', 'one', '--selector', '#send'],
      [...validStart, '--prompt', 'one', '--model', 'Default'],
      [...validStart, '--prompt', 'one', '--public'],
      [...validStart, '--prompt', 'one', '--continuation-approved'],
      [...validStart, '--prompt', 'one', '--approval-ref', 'not-approved'],
      [...validStart, '--prompt', 'one', '--agent-review-after-ms', '2400000'],
      [...validStart, '--prompt', 'one', '--agent-permissions-file', path.join(root, 'missing.json')],
      ['task', 'get', taskId, '--view', 'decision'],
      ['task', 'get', taskId, '--view', 'summary', '--decision-id', decisionId],
      ['task', 'decide', taskId, decisionId, 'a1', '--input', 'x',
        '--input-file', decisionInputFile, '--request-id', 'ambiguous-input'],
      ['task', 'decide', taskId, decisionId, 'a1', '--input', 'choose without requestId'],
      ['task', 'wait', taskId, '--wait-ms', '0'],
      ['project', 'open', '--key', 'k', '--name', 'Project'],
    ]) {
      const response = await cli(...args);
      assert.equal(response.code, 2, JSON.stringify(args) + response.stderr);
      assert.equal(JSON.parse(response.stderr).requestOk, false);
    }
    assert.equal(requests.length, 0, 'invalid public CLI inputs must not invoke Core');

    const decision = await cli('task', 'decide', taskId, decisionId, 'opaque-action',
      '--request-id', 'decision-once', '--input', 'exact answer');
    assert.equal(decision.code, 0, decision.stderr);
    assert.deepEqual(requests[0], {
      method: 'task.decide',
      params: {
        clientId: 'sessplane-cli', taskId, decisionId,
        actionRef: 'opaque-action', requestId: 'decision-once',
        input: 'exact answer',
      },
    });
    const fileDecision = await cli('task', 'decide', taskId, decisionId, 'paged-action',
      '--request-id', 'decision-from-file', '--input-file', decisionInputFile);
    assert.equal(fileDecision.code, 0, fileDecision.stderr);
    assert.deepEqual(requests[1], {
      method: 'task.decide',
      params: {
        clientId: 'sessplane-cli', taskId, decisionId,
        actionRef: 'paged-action', requestId: 'decision-from-file',
        input: 'Exact long-form decision input from file',
      },
    });

    const evidence = await cli('task', 'get', taskId, '--view', 'decision',
      '--decision-id', decisionId, '--section', 'provider_question',
      '--cursor', '1024', '--max-bytes', '4096');
    assert.equal(evidence.code, 0, evidence.stderr);
    assert.deepEqual(requests[2], {
      method: 'task.get',
      params: {
        clientId: 'sessplane-cli', taskId, view: 'decision', decisionId,
        section: 'provider_question', cursor: 1024, maxBytes: 4096,
      },
    });

    const started = await cli(...validStart, '--prompt', 'one',
      '--continuation-approved', '--approval-ref', 'user-approved',
      '--agent-review-after-ms', '7200000',
      '--agent-permissions-file', grantsFile);
    assert.equal(started.code, 0, started.stderr);
    assert.deepEqual(requests[3], {
      method: 'task.start',
      params: {
        clientId: 'sessplane-cli', requestId: 'safe-send', projectId: taskId,
        expectedConversationRevision: 1, prompt: 'one',
        continuationPolicy: {
          enabled: true, intervalMs: 1_200_000, message: '계속',
          approvalRef: 'user-approved', agentReviewAfterMs: 7_200_000,
        },
        agentPermissionGrants: [{
          appName: 'hostspan-git', toolName: 'repository_read', allowMode: 'once',
        }],
      },
    });

    const wait = await cli('task', 'wait', taskId, '--after-revision', '0', '--wait-ms', '0');
    assert.equal(wait.code, 0, wait.stderr);
    assert.deepEqual(requests[4], {
      method: 'task.wait',
      params: { clientId: 'sessplane-cli', taskId, afterRevision: 0, waitMs: 0, view: 'summary' },
    });
    assert.equal(requests.length, 5, 'public CLI performs one RPC per command');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('modern MCP client exit and reconnect cannot cancel or replay a durable public task', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-public-mcp-reconnect-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const owner = 'mcp-public-reconnect';
  const meta = {
    'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  const rpcMcp = async (method: string, params: Record<string, unknown>) => {
    const output = capture();
    const input = Readable.from([JSON.stringify({
      jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: meta },
    }) + '\n']);
    await runMcpServer({ config, input, output: output.io.stdout, error: output.io.stderr });
    const lines = output.output().stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]!);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  };
  try {
    const listed = await rpcMcp('tools/list', {});
    const names = listed.tools.map((tool: { name: string }) => tool.name);
    for (const tool of [PROJECT_MCP_TOOL, ...TASK_MCP_TOOLS]) {
      assert.ok(names.includes(tool.name));
    }
    const open = await rpcMcp('tools/call', { name: 'sessionplane_project_open',
      arguments: {
        clientId: owner, requestId: 'open-mcp-once',
        projectKey: 'mcp-reconnect', displayName: 'MCP process reconnect',
        provider: 'chatgpt', surfaceIntent: 'chat',
      } });
    assert.equal(open.isError, false);
    const project = open.structuredContent;
    assert.equal(project.modelIntent, 'Pro');

    const args = {
      clientId: owner, requestId: 'start-mcp-once',
      projectId: project.projectId,
      expectedConversationRevision: project.conversationRevision,
      prompt: 'One immutable MCP prompt despite process exit',
    };
    const started = await rpcMcp('tools/call', {
      name: 'sessionplane_task_start', arguments: args,
    });
    assert.equal(started.isError, false);
    const taskId: string = started.structuredContent.taskId;
    assert.equal(core.semanticTaskRepository.getFullTask(taskId, owner)
      .attempts[0]!.state, 'planned');

    const replay = await rpcMcp('tools/call', {
      name: 'sessionplane_task_start', arguments: args,
    });
    assert.equal(replay.structuredContent.taskId, taskId);
    assert.equal(core.semanticTaskRepository.getFullTask(taskId, owner)
      .attempts.length, 1);
    const current = await rpcMcp('tools/call', {
      name: 'sessionplane_task_get', arguments: { clientId: owner, taskId },
    });
    assert.equal(current.structuredContent.state, 'working');
    const terminal = await rpcMcp('tools/call', {
      name: 'sessionplane_task_cancel',
      arguments: { clientId: owner, taskId, requestId: 'cancel-mcp-once' },
    });
    assert.equal(terminal.structuredContent.state, 'canceled');
    assert.equal(core.semanticTaskRepository.getFullTask(taskId, owner)
      .attempts.length, 1);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('SQLite cancellation receipt survives Core process restart and blocks foreign task reuse', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cancel-receipt-restart-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  let core = await startCore({ config, startBrowser: false, logger });
  const owner = 'cancel-receipt-restart';
  const rpc = async (method: string, params: Record<string, unknown>) =>
    await callRpc<any>({ socketPath: config.socketPath, method, params });
  try {
    const project = await rpc('project.open', {
      clientId: owner, requestId: 'open-for-cancel',
      projectKey: 'cancel-receipt-restart', displayName: 'Cancellation persistence',
    });
    const started = await rpc('task.start', {
      clientId: owner, requestId: 'one-task-for-cancel',
      projectId: project.projectId,
      expectedConversationRevision: project.conversationRevision,
      prompt: 'Cancel this work before provider submission',
    });
    const identity = { clientId: owner, taskId: started.taskId, requestId: 'cancel-original' };
    const first = await rpc('task.cancel', identity);
    assert.equal(first.state, 'canceled');
    assert.equal(first.cancelOutcome, 'not_submitted');

    await core.close();
    core = await startCore({ config, startBrowser: false, logger });
    assert.deepEqual(await rpc('task.cancel', identity), first);
    assert.equal(core.semanticTaskRepository.getFullTask(started.taskId, owner)
      .events.filter((event: { event: { type: string } }) =>
        event.event.type === 'cancel.requested').length, 1);

    const other = await rpc('project.open', {
      clientId: owner, requestId: 'other-project-open',
      projectKey: 'cancel-other-project', displayName: 'Separate project',
    });
    const otherTask = await rpc('task.start', {
      clientId: owner, requestId: 'other-start',
      projectId: other.projectId,
      expectedConversationRevision: other.conversationRevision,
      prompt: 'This must remain independent',
    });
    await assert.rejects(rpc('task.cancel', {
      clientId: owner, taskId: otherTask.taskId, requestId: 'cancel-original',
    }), (error: any) => {
      assert.equal(error.data?.errorCode, 'idempotency_conflict');
      return true;
    });
    assert.equal(core.semanticTaskRepository.getTask(otherTask.taskId, owner).state, 'working');
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('default MCP advertises only six task tools and rejects retired workflow tools', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-public-mcp-catalog-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const metadata = {
    'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
  };
  let id = 1;
  const request = async (method: string,
    params: Record<string, unknown>) => {
    const output = capture();
    const message = { jsonrpc: '2.0', id: id++, method,
      params: { ...params, _meta: metadata } };
    const io = { ...output.io, stdin: Readable.from([JSON.stringify(message) + '\n']) };
    const code = await runCli(['mcp', '--socket', config.socketPath], io);
    assert.equal(code, 0, output.output().stderr);
    const lines = output.output().stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    return JSON.parse(lines[0]!);
  };
  try {
    const discover = await request('server/discover', {});
    assert.equal(discover.error, undefined);
    assert.match(discover.result.instructions, /task\.start/);
    assert.doesNotMatch(discover.result.instructions, /roleRef|requestRef|workflow\.decide/);

    const catalog = await request('tools/list', {});
    assert.equal(catalog.error, undefined);
    const names: string[] = catalog.result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(names.sort(), [
      'sessionplane_project_open', 'sessionplane_task_start',
      'sessionplane_task_get', 'sessionplane_task_wait',
      'sessionplane_task_decide', 'sessionplane_task_cancel',
    ].sort());
    const forbidden = await request('tools/call', {
      name: 'sessionplane_team_delete',
      arguments: { teamId: 'foreign', requestId: 'never-dispatch' },
    });
    assert.equal(forbidden.error.code, -32602);
    assert.equal(core.teamDirectory.listTeams('sessionplane-mcp').teams.length, 0);

    const opened = await request('tools/call', {
      name: 'sessionplane_project_open',
      arguments: {
        clientId: 'public-only-caller',
        requestId: 'open-public-only',
        projectKey: 'opt-in-public-mcp', displayName: 'Isolated MCP',
      },
    });
    assert.equal(opened.error, undefined);
    assert.equal(opened.result.structuredContent.modelIntent, 'Pro');
    const replay = await request('tools/call', {
      name: 'sessionplane_project_open',
      arguments: {
        clientId: 'public-only-caller',
        requestId: 'open-public-only',
        projectKey: 'opt-in-public-mcp', displayName: 'Isolated MCP',
      },
    });
    assert.equal(replay.result.structuredContent.projectId,
      opened.result.structuredContent.projectId);

    const afterReplay = await request('tools/list', {});
    assert.deepEqual(afterReplay.result.tools.map((tool: { name: string }) => tool.name).sort(),
      names, 'reconnect never advertises retired tools');
    for (const legacy of [
      'workflow.team_get', 'workflow.send', 'session.create', 'team.create',
      'send', 'stop', 'artifact.list', 'browser.runtime.reset',
    ]) {
      await assert.rejects(callRpc({
        socketPath: config.socketPath, method: legacy, params: {},
      }), (error: any) => {
        assert.equal(error.code, -32601, legacy + ' must be unregistered from Core');
        return true;
      });
    }
    for (const command of ['team', 'request', 'role', 'session', 'send',
      'wait', 'stop', 'status', 'events', 'artifact', 'browser-reset']) {
      const out = capture();
      const code = await runCli([command, '--socket', config.socketPath, '--json'], out.io);
      assert.equal(code, 2, command + ' remains a public CLI command');
      assert.equal(JSON.parse(out.output().stderr).requestOk, false);
    }
    const optIn = capture();
    assert.equal(await runCli(['mcp', '--public', '--socket', config.socketPath,
      '--json'], optIn.io), 2);
    assert.match(optIn.output().stderr, /Unknown option/);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
