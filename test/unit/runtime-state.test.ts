import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('the public sessplane entrypoint installs the stable state default', () => {
  const entrypoint = 'bin/sessplane.mjs';
  const source = readFileSync(path.resolve(entrypoint), 'utf8');
  assert.match(source, /ensureSessionPlaneStateDir\(\)/, entrypoint);
});

test('direct core execution pins the same canonical runtime state', () => {
  const source = readFileSync(path.resolve('src/main.ts'), 'utf8');
  assert.match(source, /path\.join\(homedir\(\), '\.local', 'state', 'sessionplane'\)/);
  assert.match(source, /serveForever\(config\)/);
});
