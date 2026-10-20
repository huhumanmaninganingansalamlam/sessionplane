import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserOwner, buildManualLoginArguments } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { pruneBrowserMetrics } from '../../src/browser/browser-metrics.ts';

test('default Chromium launches suppress persistent histograms across restarts; opt-in records with bounded retired retention', { skip: process.platform === 'linux' && !process.env.DISPLAY }, async () => {
  const profileDir = mkdtempSync(path.join(tmpdir(), 'sessionplane-browsermetrics-'));
  const metrics = path.join(profileDir, 'BrowserMetrics');
  mkdirSync(metrics);
  writeFileSync(path.join(profileDir, 'BrowserMetrics-spare.pma'), Buffer.alloc(4 * 1024 * 1024));
  const files = () => statSync(metrics).isDirectory() ? readdirSync(metrics).filter(name => name.endsWith('.pma')) : [];
  let owner: BrowserOwner | undefined;
  try {
    owner = new BrowserOwner({ profileDir, pageRegistry: new PageRegistry(), headless: false, persistentMetrics: true });
    await owner.start();
    assert.ok(files().length > 0, 'The opt-in launch reproduces Chromium mapped histogram generation');
    await owner.close();
    for (let run = 0; run < 2; run++) {
      owner = new BrowserOwner({ profileDir, pageRegistry: new PageRegistry(), headless: false });
      await owner.start();
      assert.equal(files().length, 0, JSON.stringify({ files: files(), pid: owner.status.browserPid, run }));
      await owner.close();
      assert.equal(files().length, 0, 'Repeated normal shutdown does not accumulate histograms');
    }
    assert.ok(buildManualLoginArguments({ profileDir, loginUrl: 'https://chatgpt.com/' })
      .includes('--disable-features=PersistentHistograms'));
    // Opt-in restores the owned storage after default mode, without touching auth.
    owner = new BrowserOwner({ profileDir, pageRegistry: new PageRegistry(), headless: false, persistentMetrics: true });
    await owner.start();
    assert.ok(files().length > 0);
    await owner.close();
    pruneBrowserMetrics(profileDir, false);
    const active = `BrowserMetrics-ABC-${process.pid.toString(16)}.pma`;
    writeFileSync(path.join(metrics, active), 'active');
    for (let i = 0; i < 70; i++) writeFileSync(path.join(metrics, `BrowserMetrics-${(i + 1).toString(16)}-7FFFFFFF.pma`), 'retired');
    const old = path.join(metrics, 'BrowserMetrics-FFFF-7FFFFFFF.pma');
    writeFileSync(old, 'old');
    utimesSync(old, 0, 0);
    writeFileSync(path.join(profileDir, 'Cookies'), 'preserve authentication');
    pruneBrowserMetrics(profileDir, true);
    assert.equal(files().length, 65, 'At most 64 recent retired files plus the live process file');
    pruneBrowserMetrics(profileDir, false);
    assert.deepEqual(files(), [active], 'Never delete a live file, even when recording is off');
    assert.equal(readdirSync(profileDir).includes('Cookies'), true);
  } finally { await owner?.close(); rmSync(profileDir, { recursive: true, force: true }); }
});
