import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

test('BrowserOwner owns one dedicated persistent profile and fails closed for a second owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-owner-'));
  const profileDir = path.join(root, 'profile');
  let capturedLaunchOptions: Parameters<typeof chromium.launchPersistentContext>[1] | null = null;
  const first = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
    launchPersistentContext(userDataDir, options) {
      capturedLaunchOptions = options;
      return chromium.launchPersistentContext(userDataDir, options);
    },
  });
  const second = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
  });

  try {
    await first.start();
    assert.equal(first.status.state, 'ready');
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

