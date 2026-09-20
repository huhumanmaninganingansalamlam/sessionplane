import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('CI verifies the clean GitHub checkout on the supported Node 24 runtime', () => {
  const workflow = readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /node-version: 24\.21\.0/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  for (const command of [
    'npm ci',
    'npm audit --audit-level=high',
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
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /verify:[\s\S]*permissions:\s*\n\s*contents: read/);
  assert.match(
    workflow,
    /publish:[\s\S]*needs: verify[\s\S]*contents: write[\s\S]*id-token: write[\s\S]*attestations: write[\s\S]*artifact-metadata: write/,
  );
  assert.match(workflow, /git fetch origin main --no-tags/);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$\(git rev-parse origin\/main\)"/);
  assert.match(workflow, /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/);
  assert.match(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci --ignore-scripts/);
  for (const command of [
    'npm ci',
    'npm audit --audit-level=high',
    'npm run typecheck',
    'npm run test:ci',
    'npm run build',
    'npm run doctor',
    'npm run test:package',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(/[.*+?^$()|[\]{}\\]/g, '\\$&')));
  }
  assert.match(workflow, /::error title=npm test failed::/);
  assert.match(workflow, /npm pack --silent/);
  assert.match(workflow, /--pack-destination "\$RUNNER_TEMP\/repro-pack"/);
  assert.match(workflow, /cmp "\$package" "\$RUNNER_TEMP\/repro-pack\/\$repro_package"/);
  assert.match(workflow, /sha256sum "\$package"/);
  assert.match(workflow, /test ! -e "\$prefix\/bin\/agbrowse"/);
  assert.match(workflow, /sessplane" doctor --json/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
  assert.match(workflow, /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/);
  assert.match(workflow, /sha256sum -c/);
  assert.match(workflow, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
  assert.doesNotMatch(workflow, /^\s*\+\s+/m);
});

test('release preflight gates a clean main checkout with full host-browser verification', () => {
  const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  assert.equal(packageJson.scripts?.['release:preflight'], 'node scripts/release-preflight.mjs');

  const source = readFileSync(path.resolve('scripts/release-preflight.mjs'), 'utf8');
  for (const expected of [
    'process.versions.node',
    'git status --porcelain',
    'git branch --show-current',
    'git fetch origin main --quiet',
    'git rev-parse HEAD',
    'git rev-parse origin/main',
    'npm audit --audit-level=high',
    'npm run verify:clean',
    'npm pack --silent',
    'sha256',
  ]) {
    assert.match(source, new RegExp(expected.replaceAll(/[.*+?^$()|[\]{}\\]/g, '\\$&')));
  }

  const cleanGate = readFileSync(path.resolve('scripts/clean-checkout-gate.mjs'), 'utf8');
  assert.match(cleanGate, /npm['"], \['ci', '--ignore-scripts'\]/);
});
