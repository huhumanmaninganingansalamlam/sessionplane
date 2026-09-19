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
  assert.match(rootHelp.stdout, /new-tab.*--no-activate/);
  assert.match(rootHelp.stdout, /snapshot defaults to all accessibility nodes/i);
  assert.match(rootHelp.stdout, /advanced fetch escalation options fail closed/i);

  const webAiHelp = await runJson(['web-ai', '--help']);
  assert.equal(webAiHelp.code, 0, webAiHelp.stderr);
  assert.match(webAiHelp.stdout, /agbrowse web-ai compatibility/);
  assert.match(webAiHelp.stdout, /ChatGPT is Chat-only/);
  assert.match(webAiHelp.stdout, /--power, --speed/);
  assert.match(webAiHelp.stdout, /sessions list.*--vendor.*--status.*--limit/);
  assert.match(webAiHelp.stdout, /session provider is inferred/i);
  assert.match(webAiHelp.stdout, /Grok context-pack.*--allow-grok-context-pack/i);
  assert.match(webAiHelp.stdout, /watch is a streaming watcher/i);
  assert.match(webAiHelp.stdout, /fails closed as a deferred surface/i);
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

    const background = await runJson([
      'new-tab',
      'about:blank',
      '--no-activate',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(background.code, 0, background.stderr);
    const backgroundValue = JSON.parse(background.stdout) as {
      targetId: string;
      selectedPageKey: string;
      activated: boolean;
    };
    assert.notEqual(backgroundValue.targetId, createdValue.targetId);
    assert.equal(backgroundValue.selectedPageKey, createdValue.targetId);
    assert.equal(backgroundValue.activated, false);

    const tabs = await runJson(['tabs', '--state-dir', config.stateDir, '--json']);
    assert.equal(tabs.code, 0, tabs.stderr);
    const tabValue = JSON.parse(tabs.stdout) as readonly Array<{
      index: number;
      targetId: string;
      pageKey: string;
    }>;
    assert.deepEqual(
      tabValue.map((tab) => tab.index),
      tabValue.map((_, index) => index + 1),
      'legacy agbrowse tab indices are 1-based',
    );
    const targetIndex = tabValue.find((tab) => tab.pageKey === createdValue.targetId)?.index;
    assert.notEqual(targetIndex, undefined);
    const switched = await runJson([
      'tab-switch',
      String(targetIndex),
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(switched.code, 0, switched.stderr);
    const switchedValue = JSON.parse(switched.stdout) as {
      readonly targetId: string;
      readonly tab: number | null;
    };
    assert.equal(switchedValue.targetId, createdValue.targetId);
    assert.equal(switchedValue.tab, targetIndex);

    const selectedAlias = await runJson([
      'select-tab',
      String(targetIndex),
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(selectedAlias.code, 0, selectedAlias.stderr);
    assert.equal(JSON.parse(selectedAlias.stdout).alias, 'select-tab');

    const active = await runJson(['active-tab', '--state-dir', config.stateDir, '--json']);
    assert.equal(active.code, 0, active.stderr);
    const activeValue = JSON.parse(active.stdout) as {
      readonly targetId: string;
      readonly tabs?: unknown;
    };
    assert.equal(activeValue.targetId, createdValue.targetId);
    assert.equal(activeValue.tabs, undefined);

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
    assert.ok(
      snapshot.nodes.some((node) => node.name === 'Static Summary'),
      'legacy snapshot defaults to all accessibility nodes',
    );
    assert.match(input?.ref ?? '', /^e\d+$/);
    assert.match(input?.canonicalRef ?? '', /^@e\d+$/);

    const typed = await runJson([
      'type',
      input?.ref ?? '',
      'Ada',
      'Lovelace',
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
    assert.deepEqual(JSON.parse(evaluated.stdout).value, { name: 'Ada Lovelace', count: 1 });

    const scheduledMarker = await runJson([
      'evaluate',
      `setTimeout(() => {
        const marker = document.createElement('div');
        marker.id = 'compat-late-marker';
        marker.textContent = 'Compat Late Marker';
        document.body.appendChild(marker);
      }, 150); 'scheduled'`,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(scheduledMarker.code, 0, scheduledMarker.stderr);
    const shortWait = await runJson([
      'wait-for-selector',
      '#compat-late-marker',
      '--timeout',
      '20',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.notEqual(shortWait.code, 0, 'legacy --timeout must remain milliseconds');
    const selectorWait = await runJson([
      'wait-for-selector',
      '#compat-late-marker',
      '--timeout',
      '1000',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(selectorWait.code, 0, selectorWait.stderr);
    const textWait = await runJson([
      'wait-for-text',
      'Compat',
      'Late',
      'Marker',
      '--timeout',
      '1000',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(textWait.code, 0, textWait.stderr);
    assert.equal(JSON.parse(textWait.stdout).text, 'Compat Late Marker');

    const selectedDom = await runJson([
      'get-dom',
      '--selector',
      'h1',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(selectedDom.code, 0, selectedDom.stderr);
    const selectedDomValue = JSON.parse(selectedDom.stdout) as { readonly html: string };
    assert.match(selectedDomValue.html, /Static Summary/);
    assert.doesNotMatch(selectedDomValue.html, /id="name"/);

    const logged = await runJson([
      'evaluate',
      `console.log('compat-one'); console.log('compat-two'); 'logged'`,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(logged.code, 0, logged.stderr);
    const limitedConsole = await runJson([
      'console',
      '--limit',
      '1',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(limitedConsole.code, 0, limitedConsole.stderr);
    const consoleValue = JSON.parse(limitedConsole.stdout) as {
      readonly entries: readonly unknown[];
    };
    assert.equal(consoleValue.entries.length, 1);

    const clearedConsole = await runJson([
      'console',
      '--clear',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(clearedConsole.code, 0, clearedConsole.stderr);
    const manyLogs = await runJson([
      'evaluate',
      `for (let index = 0; index < 60; index += 1) console.log('legacy-' + index)`,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(manyLogs.code, 0, manyLogs.stderr);
    const defaultLegacyConsole = await runJson([
      'console',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(defaultLegacyConsole.code, 0, defaultLegacyConsole.stderr);
    assert.equal(
      (JSON.parse(defaultLegacyConsole.stdout) as { entries: readonly unknown[] }).entries.length,
      50,
      'legacy agbrowse console retains its historical default limit',
    );

    const interactiveSnapshotRun = await runJson([
      'snapshot',
      '--interactive',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(interactiveSnapshotRun.code, 0, interactiveSnapshotRun.stderr);
    const interactiveSnapshot = JSON.parse(interactiveSnapshotRun.stdout) as LegacySnapshot;
    assert.equal(
      interactiveSnapshot.nodes.some((node) => node.name === 'Static Summary'),
      false,
    );
    assert.ok(interactiveSnapshot.nodes.some((node) => node.name === 'Increment'));

    const boundedBundle = await runJson([
      'observe-bundle',
      '--max-text-chars',
      '5',
      '--max-nodes',
      '1',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(boundedBundle.code, 0, boundedBundle.stderr);
    const bundleValue = JSON.parse(boundedBundle.stdout) as {
      readonly refs: readonly Array<{ readonly ref?: string; readonly canonicalRef?: string }>;
      readonly textSummary: string;
      readonly stats: { readonly textChars: number };
    };
    assert.ok(bundleValue.refs.length <= 1);
    assert.match(bundleValue.refs[0]?.ref ?? '', /^e\d+$/);
    assert.match(bundleValue.refs[0]?.canonicalRef ?? '', /^@e\d+$/);
    assert.ok(bundleValue.textSummary.length <= 5);
    assert.ok(bundleValue.stats.textChars >= bundleValue.textSummary.length);

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

test('agbrowse compatibility never silently ignores lifecycle or cleanup safety flags', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-agbrowse-option-safety-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
  });
  const service = await startCore({
    config,
    browserHeadless: true,
    logger: silentLogger(),
  });

  try {
    const fixedPort = await runJson([
      'start',
      '--port',
      '9333',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(fixedPort.code, 2);
    assert.match(JSON.parse(fixedPort.stderr).message, /--port.*not supported/i);

    const wrongMode = await runJson([
      'start',
      '--headed',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(wrongMode.code, 2);
    assert.match(JSON.parse(wrongMode.stderr).message, /headless|headed|mode/i);

    const missingChrome = await runJson([
      'start',
      '--chrome-path',
      path.join(root, 'missing-chrome'),
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(missingChrome.code, 2);
    assert.match(JSON.parse(missingChrome.stderr).message, /browser.*unavailable|executable/i);

    const created = await runJson([
      'new-tab',
      'about:blank',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(created.code, 0, created.stderr);
    const pageKey = JSON.parse(created.stdout).selectedPageKey as string;

    const cleanupDryRun = await runJson([
      'tab-cleanup',
      '--dry-run',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(cleanupDryRun.code, 2);
    assert.match(JSON.parse(cleanupDryRun.stderr).message, /--dry-run.*not supported/i);

    for (const [legacyCommand, args, option] of [
      ['tab-switch', ['1', '--force'], '--force'],
      ['console', ['--expression', '1 + 1'], '--expression'],
      ['network', ['--filter', '/api/'], '--filter'],
      ['navigate', ['about:blank', '--timeout', '5'], '--timeout'],
    ] as const) {
      const rejected = await runJson([
        legacyCommand,
        ...args,
        '--state-dir',
        config.stateDir,
        '--json',
      ]);
      assert.equal(rejected.code, 2, `${legacyCommand} ${option}`);
      assert.match(
        JSON.parse(rejected.stderr).message,
        new RegExp(`${option.replace(/[.*+?^$()|[\\]\\\\]/g, '\\\\$&')}.*not supported`, 'i'),
      );
    }

    const tabs = await runJson(['tabs', '--state-dir', config.stateDir, '--json']);
    assert.equal(tabs.code, 0, tabs.stderr);
    assert.ok(
      (JSON.parse(tabs.stdout) as readonly Array<{ pageKey: string }>).some(
        (tab) => tab.pageKey === pageKey,
      ),
      'a rejected legacy dry-run must not mutate browser tabs',
    );
  } finally {
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
          <h1>Static Summary</h1>
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
