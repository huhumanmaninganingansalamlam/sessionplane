import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';

interface BrowserSnapshot {
  readonly snapshotId: string;
  readonly pageKey: string;
  readonly nodes: readonly Array<{
    readonly ref: string;
    readonly name: string;
  }>;
}

test('agbrowse-compatible CLI and MCP share one explicit browser Page and snapshot refs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-cli-mcp-'));
  const fixture = await startFixtureServer();
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({
    config,
    browserHeadless: true,
    logger: silentLogger(),
  });

  try {
    const contradictoryLogin = await runCliJson([
      'login',
      '--manual',
      '--resume',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(contradictoryLogin.code, 2);
    assert.match(contradictoryLogin.stderr, /mutually exclusive/);

    const manualLogin = await runCliJson([
      'login',
      '--manual',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(manualLogin.code, 1);
    assert.equal(
      (JSON.parse(manualLogin.stderr) as { errorCode: string }).errorCode,
      'browser.manual-login-unavailable',
    );

    const createdRun = await runCliJson([
      'new-tab',
      fixture.url,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(createdRun.code, 0, createdRun.stderr);
    const created = JSON.parse(createdRun.stdout) as {
      selectedPageKey: string;
    };

    const snapshotRun = await runCliJson([
      'snapshot',
      '--page',
      created.selectedPageKey,
      '--max-nodes',
      '30',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(snapshotRun.code, 0, snapshotRun.stderr);
    const snapshot = JSON.parse(snapshotRun.stdout) as BrowserSnapshot;
    const input = snapshot.nodes.find((node) => node.name === 'Name');
    const button = snapshot.nodes.find((node) => node.name === 'Increment');
    assert.notEqual(input, undefined);
    assert.notEqual(button, undefined);

    const typed = await runCliJson([
      'type',
      input?.ref ?? '',
      '--text',
      'Ada',
      '--snapshot-id',
      snapshot.snapshotId,
      '--page',
      snapshot.pageKey,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(typed.code, 0, typed.stderr);

    const clicked = await invokeMcpTool({
      name: 'browser_click_ref',
      arguments: {
        pageKey: snapshot.pageKey,
        snapshotId: snapshot.snapshotId,
        ref: button?.ref,
      },
      socketPath: config.socketPath,
      timeoutMs: 5_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    assert.equal(clicked.isError, false);

    const evaluated = await runCliJson([
      'evaluate',
      '--script',
      `({ name: document.querySelector('#name').value, count: window.count })`,
      '--page',
      snapshot.pageKey,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    assert.deepEqual(JSON.parse(evaluated.stdout).value, { name: 'Ada', count: 1 });

    const bundle = await invokeMcpTool({
      name: 'browser_observe_bundle',
      arguments: { pageKey: snapshot.pageKey, includeBoxes: true, maxTextChars: 500 },
      socketPath: config.socketPath,
      timeoutMs: 5_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    assert.equal(bundle.isError, false);
    assert.equal(bundle.structuredContent.pageKey, snapshot.pageKey);
    assert.equal(bundle.structuredContent.schemaVersion, 'observation-bundle-v1');

    const compatibilityHelp = spawnSync(
      process.execPath,
      [path.resolve(process.cwd(), 'bin/agbrowse.mjs'), '--help'],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
    );
    assert.equal(compatibilityHelp.status, 0, compatibilityHelp.stderr);
    assert.match(compatibilityHelp.stdout, /Browser compatibility:/);
    assert.match(compatibilityHelp.stdout, /snapshot/);
  } finally {
    await service.close();
    await closeServer(fixture.server);
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

async function startFixtureServer(): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html>
        <head><title>CLI MCP Browser Fixture</title></head>
        <body>
          <label for="name">Name</label>
          <input id="name" type="text">
          <button id="increment" type="button">Increment</button>
          <script>
            window.count = 0;
            document.querySelector('#increment').addEventListener('click', () => {
              window.count += 1;
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not expose a TCP port');
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
