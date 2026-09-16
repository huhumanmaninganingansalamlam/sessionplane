import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

test('BrowserOwner owns one dedicated persistent profile and fails closed for a second owner', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-owner-'));
  const profileDir = path.join(root, 'profile');
  const first = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
  });
  const second = new BrowserOwner({
    profileDir,
    pageRegistry: new PageRegistry(),
    headless: true,
  });

  try {
    await first.start();
    assert.equal(first.status.state, 'ready');
    const lockPath = path.join(profileDir, '.sessionplane-profile.lock');
    assert.equal(existsSync(lockPath), true);
    assert.equal(statSync(lockPath).mode & 0o777, 0o600);

    await assert.rejects(second.start(), /already owned/);
  } finally {
    await second.close();
    await first.close();
    assert.equal(existsSync(path.join(profileDir, '.sessionplane-profile.lock')), false);
    rmSync(root, { recursive: true, force: true });
  }
});

