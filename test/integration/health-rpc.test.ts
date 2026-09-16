import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';

test('system.health is served over an owner-only Unix socket and durable SQLite database', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-health-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({
    config,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });

  try {
    const result = await callRpc<Record<string, unknown>>({
      socketPath: config.socketPath,
      method: 'system.health',
      timeoutMs: 2_000,
    });

    assert.equal(result.requestOk, true);
    assert.equal(result.service, 'sessionplane');
    assert.equal((result.database as Record<string, unknown>).schemaVersion, 1);
    assert.equal((result.database as Record<string, unknown>).journalMode, 'wal');
    assert.equal((result.database as Record<string, unknown>).foreignKeys, true);
    assert.equal((result.database as Record<string, unknown>).integrity, 'ok');
    assert.equal(statSync(config.socketPath).mode & 0o777, 0o600);
    assert.equal(statSync(config.databasePath).mode & 0o777, 0o600);

    await assert.rejects(
      startCore({ config }),
      /already listening/,
      'a second core must fail closed instead of stealing the socket',
    );
  } finally {
    await service.close();
    assert.equal(existsSync(config.socketPath), false);
    rmSync(root, { recursive: true, force: true });
  }
});

