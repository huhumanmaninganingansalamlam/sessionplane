import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findHostBrowser,
  listHostBrowsers,
} from '../../src/browser/browser-health.ts';

test('auto browser discovery uses only host executables and prefers Chromium', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-host-browsers-'));
  try {
    fakeBrowser(root, 'chromium', 'Chromium 152.0.0.0');
    fakeBrowser(root, 'google-chrome', 'Google Chrome 153.0.0.0');
    const env = { PATH: root, HOME: root };

    const browsers = listHostBrowsers({ env, platform: 'linux', includePlatformDefaults: false });
    assert.deepEqual(
      browsers.map((browser) => browser.product),
      ['chromium', 'chrome'],
    );
    assert.equal(findHostBrowser({ env, platform: 'linux', includePlatformDefaults: false })?.product, 'chromium');
    assert.ok(browsers.every((browser) => browser.source === 'host'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Chromium discovery accepts the Flatpak exported launcher name', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-flatpak-chromium-'));
  try {
    fakeBrowser(root, 'org.chromium.Chromium', 'Chromium 153.0.0.0');
    const selected = findHostBrowser({
      env: { PATH: root, HOME: root },
      platform: 'linux',
      preference: 'chromium',
      includePlatformDefaults: false,
    });
    assert.equal(selected?.product, 'chromium');
    assert.equal(selected?.version, 'Chromium 153.0.0.0');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit host browser selection never falls back to another product', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-choice-'));
  try {
    fakeBrowser(root, 'google-chrome', 'Google Chrome 153.0.0.0');
    const env = { PATH: root, HOME: root };

    assert.equal(
      findHostBrowser({ env, platform: 'linux', preference: 'chromium', includePlatformDefaults: false }),
      null,
    );
    assert.equal(
      findHostBrowser({ env, platform: 'linux', preference: 'chrome', includePlatformDefaults: false })?.product,
      'chrome',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit custom executable is accepted without searching PATH', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-custom-browser-'));
  try {
    const executable = fakeBrowser(root, 'my-browser', 'Brave Browser 1.99.0');
    const selected = findHostBrowser({
      env: { PATH: '', HOME: root },
      platform: 'linux',
      preference: 'custom',
      executablePath: executable,
    });
    assert.equal(selected?.product, 'brave');
    assert.equal(selected?.executable, executable);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Playwright-managed Chrome for Testing is rejected as a host browser', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cft-browser-'));
  try {
    const managedRoot = path.join(root, 'ms-playwright', 'chromium-1');
    const executable = fakeBrowser(managedRoot, 'chrome', 'Google Chrome for Testing 153.0.0.0');
    assert.equal(
      findHostBrowser({
        env: { PATH: managedRoot, HOME: root },
        platform: 'linux',
        preference: 'custom',
        executablePath: executable,
      }),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeBrowser(root: string, name: string, version: string): string {
  mkdirSync(root, { recursive: true });
  const executable = path.join(root, name);
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  chmodSync(executable, 0o755);
  return executable;
}
