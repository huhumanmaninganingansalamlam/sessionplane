import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('offline handover guards preserve exact identities and reject unsafe transitions', () => {
  const check = fileURLToPath(new URL('../ops/test_handover.py', import.meta.url));
  const result = spawnSync('python3', [check], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
