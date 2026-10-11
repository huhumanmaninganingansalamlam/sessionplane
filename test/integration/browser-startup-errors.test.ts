import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner, BrowserOwnerError } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { normalizeCliError } from '../../src/cli/format.ts';

test('headed startup exposes the original display failure without changing profile or retrying it', {
  skip: process.platform === 'win32',
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-launch-error-'));
  const executable = path.join(root, 'chrome');
  const attempts = path.join(root, 'attempts');
  const profile = path.join(root, 'profile');
  // This executable only models Chrome's version probe and startup failure.
  // It never starts a browser, changes the caller environment or accesses a live profile.
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Google Chrome 154.0.8037.97'; exit 0; fi
echo attempt >> '${attempts}'
echo 'Missing X server or $DISPLAY' >&2
exit 1
`, { mode: 0o700 });
  const owner = new BrowserOwner({ profileDir: profile, pageRegistry: new PageRegistry(),
    browserPreference: 'custom', browserExecutable: executable, launchTimeoutMs: 1000 });
  try {
    let failure: unknown;
    try { await owner.start(); } catch (error) { failure = error; }
    assert.ok(failure instanceof BrowserOwnerError);
    assert.equal(owner.status.state, 'error');
    assert.equal(owner.status.browserPid, null);
    assert.equal(owner.status.headless, false);
    assert.equal(owner.status.profileDir, profile);
    assert.match(owner.status.lastError!, /Missing X server or \$DISPLAY/);
    assert.match(failure.message, /Missing X server or \$DISPLAY/);
    const reported = normalizeCliError(failure);
    assert.equal(reported.errorCode, 'browser.unavailable');
    assert.match(reported.message, /Missing X server or \$DISPLAY/);
    assert.equal(readFileSync(attempts, 'utf8'), 'attempt\n');
    assert.equal(existsSync(path.join(profile, '.sessionplane-profile.lock')), false);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI preserves browser ownership errors without exposing arbitrary cause objects', () => {
  const failure = new BrowserOwnerError('browser.profile-in-use', 'Profile is owned by another live core',
    { cause: { secret: 'must-not-serialize' } });
  assert.deepEqual(normalizeCliError(failure), { requestOk: false,
    errorCode: 'browser.profile-in-use', message: 'Profile is owned by another live core' });
  assert.equal(normalizeCliError(new Error('Invalid flag')).errorCode, 'input.invalid');
});
