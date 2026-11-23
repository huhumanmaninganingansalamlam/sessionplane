import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PageRegistry } from '../../src/browser/page-registry.ts';
import { BrowserOwnerState } from '../../src/browser/browser-owner-state.ts';
import { browserOwnerStatus } from '../../src/browser/browser-owner-status.ts';

test('process, profile, pages, native groups, login and download have distinct owner state', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-owner-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pages = new PageRegistry();
  const now = new Date('2026-11-23T08:00:00Z');
  const owner = new BrowserOwnerState({
    profileDir: root, pageRegistry: pages, now: () => now,
    browserPreference: 'chrome', headless: true, pid: 1234,
  });
  assert.deepEqual(Object.keys(owner).sort(),
    ['downloads', 'groups', 'login', 'pages', 'process', 'profile']);
  assert.equal(owner.profile.profileDir, root);
  assert.equal(owner.profile.lockPath, path.join(root, '.sessionplane-profile.lock'));
  assert.equal(owner.profile.lockToken, null);
  assert.equal(owner.process.pid, 1234);
  assert.equal(owner.process.now(), now);
  assert.equal(owner.process.browser, null);
  assert.equal(owner.process.browserProcess, null);
  assert.equal(owner.pages.pageRegistry, pages);
  assert.equal(owner.pages.recoveryControllers.size, 0);
  assert.equal(owner.groups.groupsStatus.state, 'not-started');
  assert.equal(owner.login.manualLoginUrl, null);
  assert.equal(owner.downloads.downloadControl, null);
  assert.equal(browserOwnerStatus(owner).teamTabGroups.state, 'not-started');
  assert.equal(browserOwnerStatus(owner).ownership, null);
  assert.equal(browserOwnerStatus(owner).state, 'not_started');
  assert.equal(owner.process.browser, null,
    'offline process/profile tests must not create Chrome or an extra CDP owner');
});
