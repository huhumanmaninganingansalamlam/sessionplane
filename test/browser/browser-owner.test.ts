import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BrowserOwner,
  buildChromeArguments,
} from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

test('BrowserOwner owns one dedicated persistent profile and fails closed for a second owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-owner-'));
  const profileDir = path.join(root, 'profile');
  const first = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
  });
  const second = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
  });

  try {
    await first.start();
    assert.equal(first.status.state, 'ready');
    assert.equal(first.status.transport, 'cdp');
    assert.equal(first.status.ownership, 'spawned');
    const lockPath = path.join(profileDir, '.sessionplane-profile.lock');
    assert.equal(existsSync(lockPath), true);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      readonly pid: number;
      readonly browserPid: number;
      readonly debuggingPort: number;
    };
    assert.equal(lock.pid, process.pid);
    assert.ok(Number.isSafeInteger(lock.browserPid) && lock.browserPid > 0);
    assert.ok(lock.debuggingPort > 0 && lock.debuggingPort <= 65_535);
    assert.equal(first.status.browserPid, lock.browserPid);
    assert.equal(first.status.debuggingPort, lock.debuggingPort);

    await assert.rejects(second.start(), /already owned/);
  } finally {
    await second.close();
    await first.close();
    assert.equal(existsSync(path.join(profileDir, '.sessionplane-profile.lock')), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'BrowserOwner adopts the exact orphan Chrome after the owning core disappears',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-adopt-'));
    const profileDir = path.join(root, 'profile');
    const firstRegistry = new PageRegistry();
    const secondRegistry = new PageRegistry();
    const first = new BrowserOwner({
      profileDir,
      pageRegistry: firstRegistry,
      headless: true,
      pid: 2_147_483_000,
    });
    const second = new BrowserOwner({
      profileDir,
      pageRegistry: secondRegistry,
      headless: true,
    });

    try {
      await first.start();
      const page = await first.createPage();
      await page.page.goto('data:text/html,<title>Orphan Chrome</title>');
      const originalPid = first.status.browserPid;
      const originalPort = first.status.debuggingPort;
      assert.ok(originalPid !== null && originalPort !== null);

      await second.start();
      assert.equal(second.status.state, 'ready');
      assert.equal(second.status.ownership, 'adopted');
      assert.equal(second.status.browserPid, originalPid);
      assert.equal(second.status.debuggingPort, originalPort);
      assert.ok(
        secondRegistry
          .listBindings({ includeClosed: false })
          .some((binding) => binding.url.startsWith('data:text/html')),
      );
      const lock = JSON.parse(
        readFileSync(path.join(profileDir, '.sessionplane-profile.lock'), 'utf8'),
      ) as { readonly pid: number; readonly browserPid: number; readonly debuggingPort: number };
      assert.equal(lock.pid, process.pid);
      assert.equal(lock.browserPid, originalPid);
      assert.equal(lock.debuggingPort, originalPort);
    } finally {
      await second.close();
      await first.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('Chrome arguments expose loopback CDP without automation or stealth switches', () => {
  const args = buildChromeArguments({
    profileDir: '/tmp/sessionplane-profile',
    debuggingPort: 9_333,
    headless: false,
  });
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.ok(args.includes('--user-data-dir=/tmp/sessionplane-profile'));
  assert.equal(args.some((argument) => argument === '--enable-automation'), false);
  assert.equal(args.some((argument) => argument.includes('AutomationControlled')), false);
  assert.equal(args.some((argument) => argument.startsWith('--headless')), false);
});

test(
  'headed Chrome CDP attachment preserves navigator.webdriver=false',
  {
    skip:
      process.platform === 'linux' &&
      process.env.DISPLAY === undefined &&
      process.env.WAYLAND_DISPLAY === undefined,
  },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-webdriver-'));
    const owner = new BrowserOwner({
      profileDir: path.join(root, 'profile'),
      pageRegistry: new PageRegistry(),
      headless: false,
    });
    try {
      await owner.start();
      const created = await owner.createPage();
      assert.equal(await created.page.evaluate(() => navigator.webdriver), false);
    } finally {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

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

