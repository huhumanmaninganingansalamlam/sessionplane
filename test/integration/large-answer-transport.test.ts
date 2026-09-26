import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { MCP_MODERN_PROTOCOL_VERSION } from '../../src/mcp/schemas.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface WaitSnapshot extends SessionSnapshot {
  readonly latestEventSequence: number;
}

test('500KB+ answer hash is identical in SQLite, RPC, CLI, and MCP structuredContent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-large-answer-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: 10,
    observationQuietSweepMs: 20,
    observationQuietWindowMs: 10,
  });
  const fake = new FakeProviderAdapter();
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });

  try {
    const team = await callRpc<TeamSnapshot>({
      socketPath: config.socketPath,
      method: 'team.create',
      params: {
        clientId: 'large-answer-client',
        requestId: 'large-answer-team',
        primaryRoleKey: 'main',
      },
    });
    const session = await callRpc<SessionSnapshot>({
      socketPath: config.socketPath,
      method: 'session.create',
      params: {
        clientId: 'large-answer-client',
        requestId: 'large-answer-session',
        teamId: team.teamId,
        roleKey: 'main',
        provider: 'chatgpt',
      },
    });
    await callRpc({
      socketPath: config.socketPath,
      method: 'session.send',
      params: {
        clientId: 'large-answer-client',
        requestId: 'large-answer-send',
        sessionId: session.sessionId,
        prompt: 'Return a large deterministic answer.',
        sessionDeadlineSec: 600,
      },
    });

    const answer = `${'0123456789abcdef'.repeat(35_000)}\nterminal`;
    assert.ok(Buffer.byteLength(answer, 'utf8') > 500 * 1024);
    fake.emitObservation(session.sessionId, {
      candidate: {
        responseMessageId: 'large-answer-response',
        answerText: answer,
        terminalMarker: true,
        streamingMarker: false,
      },
      activity: 'none',
    });

    const complete = await waitForComplete(config.socketPath, session.sessionId);
    assert.equal(complete.answerText, answer);

    const databaseRow = service.database.raw
      .prepare(`
        SELECT answer_text AS answerText
        FROM generations
        WHERE session_id = ? AND generation = 1
      `)
      .get(session.sessionId) as { answerText: string };

    const rpcSnapshot = await callRpc<SessionSnapshot>({
      socketPath: config.socketPath,
      method: 'session.get',
      params: { clientId: 'large-answer-client', sessionId: session.sessionId },
      maxLineBytes: config.rpcMaxLineBytes,
    });

    const cli = await runCliJson([
      'status',
      '--session',
      session.sessionId,
      '--client-id',
      'large-answer-client',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(cli.code, 0, cli.stderr);
    const cliSnapshot = JSON.parse(cli.stdout) as SessionSnapshot;

    const view = await callRpc<{ requests: Array<{ requestRef: string }> }>({ socketPath: config.socketPath,
      method: 'workflow.team_get', params: { teamId: team.teamId } });
    const mcpResponse = await callMcpStatus(config.stateDir, team.teamId, view.requests[0]!.requestRef);
    const mcpResult = mcpResponse.result as Readonly<Record<string, unknown>>;
    const mcpSnapshot = (mcpResult.structuredContent as { request: SessionSnapshot }).request;
    const content = mcpResult.content as Array<{ type: string; text: string }>;
    assert.equal(mcpResult.isError, false);
    assert.equal(JSON.parse(content[0]?.text ?? '{}').truncatedInText, true);

    const expectedHash = sha256(answer);
    assert.equal(sha256(databaseRow.answerText), expectedHash);
    assert.equal(sha256(rpcSnapshot.answerText ?? ''), expectedHash);
    assert.equal(sha256(cliSnapshot.answerText ?? ''), expectedHash);
    assert.equal(sha256(mcpSnapshot.answerText ?? ''), expectedHash);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForComplete(socketPath: string, sessionId: string): Promise<WaitSnapshot> {
  let cursor = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await callRpc<WaitSnapshot>({
      socketPath,
      method: 'session.wait',
      params: {
        clientId: 'large-answer-client',
        sessionId,
        generation: 1,
        afterEventSequence: cursor,
        waitMs: 100,
      },
      timeoutMs: 2_000,
    });
    cursor = Math.max(cursor, snapshot.latestEventSequence);
    if (snapshot.terminal) {
      return snapshot;
    }
  }
  throw new Error('Timed out waiting for the large answer');
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

async function callMcpStatus(
  stateDir: string,
  teamId: string,
  requestRef: string,
): Promise<Readonly<Record<string, unknown>>> {
  const child = spawn(
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
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const response = await new Promise<Readonly<Record<string, unknown>>>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`MCP large-answer request timed out: ${stderr}`));
    }, 5_000);
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, newline)) as Readonly<Record<string, unknown>>);
    });
    child.once('exit', (code, signal) => {
      if (buffer.includes('\n')) {
        return;
      }
      clearTimeout(timer);
      reject(
        new Error(
          `MCP large-answer subprocess exited early (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
        ),
      );
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 'large-answer',
        method: 'tools/call',
        params: {
          name: 'sessionplane_team_get',
          arguments: { teamId, requestRef },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MCP_MODERN_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      })}\n`,
    );
  });
  child.stdin.end();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return response;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
