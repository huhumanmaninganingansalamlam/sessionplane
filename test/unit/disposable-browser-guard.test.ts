import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { candidateDisposableBrowserCommand, candidateDisposableChrome } from '../../scripts/disposable-browser-guard.mjs';

const token = 'exact-candidate-token';
const disposable = path.join(tmpdir(), 'sessionplane-b-semantic-012abc', 'disposable-profile');
const base = {
  pid: 340001,
  processGroup: 340001,
  argv: ['/opt/google/chrome/chrome', '--headless=new', `--user-data-dir=${disposable}`],
  executable: '/opt/google/chrome/chrome',
  environment: [`SESSIONPLANE_CANDIDATE_GATE_TOKEN=${token}`],
  uid: process.getuid?.(),
  expectedUid: process.getuid?.(),
  gateToken: token,
};

test('candidate gate classifies only exact headless disposable Chrome master', () => {
  assert.deepEqual(candidateDisposableChrome(base), {
    pid: base.pid, profile: disposable,
  });
  for (const change of [
    { processGroup: base.pid + 1 },
    { executable: '/usr/bin/node' },
    { argv: [...base.argv, '--type=renderer'] },
    { argv: [base.argv[0], base.argv[2]] },
    { argv: [base.argv[0], '--headless=new',
      '--user-data-dir=/home/user/.local/state/sessionplane/profiles/chrome'] },
    { argv: [base.argv[0], '--headless=new',
      `--user-data-dir=${path.join(tmpdir(), 'sessionplane-b-semantic-012abc', 'credentials')}`] },
    { environment: ['SESSIONPLANE_CANDIDATE_GATE_TOKEN=another-gate'] },
    { gateToken: 'wrong-gate' },
    { uid: (base.uid ?? 0) + 1 },
    { pid: 0 },
  ]) {
    assert.equal(candidateDisposableChrome({ ...base, ...change }), null);
  }
});

test('candidate gate permits disposable test profile but never user browser', () => {
  const root = path.join(tmpdir(), 'sessionplane-fixture-1223');
  assert.deepEqual(candidateDisposableChrome({
    ...base,
    argv: [base.argv[0], '--headless', `--user-data-dir=${root}/profile`],
  }), { pid: base.pid, profile: `${root}/profile` });
});

test('unique candidate temp root identifies Chrome even when Chrome erases its environment and argv separators', () => {
  const gateRoot = path.join(tmpdir(), 'sessionplane-gate-123');
  const profile = path.join(gateRoot, 'sessionplane-b-semantic-456', 'disposable-profile');
  const params = {
    ...base, gateRoot, environment: [],
    argv: [`/opt/google/chrome/chrome --user-data-dir=${profile} --headless=new about:blank`],
  };
  assert.deepEqual(candidateDisposableChrome(params), { pid: base.pid, profile });
  assert.equal(candidateDisposableChrome({ ...params, gateRoot: path.join(tmpdir(), 'other-gate') }), null);
});

test('macOS process listing uses the same unique gate-root ownership boundary', () => {
  const gateRoot = path.join(tmpdir(), 'sessionplane-gate-mac');
  const profile = path.join(gateRoot, 'sessionplane-browser-guard-92', 'disposable-profile');
  const commandline = `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --user-data-dir=${profile}`;
  const params = { pid: 4200, processGroup: 4200, uid: 501, expectedUid: 501,
    commandline, gateRoot };
  assert.deepEqual(candidateDisposableBrowserCommand(params), { pid: 4200, profile });
  assert.equal(candidateDisposableBrowserCommand({ ...params,
    commandline: commandline.replace('--headless=new ', '') }), null);
  assert.equal(candidateDisposableBrowserCommand({ ...params,
    commandline: commandline.replace(profile, '/Users/person/Library/Application Support/Google/Chrome') }), null);
  assert.equal(candidateDisposableBrowserCommand({ ...params, processGroup: 4199 }), null);
});
