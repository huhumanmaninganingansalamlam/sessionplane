import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { MCP_MODERN_PROTOCOL_VERSION } from '../../src/mcp/schemas.ts';

interface JsonRpcResponse {
  readonly id: string | number | null;
  readonly result?: Readonly<Record<string, any>>;
  readonly error?: Readonly<Record<string, unknown>>;
}

class CaptureWritable extends Writable {
  value = '';

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

async function runCliJson(argv: readonly string[], input: readonly (string | Buffer)[] = []) {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const code = await runCli(argv, {
    stdin: Readable.from(input), stdout, stderr,
  });
  return { code, stdout: stdout.value.trim(), stderr: stderr.value.trim() };
}

class McpSubprocess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, {
    readonly resolve: (response: JsonRpcResponse) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  #nextId = 1;
  #buffer = '';
  #stderr = '';

  constructor(stateDir: string) {
    this.#child = spawn(process.execPath, [
      '--experimental-strip-types', path.resolve(process.cwd(), 'src/cli/main.ts'),
      'mcp', '--state-dir', stateDir,
    ], { cwd: process.cwd(), env: { ...process.env } });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stderr.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => this.#handleChunk(chunk));
    this.#child.stderr.on('data', (chunk: string) => { this.#stderr += chunk; });
    this.#child.once('exit', (code, signal) => {
      const error = new Error(
        `MCP subprocess exited before response (code=${String(code)}, signal=${String(signal)}): ${this.#stderr}`,
      );
      for (const [id, pending] of this.#pending) {
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(error);
      }
    });
  }

  request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const id = `request-${this.#nextId++}`;
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; stderr=${this.#stderr}`));
      }, 5_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown): void {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.#child.kill('SIGTERM'); resolve(); }, 2_000);
      this.#child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  #handleChunk(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line) as JsonRpcResponse;
      const pending = this.#pending.get(String(response.id));
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(String(response.id));
      pending.resolve(response);
    }
  }
}

function modernParams(
  params: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    ...params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'sessionplane-test', version: '1.0.0' },
    },
  };
}

