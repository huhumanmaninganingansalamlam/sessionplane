import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ChromeInstallation } from '../../src/browser/browser-health.ts';
import {
  assertDedicatedBrowserProfile,
  ensureProfileBrowserIdentity,
  personalBrowserProfileRoots,
  resolveBrowserProfileDir,
} from '../../src/browser/browser-profile.ts';

const CHROME: ChromeInstallation = Object.freeze({
  executable: '/opt/google/chrome',
  version: 'Google Chrome 153.0.0.0',
  source: 'host',
  product: 'chrome',
});

test('default profiles are scoped by selected host browser product', () => {
  assert.equal(
    resolveBrowserProfileDir({
      profileRoot: '/tmp/sessionplane/profiles',
      browser: CHROME,
      scopeByBrowser: true,
    }),
    '/tmp/sessionplane/profiles/chrome',
  );
  assert.equal(
    resolveBrowserProfileDir({
      profileRoot: '/tmp/sessionplane/explicit',
      browser: CHROME,
      scopeByBrowser: false,
    }),
    '/tmp/sessionplane/explicit',
  );
});

test('known Chrome, Chromium, Edge, and Brave personal profiles are rejected', () => {
  const home = '/home/example';
  const roots = personalBrowserProfileRoots({ platform: 'linux', homeDir: home, env: {} });
  assert.ok(roots.some((root) => root.includes('google-chrome')));
  assert.ok(roots.some((root) => root.includes('chromium')));
  assert.ok(roots.some((root) => root.includes('microsoft-edge')));
  assert.ok(roots.some((root) => root.includes('Brave-Browser')));
  for (const root of roots) {
    assert.throws(
      () => assertDedicatedBrowserProfile(path.join(root, 'Default'), {
        platform: 'linux',
        homeDir: home,
        env: {},
      }),
      /personal\/default browser profile/,
    );
  }
  assert.doesNotThrow(() =>
    assertDedicatedBrowserProfile('/home/example/.local/state/sessionplane/profiles/chrome', {
      platform: 'linux',
      homeDir: home,
      env: {},
    }),
  );
});

test(
  'a symlinked profile path cannot point into a personal browser profile',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-profile-symlink-'));
    const home = path.join(root, 'home');
    const personal = path.join(home, '.config', 'google-chrome');
    const linked = path.join(root, 'linked-profile');
    try {
      mkdirSync(personal, { recursive: true });
      symlinkSync(personal, linked, 'dir');
      assert.throws(
        () =>
          assertDedicatedBrowserProfile(path.join(linked, 'Default'), {
            platform: 'linux',
            homeDir: home,
            env: {},
          }),
        /personal\/default browser profile/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('profile identity allows upgrades within one product and rejects cross-product reuse', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-profile-identity-'));
  try {
    ensureProfileBrowserIdentity(root, CHROME, () => new Date(0));
    assert.equal(existsSync(path.join(root, '.sessionplane-browser.json')), true);
    assert.doesNotThrow(() =>
      ensureProfileBrowserIdentity(root, {
        ...CHROME,
        executable: '/usr/bin/google-chrome',
        version: 'Google Chrome 154.0.0.0',
      }),
    );
    assert.throws(
      () =>
        ensureProfileBrowserIdentity(root, {
          executable: '/usr/bin/chromium',
          version: 'Chromium 153.0.0.0',
          source: 'host',
          product: 'chromium',
        }),
      /belongs to chrome/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
