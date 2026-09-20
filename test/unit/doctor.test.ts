import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findRetiredAgbrowseExecutable } from '../../src/cli/commands/doctor.ts';

test('doctor detects a retired agbrowse executable on PATH', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-doctor-agbrowse-'));
  try {
    const executable = path.join(root, 'agbrowse');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(executable, 0o755);

    assert.equal(findRetiredAgbrowseExecutable(root), executable);
    assert.equal(
      findRetiredAgbrowseExecutable(path.join(root, 'missing')),
      null,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
