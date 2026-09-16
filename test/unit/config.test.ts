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
});

