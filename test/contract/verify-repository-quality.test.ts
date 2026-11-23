import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runRepositoryQualityChecks, collectQualityEvidence,
  assertNoTemporaryQualityCeilings, assertCurrentAuthorityIdentity,
  assertReleaseGateManifestConsistency,
} from '../../scripts/verify-repository-quality.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'),'utf8')).version;

test('final read-only repository gate has zero temporary ceilings and exact release owners', () => {
  const result = runRepositoryQualityChecks(root);
  assert.equal(result.sourceFiles > 100, true);
  assert.ok(result.maxFileLogicalLines <= 600);
  assert.ok(result.maxDeclarationLogicalLines <= 150);
  assert.equal(result.releaseGates, 9);
  assert.equal(result.acceptanceOwners, 33);
  assert.equal(result.distinctTests >= 55, true);
  assert.equal(result.version, version);
  assert.deepEqual(collectQualityEvidence(root), result);
  assert.equal(assertReleaseGateManifestConsistency(root).gates, result.releaseGates);
  assert.doesNotThrow(() => assertNoTemporaryQualityCeilings());
});

test('temporary size exceptions cannot silently reappear', () => {
  assert.throws(() =>
    assertNoTemporaryQualityCeilings({'browser/ref-snapshot.ts': 900},root),
  /Temporary source-quality ceilings remain/);
});

test('release identity rejects a divergent lock or README in an isolated fixture', t => {
  const fixture = mkdtempSync(path.join(tmpdir(),'sessionplane-repository-quality-'));
  t.after(() => rmSync(fixture,{recursive:true,force:true}));
  mkdirSync(path.join(fixture,'docs'));
  writeFileSync(path.join(fixture,'package.json'),
    JSON.stringify({name:'sessionplane',version}));
  writeFileSync(path.join(fixture,'package-lock.json'),
    JSON.stringify({name:'sessionplane',version:'0.0.0',
      packages:{'':{name:'sessionplane',version:'0.0.0'}}}));
  writeFileSync(path.join(fixture,'README.md'),'VERSION=' + version + '\n');
  writeFileSync(path.join(fixture,'docs/PRD.md'),'# Product\n');
  writeFileSync(path.join(fixture,'CONTRIBUTING.md'),'# Contributing\n');
  assert.throws(() => assertCurrentAuthorityIdentity(fixture),
    /Package-lock identity differs/);
  writeFileSync(path.join(fixture,'package-lock.json'),
    JSON.stringify({name:'sessionplane',version,
      packages:{'':{name:'sessionplane',version}}}));
  writeFileSync(path.join(fixture,'README.md'),'VERSION=0.0.0\n');
  assert.throws(() => assertCurrentAuthorityIdentity(fixture),
    /README release version differs/);
  writeFileSync(path.join(fixture,'README.md'),'VERSION=' + version + '\n');
  assert.equal(assertCurrentAuthorityIdentity(fixture).documents,3);
});
