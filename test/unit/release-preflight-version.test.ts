import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const PREFLIGHT_SOURCE = fileURLToPath(
  new URL('../../scripts/release-preflight.mjs', import.meta.url));

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-version-preflight-'));
  const scripts = path.join(root, 'scripts');
  mkdirSync(scripts);
  mkdirSync(path.join(root, 'dist'));
  const executable = path.join(scripts, 'release-preflight.mjs');
  copyFileSync(PREFLIGHT_SOURCE, executable);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  return (input: {
    packageVersion?: string;
    lockVersion?: string;
    lockRootVersion?: string;
    packageName?: string;
    lockName?: string;
    lockRootName?: string;
    readmeVersion?: string;
  } = {}) => {
    const version = input.packageVersion ?? '0.4.99';
    const name = input.packageName ?? 'sessionplane';
    writeFileSync(path.join(root, 'package.json'),
      JSON.stringify({ name, version }));
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      name: input.lockName ?? name,
      version: input.lockVersion ?? version,
      packages: { '': {
        name: input.lockRootName ?? name,
        version: input.lockRootVersion ?? version,
      } },
    }));
    writeFileSync(path.join(root, 'README.md'),
      'Installation\nVERSION=' + (input.readmeVersion ?? version) + '\n');
    return spawnSync(process.execPath, [executable, '--emit-build-identity'], {
      cwd: root, encoding: 'utf8',
    });
  };
}

test('build identity refuses a divergent lockfile or README version', t => {
  const run = fixture(t);
  assert.equal(run().status, 0, 'a consistent synthetic package may build');
  for (const mismatch of [
    { lockVersion: '0.4.98' },
    { lockRootVersion: '0.4.98' },
    { lockName: 'another-package' },
    { lockRootName: 'another-package' },
  ]) {
    const result = run(mismatch);
    assert.notEqual(result.status, 0,
      'release build must reject drift: ' + JSON.stringify(mismatch));
    assert.match(result.stderr, /package-lock.*package.json/);
  }
  const documentDrift = run({ readmeVersion: '0.4.98' });
  assert.notEqual(documentDrift.status, 0);
  assert.match(documentDrift.stderr, /documented release install version/);
});
