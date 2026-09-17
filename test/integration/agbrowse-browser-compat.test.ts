import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { runAgbrowseCli } from '../../src/compat/agbrowse-cli.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';

interface LegacySnapshot {
  readonly snapshotId: string;
  readonly pageKey: string;
  readonly nodes: readonly Array<{
    readonly ref: string;
    readonly canonicalRef: string;
    readonly name: string;
  }>;
}

test('agbrowse alias help identifies SessionPlane and the Chat-only boundary', async () => {
  const rootHelp = await runJson(['--help']);
  assert.equal(rootHelp.code, 0, rootHelp.stderr);
  assert.match(rootHelp.stdout, /SessionPlane .*agbrowse compatibility/);
  assert.match(rootHelp.stdout, /ChatGPT provider automation is Chat-only/);
  assert.match(rootHelp.stdout, /agbrowse web-ai --help/);

  const webAiHelp = await runJson(['web-ai', '--help']);
  assert.equal(webAiHelp.code, 0, webAiHelp.stderr);
  assert.match(webAiHelp.stdout, /agbrowse web-ai compatibility/);
  assert.match(webAiHelp.stdout, /ChatGPT is Chat-only/);
  assert.match(webAiHelp.stdout, /--power, --speed/);
});

test('agbrowse alias translates legacy browser grammar into the same core', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-agbrowse-compat-'));
  const fixture = await startFixtureServer();
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    fetchAllowPrivateNetworks: true,
  });
  const service = await startCore({
    config,
    browserHeadless: true,
    logger: silentLogger(),
  });

  try {
    const started = await runJson(['start', '--state-dir', config.stateDir, '--json']);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(JSON.parse(started.stdout).status, 'running');

    const created = await runJson([
      'new-tab',
      fixture.url,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(created.code, 0, created.stderr);
    const createdValue = JSON.parse(created.stdout) as {
      targetId: string;
      selectedPageKey: string;
    };
    assert.equal(createdValue.targetId, createdValue.selectedPageKey);

    const tabs = await runJson(['tabs', '--state-dir', config.stateDir, '--json']);
    assert.equal(tabs.code, 0, tabs.stderr);
    const tabValue = JSON.parse(tabs.stdout) as {
      tabs: readonly Array<{ index: number; targetId: string; pageKey: string }>;
    };
    const targetIndex = tabValue.tabs.find((tab) => tab.pageKey === createdValue.targetId)?.index;
    assert.notEqual(targetIndex, undefined);
    const switched = await runJson([
      'tab-switch',
      String(targetIndex),
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(switched.code, 0, switched.stderr);
    assert.equal(JSON.parse(switched.stdout).targetId, createdValue.targetId);

    const snapshotRun = await runJson([
      'snapshot',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(snapshotRun.code, 0, snapshotRun.stderr);
    const snapshot = JSON.parse(snapshotRun.stdout) as LegacySnapshot;
    const input = snapshot.nodes.find((node) => node.name === 'Name');
    const button = snapshot.nodes.find((node) => node.name === 'Increment');
    assert.match(input?.ref ?? '', /^e\d+$/);
    assert.match(input?.canonicalRef ?? '', /^@e\d+$/);

    const typed = await runJson([
      'type',
      input?.ref ?? '',
      'Ada',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(typed.code, 0, typed.stderr);
    const clicked = await runJson([
      'click',
      button?.ref ?? '',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(clicked.code, 0, clicked.stderr);

    const evaluated = await runJson([
      'evaluate',
      `({ name: document.querySelector('#name').value, count: window.count })`,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    assert.deepEqual(JSON.parse(evaluated.stdout).value, { name: 'Ada', count: 1 });

    const fetched = await runJson([
      'fetch',
      fixture.url,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.equal(JSON.parse(fetched.stdout).schemaVersion, 'sessionplane-adaptive-fetch-v1');

    const stopped = await runJson(['stop', '--state-dir', config.stateDir, '--json']);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(JSON.parse(stopped.stdout).browser.state, 'stopped');
    const restarted = await runJson(['start', '--state-dir', config.stateDir, '--json']);
    assert.equal(restarted.code, 0, restarted.stderr);
    assert.equal(JSON.parse(restarted.stdout).browser.state, 'ready');

    const resetWithoutForce = await runJson([
      'reset',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(resetWithoutForce.code, 1);
    assert.equal(JSON.parse(resetWithoutForce.stderr).errorCode, 'input.confirmation-required');
    const reset = await runJson([
      'reset',
      '--force',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(reset.code, 0, reset.stderr);
    assert.equal(JSON.parse(reset.stdout).browser.state, 'ready');
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

async function runJson(argv: readonly string[]) {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const code = await runAgbrowseCli(argv, {
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
        <head><title>agbrowse Compatibility Fixture</title></head>
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
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port');
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
