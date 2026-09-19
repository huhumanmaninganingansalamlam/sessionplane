import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { ensureSessionPlaneStateDir } from '../../bin/runtime-state.mjs';

test('global bins choose one user-scoped state directory independent of cwd', () => {
  const env: Record<string, string | undefined> = {};
  const expected = path.join('/home/example', '.local', 'state', 'sessionplane');
  assert.equal(ensureSessionPlaneStateDir(env, '/home/example'), expected);
  assert.equal(env.SESSIONPLANE_STATE_DIR, expected);

  const xdgEnv: Record<string, string | undefined> = {
    XDG_STATE_HOME: '/var/lib/user-state',
  };
  assert.equal(
    ensureSessionPlaneStateDir(xdgEnv, '/home/example'),
    '/var/lib/user-state/sessionplane',
  );

  const explicitEnv: Record<string, string | undefined> = {
    SESSIONPLANE_STATE_DIR: '/srv/sessionplane-state',
    XDG_STATE_HOME: '/ignored',
  };
  assert.equal(
    ensureSessionPlaneStateDir(explicitEnv, '/home/example'),
    '/srv/sessionplane-state',
  );
});

test('the public sessplane entrypoint installs the stable state default', () => {
  const entrypoint = 'bin/sessplane.mjs';
  const source = readFileSync(path.resolve(entrypoint), 'utf8');
  assert.match(source, /ensureSessionPlaneStateDir\(\)/, entrypoint);
});
