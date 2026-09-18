import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findHostBrowser } from '../../src/browser/browser-health.ts';

import {
  BrowserOwner,
  buildHostBrowserArguments,
} from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

const HOST_BROWSER = findHostBrowser();

test('BrowserOwner owns one dedicated persistent profile and fails closed for a second owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-owner-'));
  const profileRoot = path.join(root, 'profiles');
  const profileDir = path.join(profileRoot, HOST_BROWSER?.product ?? 'unknown');
  assert.notEqual(HOST_BROWSER, null, 'a user-installed Chromium-family browser is required');
  const first = new BrowserOwner({
    profileDir: profileRoot,
    scopeProfileByBrowser: true,
    pageRegistry: new PageRegistry(),
    headless: true,
    browserExecutable: HOST_BROWSER?.executable ?? null,
  });
  const second = new BrowserOwner({
    profileDir: profileRoot,
    scopeProfileByBrowser: true,
    pageRegistry: new PageRegistry(),
    headless: true,
    browserExecutable: HOST_BROWSER?.executable ?? null,
  });

  try {
    await first.start();
    assert.equal(first.status.state, 'ready');
    assert.equal(first.status.transport, 'cdp');
    assert.equal(first.status.ownership, 'spawned');
    assert.equal(first.status.chrome?.source, 'host');
    assert.ok((first.status.browserPid ?? 0) > 0);
    assert.ok((first.status.debuggingPort ?? 0) > 0);
    if (process.platform === 'linux') {
      const commandLines = browserCommandLines(profileDir);
      assert.doesNotMatch(commandLines, /(?:^|\s)--no-sandbox(?:\s|$)/m);
      assert.doesNotMatch(commandLines, /(?:^|\s)--disable-setuid-sandbox(?:\s|$)/m);
      assert.doesNotMatch(commandLines, /(?:^|\s)--disable-infobars(?:\s|$)/m);
      assert.doesNotMatch(
        commandLines,
        /(?:^|\s)--unsafely-disable-devtools-self-xss-warnings(?:\s|$)/m,
      );
    }
    assert.equal(first.status.profileDir, profileDir);
    const lockPath = path.join(profileDir, '.sessionplane-profile.lock');
    assert.equal(existsSync(lockPath), true);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      readonly browserPid: number;
      readonly debuggingPort: number;
    };
    assert.equal(lock.browserPid, first.status.browserPid);
    assert.equal(lock.debuggingPort, first.status.debuggingPort);

    await assert.rejects(second.start(), /already owned/);
  } finally {
    await second.close();
    await first.close();
    assert.equal(existsSync(path.join(profileDir, '.sessionplane-profile.lock')), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test('host browser arguments use a positive loopback CDP port without automation or sandbox-disabling switches', () => {
  const args = buildHostBrowserArguments({
    profileDir: '/tmp/sessionplane-profile',
    debuggingPort: 9_333,
    headless: false,
  });
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.ok(args.includes('--remote-debugging-port=9333'));
  assert.ok(args.includes('--user-data-dir=/tmp/sessionplane-profile'));
  assert.equal(args.some((argument) => argument === '--enable-automation'), false);
  assert.equal(args.some((argument) => argument === '--no-sandbox'), false);
  assert.equal(args.some((argument) => argument === '--disable-setuid-sandbox'), false);
  assert.equal(args.some((argument) => argument === '--remote-debugging-port=0'), false);
  assert.equal(args.some((argument) => argument.startsWith('--headless')), false);
});

test(
  'headed host browser CDP attachment preserves navigator.webdriver=false',
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
      browserExecutable: HOST_BROWSER?.executable ?? null,
    });
    try {
      await owner.start();
      const created = await owner.createPage();
      assert.equal(await created.page.evaluate(() => navigator.webdriver), false);
      assert.equal(owner.status.transport, 'cdp');
    } finally {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('a new core owner adopts the exact live profile and positive CDP endpoint after a stale lock', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-adoption-'));
  const profileDir = path.join(root, 'profile');
  const first = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
    browserExecutable: HOST_BROWSER?.executable ?? null,
  });
  const second = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
    browserExecutable: HOST_BROWSER?.executable ?? null,
  });
  try {
    await first.start();
    const lockPath = path.join(profileDir, '.sessionplane-profile.lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    writeFileSync(lockPath, JSON.stringify({ ...lock, pid: 99_999_999 }), { mode: 0o600 });

    await second.start();
    assert.equal(second.status.ownership, 'adopted');
    assert.equal(second.status.browserPid, first.status.browserPid);
    assert.equal(second.status.debuggingPort, first.status.debuggingPort);
    const page = await second.createPage();
    assert.equal(await page.page.evaluate(() => document.location.href), 'about:blank');
  } finally {
    await second.close();
    await first.close();
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

function browserCommandLines(profileDir: string): string {
  try {
    return execFileSync('pgrep', ['-af', '--', `--user-data-dir=${profileDir}`], {
      encoding: 'utf8',
      timeout: 2_000,
    });
  } catch (error) {
    throw new Error(`Could not inspect the host browser command line for ${profileDir}`, {
      cause: error,
    });
  }
}

