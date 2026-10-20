import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner, BrowserOwnerError } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { findHostBrowser } from '../../src/browser/browser-health.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import { callRpc } from '../../src/cli/client.ts';
import { setTimeout as delay } from 'node:timers/promises';
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


test('disconnect recovery does not relaunch a failed browser every five seconds; explicit recovery resumes the same requests', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-recovery-launch-'));
  const executable = path.join(root, 'chrome');
  const fail = path.join(root, 'fail');
  const attempts = path.join(root, 'attempts');
  const actual = findHostBrowser()!;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Google Chrome 154.0.8037.97'; exit 0; fi
if [ -f ${quote(fail)} ]; then echo attempt >> ${quote(attempts)}; echo 'Missing X server or $DISPLAY' >&2; exit 1; fi
exec ${quote(actual.executable)} "$@"
`, { mode: 0o700 });
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', browserPreference: 'custom', browserExecutable: executable });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake], logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'fixture-owner' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await core.submissionService.send({ clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId, prompt: 'Preserve original work', sessionDeadlineSec: 600 });
    core.observationService.stop(session.sessionId, 1);
    const before = core.teamDirectory.getSession(session.sessionId);
    const outbox = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(session.sessionId);
    writeFileSync(fail, 'fail launch');
    process.kill(core.browserOwner!.status.browserPid!, 'SIGTERM');
    const deadline = Date.now() + 15_000;
    while (core.browserOwner!.status.state !== 'error' && Date.now() < deadline) await delay(100);
    assert.equal(core.browserOwner!.status.state, 'error');
    await delay(10_500); // More than two real automatic recovery ticks.
    assert.equal(readFileSync(attempts, 'utf8'), 'attempt\n');
    assert.match(core.browserOwner!.status.lastError!, /Missing X server/);
    assert.equal(core.teamDirectory.getSession(session.sessionId).generation, before.generation);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(session.sessionId), outbox);
    rmSync(fail);
    // Existing public login path performs explicit recovery; no private control API.
    const navigationPage = core.browserOwner!.openLoginPage.bind(core.browserOwner!);
    core.browserOwner!.openLoginPage = async () => {
      const { binding } = await core.browserOwner!.createPage();
      return binding; // Isolate ChatGPT navigation from the real launch/recovery path.
    };
    try {
      await callRpc({ socketPath: config.socketPath, method: 'browser.login', params: {}, timeoutMs: 30_000, maxLineBytes: config.rpcMaxLineBytes });
    } finally { core.browserOwner!.openLoginPage = navigationPage; }
    assert.equal(core.browserOwner!.status.state, 'ready');
    assert.equal(core.teamDirectory.getSession(session.sessionId).generation, before.generation);
    assert.equal(fake.submitCount, 1);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
