import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { ensureSessionPlaneStateDir } from '../../bin/runtime-state.mjs';

test('global bin pins one canonical runtime state outside tests', () => {
  const expected = path.join('/home/example', '.local', 'state', 'sessionplane');

  const env: Record<string, string | undefined> = {};
  assert.equal(ensureSessionPlaneStateDir(env, '/home/example', []), expected);
  assert.equal(env.SESSIONPLANE_STATE_DIR, expected);

  const xdgEnv: Record<string, string | undefined> = {
    XDG_STATE_HOME: '/var/lib/user-state',
  };
  assert.equal(ensureSessionPlaneStateDir(xdgEnv, '/home/example', []), expected);
  assert.equal(xdgEnv.SESSIONPLANE_STATE_DIR, expected);

  assert.throws(
    () =>
      ensureSessionPlaneStateDir(
        { SESSIONPLANE_STATE_DIR: '/srv/sessionplane-state' },
        '/home/example',
        [],
      ),
    /one canonical runtime state/,
  );
  assert.throws(
    () =>
      ensureSessionPlaneStateDir(
        {},
        '/home/example',
        ['serve', '--state-dir', '/tmp/isolated-sessionplane'],
      ),
    /Isolated --state-dir runtimes are test-only/,
  );

  const canonicalEnv: Record<string, string | undefined> = {
    SESSIONPLANE_STATE_DIR: expected,
  };
  assert.equal(ensureSessionPlaneStateDir(canonicalEnv, '/home/example', []), expected);

  assert.throws(
    () =>
      ensureSessionPlaneStateDir(
        { NODE_TEST_CONTEXT: 'child-v8', SESSIONPLANE_STATE_DIR: '/srv/sessionplane-test' },
        '/home/example',
        [],
      ),
    /one canonical runtime state/,
  );
});

test('the public entrypoint rejects a different state directory before starting a core', () => {
  const result = spawnSync(process.execPath, ['bin/sessplane.mjs', 'serve', '--state-dir', '/sessionplane-test-other-state'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /one canonical runtime state/);
});
