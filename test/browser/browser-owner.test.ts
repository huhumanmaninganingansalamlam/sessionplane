import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';
import { findHostBrowser } from '../../src/browser/browser-health.ts';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

const HOST_BROWSER = findHostBrowser();

test('BrowserOwner owns one dedicated persistent profile and fails closed for a second owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-owner-'));
  const profileDir = path.join(root, 'profile');
  assert.notEqual(HOST_BROWSER, null, 'a user-installed Chromium-family browser is required');
  let capturedLaunchOptions: Parameters<typeof chromium.launchPersistentContext>[1] | null = null;
  const first = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
    browserExecutable: HOST_BROWSER?.executable ?? null,
    launchPersistentContext(userDataDir, options) {
      capturedLaunchOptions = options;
      return chromium.launchPersistentContext(userDataDir, options);
    },
  });
  const second = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
    browserExecutable: HOST_BROWSER?.executable ?? null,
  });

  try {
    await first.start();
    assert.equal(first.status.state, 'ready');
    assert.equal(first.status.transport, 'playwright');
    assert.equal(first.status.ownership, 'playwright');
    assert.equal(first.status.chrome?.source, 'host');
    assert.equal(capturedLaunchOptions?.channel, undefined);
    assert.equal(capturedLaunchOptions?.executablePath, HOST_BROWSER?.executable);
    assert.deepEqual(capturedLaunchOptions?.ignoreDefaultArgs, [
      '--password-store=basic',
      '--use-mock-keychain',
    ]);
    const lockPath = path.join(profileDir, '.sessionplane-profile.lock');
    assert.equal(existsSync(lockPath), true);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);

    await assert.rejects(second.start(), /already owned/);
  } finally {
    await second.close();
    await first.close();
    assert.equal(existsSync(path.join(profileDir, '.sessionplane-profile.lock')), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test('BrowserOwner login returns after response commit without waiting for page completion', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-login-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
    browserExecutable: HOST_BROWSER?.executable ?? null,
    launchTimeoutMs: 5_000,
  });
  const fixture = await startCommittedResponseFixture();

  try {
    await owner.start();
    const startedAt = Date.now();
    const binding = await owner.openLoginPage(fixture.url);
    assert.equal(binding.url, fixture.url);
    assert.ok(Date.now() - startedAt < 2_000, 'login navigation waited for body completion');
  } finally {
    await owner.close();
    fixture.server.closeAllConnections();
    await closeServer(fixture.server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('BrowserOwner closes a newly created login Page when navigation fails', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-login-failure-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
    browserExecutable: HOST_BROWSER?.executable ?? null,
    launchTimeoutMs: 2_000,
  });
  const unavailableUrl = await closedFixtureUrl();

  try {
    await owner.start();
    const before = registry.listBindings({ includeClosed: false }).length;
    await assert.rejects(owner.openLoginPage(unavailableUrl), /Failed to open the ChatGPT login page/);
    assert.equal(registry.listBindings({ includeClosed: false }).length, before);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test(
  'BrowserOwner refuses to open a profile bound to a different host browser',
  { skip: HOST_BROWSER === null },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-profile-kind-'));
    const profileDir = path.join(root, 'profile');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      path.join(profileDir, '.sessionplane-browser.json'),
      JSON.stringify({
        product: 'edge',
        executable: '/different/browser',
        recordedAt: new Date(0).toISOString(),
      }),
    );
    const owner = new BrowserOwner({
      profileDir,
      pageRegistry: new PageRegistry(),
      headless: true,
      browserExecutable: HOST_BROWSER?.executable ?? null,
    });
    try {
      await assert.rejects(owner.start(), /belongs to edge/);
    } finally {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

async function startCommittedResponseFixture(): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.write('<!doctype html><title>Committed response</title><p>still loading');
  });
  const url = await listen(server);
  return { server, url };
}

async function closedFixtureUrl(): Promise<string> {
  const server = createServer();
  const url = await listen(server);
  await closeServer(server);
  return url;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing fixture port');
  return `http://127.0.0.1:${address.port}/`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

