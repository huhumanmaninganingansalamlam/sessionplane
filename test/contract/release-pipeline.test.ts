import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('CI verifies clean checkout on the supported Node 24 runtime', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /node-version: 24\.21\.0/);
  assert.match(workflow, /npm run verify:clean/);
});

test('tagged releases verify, pack, smoke test, checksum, and publish artifacts', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /tags:[\s\S]*'v\*\.\*\.\*'/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /npm run verify:clean/);
  assert.match(workflow, /npm pack --silent/);
  assert.match(workflow, /sha256sum "\$package"/);
  assert.match(workflow, /test ! -e "\$prefix\/bin\/agbrowse"/);
  assert.match(workflow, /sessplane" doctor --json/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
  assert.doesNotMatch(workflow, /^\s*\+\s+/m);
});
