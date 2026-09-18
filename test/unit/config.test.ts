import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { prepareRuntimeDirectories, resolveConfig } from '../../src/config.ts';

test('resolveConfig anchors runtime paths under an explicit state directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-config-'));
  try {
    const config = resolveConfig({
      cwd: root,
      env: {},
      stateDir: 'runtime',
    });

    assert.equal(config.stateDir, path.join(root, 'runtime'));
    assert.equal(config.socketPath, path.join(root, 'runtime', 'sessionplane.sock'));
    assert.equal(config.databasePath, path.join(root, 'runtime', 'sessionplane.sqlite'));
    assert.equal(config.profileDir, path.join(root, 'runtime', 'profiles'));
    assert.equal(config.browserScopedProfile, true);
    assert.equal(config.artifactDir, path.join(root, 'runtime', 'artifacts'));
    assert.equal(config.browserHeadless, false);
    assert.equal(config.browserPreference, 'auto');
    assert.equal(config.browserExecutable, null);
    assert.equal(config.observationActiveSweepMs, 5_000);
    assert.equal(config.observationQuietSweepMs, 15_000);
    assert.equal(config.observationQuietWindowMs, 1_500);
    assert.equal(config.backendRecoveryAfterMs, 30_000);
    assert.equal(config.backendRequestTimeoutMs, 15_000);
    assert.equal(config.probeSuccessIntervalMs, 30_000);
    assert.equal(config.probeMin429BackoffMs, 60_000);
    assert.equal(config.probeMax429BackoffMs, 15 * 60_000);
    assert.equal(config.tokenCacheTtlMs, 60_000);
    assert.equal(config.maxUploadFileBytes, 100 * 1024 * 1024);
    assert.equal(config.fetchTimeoutMs, 15_000);
    assert.equal(config.fetchMaxBytes, 5 * 1024 * 1024);
    assert.equal(config.fetchMaxRedirects, 5);
    assert.equal(config.fetchAllowPrivateNetworks, false);
    assert.equal(config.searchMaxCandidates, 10);
    assert.equal(config.chatgptUrl, 'https://chatgpt.com/');
    assert.equal(config.geminiUrl, 'https://gemini.google.com/app');
    assert.equal(config.grokUrl, 'https://grok.com/');

    prepareRuntimeDirectories(config);
    assert.equal(statSync(config.stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(config.profileDir).mode & 0o777, 0o700);
    assert.equal(statSync(config.artifactDir).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfig rejects invalid environment values', () => {
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_RPC_TIMEOUT_MS: 'zero' } }),
    /positive integer/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_LOG_LEVEL: 'verbose' } }),
    /must be one of/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_MAX_ARTIFACT_FILE_BYTES: '0' } }),
    /positive integer/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_OBSERVATION_ACTIVE_SWEEP_MS: '0' } }),
    /positive integer/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_MAX_UPLOAD_FILE_BYTES: '0' } }),
    /positive integer/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_GEMINI_URL: 'https://example.com/' } }),
    /provider URL/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_BROWSER_HEADLESS: 'sometimes' } }),
    /must be a boolean/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_BROWSER: 'firefox' } }),
    /must be one of/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_BROWSER: 'custom' } }),
    /requires SESSIONPLANE_BROWSER_EXECUTABLE/,
  );
  assert.throws(
    () =>
      resolveConfig({
        env: {
          SESSIONPLANE_BROWSER: 'chrome',
          SESSIONPLANE_BROWSER_EXECUTABLE: '/tmp/browser',
        },
      }),
    /can be combined only/,
  );
});

test('resolveConfig accepts explicit browser headless environment control', () => {
  assert.equal(resolveConfig({ env: { SESSIONPLANE_BROWSER_HEADLESS: '1' } }).browserHeadless, true);
  assert.equal(
    resolveConfig({ env: { SESSIONPLANE_BROWSER_HEADLESS: 'false' } }).browserHeadless,
    false,
  );
});

test('resolveConfig accepts explicit host browser selection and executable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-config-'));
  try {
    const selected = resolveConfig({
      cwd: root,
      env: {
        SESSIONPLANE_BROWSER: 'custom',
        SESSIONPLANE_BROWSER_EXECUTABLE: './browser-bin',
        SESSIONPLANE_PROFILE_DIR: './explicit-profile',
      },
    });
    assert.equal(selected.browserPreference, 'custom');
    assert.equal(selected.browserExecutable, path.join(root, 'browser-bin'));
    assert.equal(selected.profileDir, path.join(root, '.state', 'explicit-profile'));
    assert.equal(selected.browserScopedProfile, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
