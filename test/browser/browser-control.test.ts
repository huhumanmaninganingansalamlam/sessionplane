import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import {
  BrowserControlError,
  BrowserControlService,
} from '../../src/core/browser-control-service.ts';

test('generic browser control exposes snapshot-bound refs without focus identity', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-control-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });
  const browser = new BrowserControlService({
    browserOwner: owner,
    pageRegistry: registry,
    genericMutationsEnabled: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://browser.test/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: fixtureHtml(),
      });
    });
    await created.page.goto('https://browser.test/start');
    registry.refreshPage(created.binding.pageKey);
    await browser.select(created.binding.pageKey);

    const tabs = await browser.tabs() as {
      selectedPageKey: string;
      tabs: readonly Array<{ pageKey: string; selected: boolean }>;
    };
    assert.equal(tabs.selectedPageKey, created.binding.pageKey);
    assert.ok(tabs.tabs.length >= 1);
    assert.equal(
      tabs.tabs.find((tab) => tab.pageKey === created.binding.pageKey)?.selected,
      true,
    );

    const snapshot = await browser.snapshot({ maxNodes: 50 });
    const input = snapshot.nodes.find((node) => node.name === 'Name');
    const button = snapshot.nodes.find((node) => node.name === 'Increment');
    const checkbox = snapshot.nodes.find((node) => node.name === 'Enabled');
    const select = snapshot.nodes.find((node) => node.name === 'Mode');
    const upload = snapshot.nodes.find((node) => node.name === 'Attachment');
    assert.notEqual(input, undefined);
    assert.notEqual(button, undefined);
    assert.notEqual(checkbox, undefined);
    assert.notEqual(select, undefined);
    assert.notEqual(upload, undefined);

    await browser.type({
      ref: input?.ref ?? '',
      snapshotId: snapshot.snapshotId,
      text: 'Ada',
    });
    await browser.click({ ref: button?.ref ?? '', snapshotId: snapshot.snapshotId });
    await browser.setChecked({
      ref: checkbox?.ref ?? '',
      snapshotId: snapshot.snapshotId,
      checked: true,
    });
    await browser.selectOption({
      ref: select?.ref ?? '',
      snapshotId: snapshot.snapshotId,
      values: ['b'],
    });
    const uploadPath = path.join(root, 'attachment.txt');
    writeFileSync(uploadPath, 'attachment', 'utf8');
    await browser.upload({
      ref: upload?.ref ?? '',
      snapshotId: snapshot.snapshotId,
      files: [uploadPath],
    });

    const state = await browser.evaluate({
      script: `({
        name: document.querySelector('#name').value,
        count: window.count,
        enabled: document.querySelector('#enabled').checked,
        mode: document.querySelector('#mode').value,
        files: document.querySelector('#attachment').files.length
      })`,
    });
    assert.deepEqual(state.value, {
      name: 'Ada',
      count: 1,
      enabled: true,
      mode: 'b',
      files: 1,
    });

    const screenshotPath = path.join(root, 'shot.png');
    await browser.screenshot({ outputPath: screenshotPath, fullPage: true });
    assert.equal(existsSync(screenshotPath), true);

    const actions = await browser.observeActions({ instruction: 'click increment', topN: 3 });
    assert.equal(actions.requestOk, true);
    assert.equal((actions.candidates as readonly Array<{ name: string }>)[0]?.name, 'Increment');

    const bundle = await browser.observationBundle({ maxTextChars: 100 });
    assert.equal(bundle.schemaVersion, 'observation-bundle-v1');
    assert.equal(bundle.pageKey, created.binding.pageKey);

    await browser.navigate({ url: 'https://browser.test/next' });
    await assert.rejects(
      browser.click({ ref: button?.ref ?? '', snapshotId: snapshot.snapshotId }),
      (error: unknown) =>
        error instanceof BrowserControlError && error.errorCode === 'browser.snapshot-stale',
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('production browser control rejects generic mutation while preserving observation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-provider-only-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });
  const browser = new BrowserControlService({ browserOwner: owner, pageRegistry: registry });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://browser.test/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: fixtureHtml(),
      });
    });
    await created.page.goto('https://browser.test/start');
    registry.refreshPage(created.binding.pageKey);
    await browser.select(created.binding.pageKey);

    const snapshot = await browser.snapshot({ maxNodes: 50 });
    assert.equal(snapshot.pageKey, created.binding.pageKey);
    const button = snapshot.nodes.find((node) => node.name === 'Increment');

    for (const operation of [
      () => browser.newPage('https://example.com/'),
      () => browser.navigate({ url: 'https://example.com/' }),
      () => browser.click({ ref: button?.ref ?? '', snapshotId: snapshot.snapshotId }),
      () => browser.evaluate({ script: 'document.body.textContent = "mutated"' }),
      () => browser.resetRuntime(true),
    ]) {
      await assert.rejects(
        operation(),
        (error: unknown) =>
          error instanceof BrowserControlError && error.errorCode === 'capability.unsupported',
      );
    }

    const text = await browser.text({ maxChars: 100 });
    assert.match(String(text.text), /Increment/);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('multiple generic Pages require an explicit selected pageKey', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-selection-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });
  const browser = new BrowserControlService({ browserOwner: owner, pageRegistry: registry });

  try {
    await owner.start();
    const first = await owner.createPage();
    const second = await owner.createPage();
    await assert.rejects(
      browser.snapshot(),
      (error: unknown) =>
        error instanceof BrowserControlError && error.errorCode === 'input.page-required',
    );
    await browser.select(second.binding.pageKey);
    const snapshot = await browser.snapshot();
    assert.equal(snapshot.pageKey, second.binding.pageKey);
    assert.notEqual(snapshot.pageKey, first.binding.pageKey);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser lifecycle stop, start, and forced profile reset stay core-owned', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-lifecycle-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });
  let recoveries = 0;
  const browser = new BrowserControlService({
    browserOwner: owner,
    pageRegistry: registry,
    onStarted: async () => ({ recovery: ++recoveries }),
    genericMutationsEnabled: true,
  });

  try {
    await owner.start();
    assert.equal((browser.runtimeStatus().browser as { state: string }).state, 'ready');

    const stopped = await browser.stopRuntime();
    assert.equal((stopped.browser as { state: string }).state, 'stopped');

    const started = await browser.startRuntime();
    assert.equal((started.browser as { state: string }).state, 'ready');
    assert.deepEqual(started.recovery, { recovery: 1 });
    assert.equal(recoveries, 1);

    const alreadyReady = await browser.startRuntime();
    assert.equal((alreadyReady.browser as { state: string }).state, 'ready');
    assert.equal('recovery' in alreadyReady, false);
    assert.equal(recoveries, 1);

    await assert.rejects(
      browser.resetRuntime(false),
      (error: unknown) =>
        error instanceof BrowserControlError &&
        error.errorCode === 'input.confirmation-required',
    );
    const reset = await browser.resetRuntime(true);
    assert.equal((reset.browser as { state: string }).state, 'ready');
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureHtml(): string {
  return `<!doctype html>
    <html>
      <head><title>Browser Control Fixture</title></head>
      <body>
        <label for="name">Name</label>
        <input id="name" type="text">
        <button id="increment" type="button">Increment</button>
        <label><input id="enabled" type="checkbox">Enabled</label>
        <label for="mode">Mode</label>
        <select id="mode"><option value="a">A</option><option value="b">B</option></select>
        <label for="attachment">Attachment</label>
        <input id="attachment" type="file">
        <script>
          window.count = 0;
          document.querySelector('#increment').addEventListener('click', () => {
            window.count += 1;
            console.log('incremented', window.count);
          });
        </script>
      </body>
    </html>`;
}
