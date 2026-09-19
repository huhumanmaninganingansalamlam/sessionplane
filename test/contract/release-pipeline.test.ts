import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('CI verifies the clean GitHub checkout on the supported Node 24 runtime', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /node-version: 24\.21\.0/);
  for (const command of [
    'npm ci',
    'npm run typecheck',
    'npm run test:ci',
    'npm run build',
    'npm run doctor',
    'npm run test:package',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(/[.*+?^$()|[\]{}\\]/g, '\\$&')));
  }
  assert.match(workflow, /::error title=npm test failed::/);
});

test('tagged releases verify, pack, smoke test, checksum, and publish artifacts', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/release.yml'), 'utf8');
  assert.match(workflow, /tags:[\s\S]*'v\*\.\*\.\*'/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  for (const command of [
    'npm ci',
    'npm run typecheck',
    'npm run test:ci',
    'npm run build',
    'npm run doctor',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(/[.*+?^$()|[\]{}\\]/g, '\\$&')));
  }
  assert.match(workflow, /::error title=npm test failed::/);
  assert.match(workflow, /npm pack --silent/);
  assert.match(workflow, /sha256sum "\$package"/);
  assert.match(workflow, /test ! -e "\$prefix\/bin\/agbrowse"/);
  assert.match(workflow, /sessplane" doctor --json/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
  assert.doesNotMatch(workflow, /^\s*\+\s+/m);
});
