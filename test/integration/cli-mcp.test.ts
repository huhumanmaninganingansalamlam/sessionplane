import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_MODERN_PROTOCOL_VERSION,
} from '../../src/mcp/schemas.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface JsonRpcResponse {
  readonly id: string | number | null;
  readonly result?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<Record<string, unknown>>;
}

test('CLI and modern/legacy MCP expose the same core state across MCP process restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cli-mcp-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });

  let modern: McpSubprocess | null = null;
  let restarted: McpSubprocess | null = null;
  let legacy: McpSubprocess | null = null;
  try {
    const teamRun = await runCliJson([
      'team',
      'create',
      '--name',
      'CLI MCP Team',
      '--client-id',
      'cli-mcp-client',
      '--request-id',
      'cli-team-create',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(teamRun.code, 0, teamRun.stderr);
    const team = JSON.parse(teamRun.stdout) as TeamSnapshot;

    const sessionRun = await runCliJson([
      'session',
      'create',
      team.teamId,
      'main',
      '--provider',
      'chatgpt',
      '--client-id',
      'cli-mcp-client',
      '--request-id',
      'cli-session-create',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(sessionRun.code, 0, sessionRun.stderr);
    const created = JSON.parse(sessionRun.stdout) as SessionSnapshot;

    const sendRun = await runCliJson([
      'send',
      '--session',
      created.sessionId,
      '--prompt',
      'Return durable state through every adapter.',
      '--client-id',
      'cli-mcp-client',
      '--request-id',
      'cli-send-1',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(sendRun.code, 0, sendRun.stderr);
    const submitted = JSON.parse(sendRun.stdout) as SessionSnapshot;
    assert.equal(submitted.sessionId, created.sessionId);

    const cliStatus = await runCliJson([
      'status',
      '--session',
      created.sessionId,
      '--client-id',
      'cli-mcp-client',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(cliStatus.code, 0, cliStatus.stderr);
    const cliSnapshot = JSON.parse(cliStatus.stdout) as SessionSnapshot;
    const directSnapshot = await callRpc<SessionSnapshot>({
      socketPath: config.socketPath,
      method: 'session.get',
      params: { clientId: 'cli-mcp-client', sessionId: created.sessionId },
    });
    assert.deepEqual(cliSnapshot, directSnapshot);

    modern = new McpSubprocess(config.stateDir);
    const discover = await modern.request('server/discover', modernParams());
    assert.equal(discover.error, undefined);
    assert.equal(discover.result?.resultType, 'complete');
    assert.ok(
      (discover.result?.supportedVersions as unknown[]).includes(MCP_MODERN_PROTOCOL_VERSION),
    );

    const list = await modern.request('tools/list', modernParams());
    assert.equal(list.error, undefined);
    assert.equal(list.result?.resultType, 'complete');
    assert.ok(
      (list.result?.tools as Array<{ name: string }>).some(
        (tool) => tool.name === 'sessionplane_status',
      ),
    );

    const modernStatus = await modern.request(
      'tools/call',
      modernParams({
        name: 'sessionplane_status',
        arguments: {
          clientId: 'cli-mcp-client',
          sessionId: created.sessionId,
        },
      }),
    );
    assert.equal(modernStatus.error, undefined);
    assert.deepEqual(modernStatus.result?.structuredContent, directSnapshot);
    assert.equal(modernStatus.result?.isError, false);

    await modern.close();
    modern = null;
    const afterMcpExit = await callRpc<SessionSnapshot>({
      socketPath: config.socketPath,
      method: 'session.get',
      params: { clientId: 'cli-mcp-client', sessionId: created.sessionId },
    });
    assert.equal(afterMcpExit.sessionId, created.sessionId);

    restarted = new McpSubprocess(config.stateDir);
    const restartedStatus = await restarted.request(
      'tools/call',
      modernParams({
        name: 'sessionplane_status',
        arguments: {
          clientId: 'cli-mcp-client',
          sessionId: created.sessionId,
        },
      }),
    );
    assert.deepEqual(restartedStatus.result?.structuredContent, afterMcpExit);

    legacy = new McpSubprocess(config.stateDir);
    const initialized = await legacy.request('initialize', {
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'legacy-test', version: '1.0.0' },
    });
    assert.equal(initialized.result?.protocolVersion, MCP_LEGACY_PROTOCOL_VERSION);
    legacy.notify('notifications/initialized', {});
    const legacyStatus = await legacy.request('tools/call', {
      name: 'sessionplane_status',
      arguments: {
        clientId: 'cli-mcp-client',
        sessionId: created.sessionId,
      },
    });
    assert.equal(legacyStatus.result?.resultType, undefined);
    assert.deepEqual(legacyStatus.result?.structuredContent, afterMcpExit);

    const stopArgs = [
      'stop',
      '--session',
      created.sessionId,
      '--client-id',
      'cli-mcp-client',
      '--request-id',
      'cli-stop-once',
      '--state-dir',
      config.stateDir,
      '--json',
    ] as const;
    const stopped = await runCliJson(stopArgs);
    assert.equal(stopped.code, 0, stopped.stderr);
    const stoppedSnapshot = JSON.parse(stopped.stdout) as SessionSnapshot;
    assert.equal(stoppedSnapshot.sessionState, 'cancelled');
    assert.equal(stoppedSnapshot.providerState, 'stopped');
    const replayedStop = await runCliJson(stopArgs);
    assert.equal(replayedStop.code, 0, replayedStop.stderr);
    assert.deepEqual(JSON.parse(replayedStop.stdout), stoppedSnapshot);
    assert.equal(fake.stopCount, 1);

    await callRpc({
      socketPath: config.socketPath,
      method: 'team.role.create',
      params: {
        clientId: 'cli-mcp-client',
        requestId: 'ambiguous-role',
        teamId: team.teamId,
        roleKey: 'expert.ambiguous-stop',
        roleType: 'expert',
        reportsToRoleKey: 'main',
      },
    });
    const ambiguousSession = await callRpc<SessionSnapshot>({
      socketPath: config.socketPath,
      method: 'session.create',
      params: {
        clientId: 'cli-mcp-client',
        requestId: 'ambiguous-session',
        teamId: team.teamId,
        roleKey: 'expert.ambiguous-stop',
        provider: 'chatgpt',
      },
    });
    await callRpc({
      socketPath: config.socketPath,
      method: 'session.send',
      params: {
        clientId: 'cli-mcp-client',
        requestId: 'ambiguous-send',
        sessionId: ambiguousSession.sessionId,
        prompt: 'Keep this generation active for stop ambiguity.',
        sessionDeadlineSec: 600,
      },
    });
    fake.stopThrows = true;
    const ambiguousArgs = [
      'stop',
      '--session',
      ambiguousSession.sessionId,
      '--client-id',
      'cli-mcp-client',
      '--request-id',
      'ambiguous-stop',
      '--state-dir',
      config.stateDir,
      '--json',
    ] as const;
    const firstAmbiguous = await runCliJson(ambiguousArgs);
    assert.equal(firstAmbiguous.code, 1);
    assert.equal(JSON.parse(firstAmbiguous.stderr).errorCode, 'internal.invariant-violation');
    const stopCountAfterFirst = fake.stopCount;
    const secondAmbiguous = await runCliJson(ambiguousArgs);
    assert.equal(secondAmbiguous.code, 1);
    assert.equal(fake.stopCount, stopCountAfterFirst);
  } finally {
    await modern?.close();
    await restarted?.close();
    await legacy?.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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

async function runCliJson(argv: readonly string[]) {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const code = await runCli(argv, {
    stdin: Readable.from([]),
    stdout,
    stderr,
  });
  return { code, stdout: stdout.value.trim(), stderr: stderr.value.trim() };
}

class McpSubprocess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    string,
    {
      readonly resolve: (response: JsonRpcResponse) => void;
      readonly reject: (error: Error) => void;
      readonly timer: NodeJS.Timeout;
    }
  >();
  #nextId = 1;
  #buffer = '';
  #stderr = '';

  constructor(stateDir: string) {
    this.#child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve(process.cwd(), 'src/cli/main.ts'),
        'mcp',
        '--state-dir',
        stateDir,
      ],
      { cwd: process.cwd(), env: { ...process.env } },
    );
    this.#child.stdout.setEncoding('utf8');
    this.#child.stderr.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => this.#handleChunk(chunk));
    this.#child.stderr.on('data', (chunk: string) => {
      this.#stderr += chunk;
    });
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
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return;
    }
    this.#child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill('SIGTERM');
        resolve();
      }, 2_000);
      this.#child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #handleChunk(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) {
        continue;
      }
      const response = JSON.parse(line) as JsonRpcResponse;
      const key = String(response.id);
      const pending = this.#pending.get(key);
      if (pending === undefined) {
        continue;
      }
      clearTimeout(pending.timer);
      this.#pending.delete(key);
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

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
