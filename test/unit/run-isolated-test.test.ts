import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('../../scripts/run-isolated-test.mjs', import.meta.url));

test('nested test command reuses the exact parent gate root without another path level', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-gate-parent-'));
  try {
    const result = spawnSync(process.execPath, [runner, '--timeout-ms=5000', '--',
      '-e', 'process.stdout.write(process.env.TMPDIR ?? "")'], {
      encoding: 'utf8', env: { ...process.env,
        SESSIONPLANE_CANDIDATE_GATE_TOKEN: 'parent-token',
        SESSIONPLANE_CANDIDATE_GATE_ROOT: root,
        TMPDIR: root, TMP: root, TEMP: root,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, root);
    assert.equal(existsSync(root), true,
      'the parent supervisor, not a nested runner, owns the shared root');
    assert.equal(existsSync(path.join(root, 'sessionplane-gate-')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an untrusted environment cannot claim a parent gate with mismatched TMPDIR', () => {
  const claimed = path.join(tmpdir(), 'sessionplane-gate-claimed');
  const result = spawnSync(process.execPath, [runner, '--timeout-ms=5000', '--',
    '-e', 'process.stdout.write(process.env.TMPDIR ?? "")'], {
    encoding: 'utf8', env: { ...process.env,
      SESSIONPLANE_CANDIDATE_GATE_TOKEN: 'token',
      SESSIONPLANE_CANDIDATE_GATE_ROOT: claimed,
      TMPDIR: tmpdir(),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /sessionplane-gate-/);
  assert.notEqual(result.stdout, claimed);
  assert.equal(existsSync(result.stdout), false);
});
