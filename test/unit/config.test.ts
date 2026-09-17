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
    assert.equal(config.profileDir, path.join(root, 'runtime', 'chrome-profile'));
    assert.equal(config.browserHeadless, false);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveConfig rejects invalid numeric and log-level environment values', () => {
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_RPC_TIMEOUT_MS: 'zero' } }),
    /positive integer/,
  );
  assert.throws(
    () => resolveConfig({ env: { SESSIONPLANE_LOG_LEVEL: 'verbose' } }),
    /must be one of/,
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
});

test('resolveConfig accepts explicit browser headless environment control', () => {
  assert.equal(resolveConfig({ env: { SESSIONPLANE_BROWSER_HEADLESS: '1' } }).browserHeadless, true);
  assert.equal(
    resolveConfig({ env: { SESSIONPLANE_BROWSER_HEADLESS: 'false' } }).browserHeadless,
    false,
  );
});

