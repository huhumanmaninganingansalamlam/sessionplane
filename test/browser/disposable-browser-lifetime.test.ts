import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { runIsolatedCandidateCommand } from '../../scripts/candidate-gate-process.mjs';

test('a crashed test controller cannot leave a detached disposable Chrome behind', {
  timeout: 55_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-guard-'));
  const browserOwner = pathToFileURL(fileURLToPath(new URL('../../src/browser/browser-owner.ts', import.meta.url))).href;
  const pageRegistry = pathToFileURL(fileURLToPath(new URL('../../src/browser/page-registry.ts', import.meta.url))).href;

  const script = `
    import { BrowserOwner } from ${JSON.stringify(browserOwner)};
    import { PageRegistry } from ${JSON.stringify(pageRegistry)};
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    const ownedRoot = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-guard-'));
    const owner = new BrowserOwner({
      profileDir: path.join(ownedRoot, 'disposable-profile'),
      pageRegistry: new PageRegistry(), headless: true,
    });
    await owner.start();
    process.stdout.write('DISPOSABLE_PID=' + owner.status.browserPid + '\\n');
    process.exit(0); // Deliberately bypasses owner.close(), simulating a killed worker.
  `;
  try {
    const response = await runIsolatedCandidateCommand(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      { cwd: root, env: process.env,
        timeoutMs: 40_000 },
    );
    assert.match(response.stdout, /DISPOSABLE_PID=\d+/);
    assert.equal(response.errorCode, 'EDISPOSABLECHROME', JSON.stringify(response));
    assert.match(response.error ?? '', /disposable Chrome process groups; 0 could not be stopped/);
    const pid = Number(/DISPOSABLE_PID=(\d+)/.exec(response.stdout)?.[1]);
    if (process.platform === 'linux') {
      assert.equal(Number.isInteger(pid), true);
      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(`/proc/${pid}`), false,
        'Candidate must not leak its disposable Chrome master');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