test('CLI and modern/standard MCP expose one durable Task across MCP process restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cli-mcp-task-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const owner = 'cli-mcp-task-owner';
  const cli = async (...args: string[]) => await runCliJson([
    ...args, '--client-id', owner, '--state-dir', config.stateDir, '--json',
  ]);
  const subprocesses: McpSubprocess[] = [];
  try {
    const opened = await cli('project', 'open', '--key', 'cli-mcp-task',
      '--name', 'CLI MCP Task', '--request-id', 'open-cli-mcp-task');
    assert.equal(opened.code, 0, opened.stderr);
    const project = JSON.parse(opened.stdout);
    const started = await cli('task', 'start', project.projectId,
      '--expected-conversation-revision', String(project.conversationRevision),
      '--request-id', 'start-cli-mcp-task', '--prompt',
      'Retain this exact Task while MCP clients disconnect and reconnect.');
    assert.equal(started.code, 0, started.stderr);
    const task = JSON.parse(started.stdout);

    const cliRead = await cli('task', 'get', task.taskId, '--view', 'summary');
    assert.equal(cliRead.code, 0, cliRead.stderr);
    const exact = JSON.parse(cliRead.stdout);
    assert.equal(exact.taskId, task.taskId);
    assert.equal(exact.state, 'working');
    assert.equal(exact.submission.attempted, false);

    let modern = new McpSubprocess(config.stateDir);
    subprocesses.push(modern);
    const discover = await modern.request('server/discover', modernParams());
    assert.equal(discover.error, undefined);
    assert.equal(discover.result?.resultType, 'complete');
    const listed = await modern.request('tools/list', modernParams());
    assert.ok((listed.result?.tools as Array<{ name: string }>).some(tool =>
      tool.name === 'sessionplane_task_get'));
    const modernRead = await modern.request('tools/call', modernParams({
      name: 'sessionplane_task_get',
      arguments: { clientId: owner, taskId: task.taskId, view: 'summary' },
    }));
    assert.equal(modernRead.error, undefined);
    assert.deepEqual(modernRead.result?.structuredContent, exact);
    await modern.close();

    const afterExit = await callRpc<any>({
      socketPath: config.socketPath, method: 'task.get',
      params: { clientId: owner, taskId: task.taskId, view: 'summary' },
    });
    assert.deepEqual(afterExit, exact);
    assert.equal(core.semanticTaskRepository.getFullTask(task.taskId, owner).attempts.length, 1);

    modern = new McpSubprocess(config.stateDir);
    subprocesses.push(modern);
    const restartedRead = await modern.request('tools/call', modernParams({
      name: 'sessionplane_task_get',
      arguments: { clientId: owner, taskId: task.taskId, view: 'summary' },
    }));
    assert.deepEqual(restartedRead.result?.structuredContent, exact);
    await modern.close();

    for (const [requestedVersion, negotiatedVersion] of [
      ['2025-11-25', '2025-11-25'],
      ['2025-06-18', '2025-06-18'],
      ['2099-01-01', '2025-11-25'],
    ] as const) {
      const standard = new McpSubprocess(config.stateDir);
      subprocesses.push(standard);
      const initialized = await standard.request('initialize', {
        protocolVersion: requestedVersion, capabilities: {},
        clientInfo: { name: 'standard-test', version: '1.0.0' },
      });
      assert.equal(initialized.result?.protocolVersion, negotiatedVersion);
      standard.notify('notifications/initialized', {});
      const metadata = {
        'io.modelcontextprotocol/protocolVersion': negotiatedVersion,
        progressToken: 'standard-client',
      };
      const catalog = await standard.request('tools/list', { _meta: metadata });
      assert.ok((catalog.result?.tools as Array<{ name: string }>).some(tool =>
        tool.name === 'sessionplane_task_get'));
      const read = await standard.request('tools/call', {
        _meta: metadata, name: 'sessionplane_task_get',
        arguments: { clientId: owner, taskId: task.taskId, view: 'summary' },
      });
      assert.equal(read.result?.resultType, undefined);
      assert.deepEqual(read.result?.structuredContent, exact);
      await standard.close();
    }
    assert.equal(core.semanticTaskRepository.getFullTask(task.taskId, owner).attempts.length, 1,
      'MCP reconnect and protocol negotiation never create or replay an attempt');
  } finally {
    for (const process of subprocesses) await process.close();
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('current task.start file and stdin prompts preserve literal text and reject competing sources', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-task-prompt-input-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const owner = 'literal-task-client';
  const prompt = "Director's report: \"quoted\" `literal` $(literal)\n한국어 🧭\n";
  const filename = path.join(root, 'prompt.txt');
  writeFileSync(filename, prompt);
  try {
    for (const [index, source] of [
      ['--prompt-file', filename], ['--prompt-stdin'],
    ].entries()) {
      const project = await callRpc<any>({
        socketPath: config.socketPath, method: 'project.open', params: {
          clientId: owner, requestId: `literal-project-${index}`,
          projectKey: `literal-project-${index}`, displayName: `Literal ${index}`,
        },
      });
      const base = ['task', 'start', project.projectId,
        '--expected-conversation-revision', String(project.conversationRevision),
        '--client-id', owner, '--request-id', `literal-task-${index}`,
        '--state-dir', config.stateDir, '--json'];
      const conflict = await runCliJson([...base, '--prompt', 'conflict', ...source]);
      assert.equal(conflict.code, 2);
      assert.equal(core.semanticTaskRepository.getSlot(project.projectId, 'main', owner)
        .activeTaskId, null);
      const input = source[0] === '--prompt-stdin'
        ? Array.from(Buffer.from(prompt), byte => Buffer.from([byte])) : [];
      const started = await runCliJson([...base, ...source], input);
      assert.equal(started.code, 0, started.stderr);
      const task = JSON.parse(started.stdout);
      assert.equal(core.semanticTaskRepository.getFullTask(task.taskId, owner)
        .attempts[0]?.content, prompt);
      const replay = await runCliJson([...base, '--prompt', prompt]);
      assert.equal(replay.code, 0, replay.stderr);
      assert.equal(JSON.parse(replay.stdout).taskId, task.taskId);
      assert.equal(core.semanticTaskRepository.getFullTask(task.taskId, owner)
        .attempts.length, 1);
    }
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
