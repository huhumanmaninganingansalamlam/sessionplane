#!/usr/bin/env node
/** Final repository-quality gate. All checks are read-only and fixture-safe.
 * Source acceptance, the live provider, and release provenance remain separate.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectAuthorityDocuments, readCurrentProductIdentity,
  verifyCurrentVersionClaims, verifyInternalMarkdownLinks,
  assertNoLiveLinksToArchivedTasks, assertNoImplementedContractMarkedPlanned,
} from './verify-doc-authority.mjs';
import {
  COMPOSITION_ROOTS, SOURCE_LAYER_RULES, collectRelativeImports,
  assertSourceArchitecture,
} from './verify-source-architecture.mjs';
import {
  QUALITY_BUDGET, EXISTING_SIZE_CEILINGS, HISTORICAL_STORAGE_PROVIDER_TOKENS,
  measureSourceDeclarations, assertSourceQuality,
} from './verify-source-quality.mjs';
import { REPO_ROOT, RELEASE_GATES, WORKFLOW_GATES,
  validateTestSuiteManifest } from './test-suite-manifest.mjs';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function assertNoTemporaryQualityCeilings(
  ceilings = EXISTING_SIZE_CEILINGS, repoRoot = REPO_ROOT,
) {
  if (Object.keys(ceilings).length !== 0) {
    throw new Error('Temporary source-quality ceilings remain: ' +
      Object.keys(ceilings).join(', '));
  }
  const architecture = readFileSync(path.join(repoRoot,
    'scripts/verify-source-architecture.mjs'), 'utf8');
  const quality = readFileSync(path.join(repoRoot,
    'scripts/verify-source-quality.mjs'), 'utf8');
  const obsolete = [
    'LEGACY_ARCHITECTURE_EDGES', 'EXISTING_DECLARATION_CEILINGS',
    'EXISTING_EMPTY_CATCH_COUNTS', 'EXISTING_DURABLE_JSON_CAST_COUNTS',
    'EXISTING_STORAGE_PROVIDER_TOKENS',
  ];
  for (const token of obsolete) {
    if (architecture.includes(token) || quality.includes(token)) {
      throw new Error('Temporary source exception remains: ' + token);
    }
  }
  if (Object.keys(HISTORICAL_STORAGE_PROVIDER_TOKENS).some(name =>
      !/^storage\/migrations\/\d{4}-[\w-]+\.ts$/.test(name))) {
    throw new Error('Historical provider exception outside immutable migrations');
  }
  if (existsSync(path.join(repoRoot,
    'src/storage/conversation-load-recovery-repository.ts'))) {
    throw new Error('Removed conversation-load recovery repository is still active');
  }
}

export function assertCurrentAuthorityIdentity(repoRoot = REPO_ROOT) {
  const identity = readCurrentProductIdentity(repoRoot);
  const lock = readJson(path.join(repoRoot, 'package-lock.json'));
  const packageFile = readJson(path.join(repoRoot, 'package.json'));
  if (lock.name !== packageFile.name || lock.version !== identity.version ||
      lock.packages?.['']?.name !== packageFile.name ||
      lock.packages?.['']?.version !== identity.version) {
    throw new Error('Package-lock identity differs from package.json');
  }
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const statedVersion = /^VERSION=([^\s]+)$/m.exec(readme)?.[1];
  if (statedVersion !== identity.version) {
    throw new Error('README release version differs from package.json');
  }
  const workspaceRoot = path.resolve(repoRoot, '..');
  const workspaceAvailable = existsSync(path.join(workspaceRoot,
    'docs/architecture/sessionplane-design-map.md'));
  const documents = workspaceAvailable
    ? collectAuthorityDocuments(workspaceRoot)
    : ['docs/PRD.md', 'README.md', 'CONTRIBUTING.md'].map(relativePath => ({
        relativePath,
        absolutePath: path.join(repoRoot, relativePath),
        content: readFileSync(path.join(repoRoot, relativePath), 'utf8'),
        requiresCurrentVersionClaim: false,
      }));
  const issues = [
    ...verifyCurrentVersionClaims(identity, documents),
    ...verifyInternalMarkdownLinks(documents),
    ...assertNoLiveLinksToArchivedTasks(documents),
    ...assertNoImplementedContractMarkedPlanned(documents),
  ];
  if (issues.length) throw new Error('Product authority mismatch:\n' + issues.join('\n'));
  return Object.freeze({ version: identity.version, sourceCommit: identity.sourceCommit,
    workspaceAuthority: workspaceAvailable, documents: documents.length });
}

export function assertReleaseGateManifestConsistency(repoRoot = REPO_ROOT) {
  const result = validateTestSuiteManifest(repoRoot);
  const scripts = readJson(path.join(repoRoot, 'package.json')).scripts;
  if (scripts['verify:repository'] !== 'node scripts/verify-repository-quality.mjs') {
    throw new Error('verify:repository does not execute the final repository gate');
  }
  if (RELEASE_GATES[0]?.name !== 'source-quality' ||
      RELEASE_GATES[0]?.script !== 'verify:repository') {
    throw new Error('Candidate source-quality must execute verify:repository');
  }
  for (const workflow of ['ci', 'release']) {
    if (!WORKFLOW_GATES[workflow]?.includes('verify:repository')) {
      throw new Error('Required repository verification is absent from ' + workflow);
    }
  }
  const clean = readFileSync(path.join(repoRoot,
    'scripts/clean-checkout-gate.mjs'), 'utf8');
  if (!clean.includes("['npm', ['run', 'verify:repository']]")) {
    throw new Error('Clean checkout does not execute repository verification');
  }
  return result;
}

export function collectQualityEvidence(repoRoot = REPO_ROOT) {
  assertNoTemporaryQualityCeilings(EXISTING_SIZE_CEILINGS, repoRoot);
  const identity = assertCurrentAuthorityIdentity(repoRoot);
  const manifest = assertReleaseGateManifestConsistency(repoRoot);
  const sourceRoot = path.join(repoRoot, 'src');
  const source = assertSourceQuality(measureSourceDeclarations(sourceRoot));
  const architecture = assertSourceArchitecture(collectRelativeImports(sourceRoot));
  for (const item of source.files) {
    const content = readFileSync(path.join(sourceRoot, item.file), 'utf8');
    if (/\b(?:build|serialize|write|create)DecisionEnvelopeV1\b/.test(content)) {
      throw new Error('Active v1 Decision writer: ' + item.file);
    }
    if (/TODO remove after refactor/i.test(content)) {
      throw new Error('Temporary runtime TODO remains: ' + item.file);
    }
  }
  return Object.freeze({
    version: identity.version,
    sourceCommit: identity.sourceCommit,
    workspaceAuthority: identity.workspaceAuthority,
    authorityDocuments: identity.documents,
    sourceFiles: source.files.length,
    declarations: source.declarations.length,
    relativeImports: architecture.edges.length,
    maxFileLogicalLines: Math.max(...source.files.map(item => item.lines)),
    maxDeclarationLogicalLines: Math.max(...source.declarations.map(item => item.lines)),
    budgets: QUALITY_BUDGET,
    suites: manifest.suites,
    releaseGates: manifest.gates,
    distinctTests: manifest.tests,
    acceptanceOwners: manifest.acceptance,
    compositionRoots: COMPOSITION_ROOTS.length,
    architectureLayers: Object.keys(SOURCE_LAYER_RULES).length,
  });
}

export function runRepositoryQualityChecks(repoRoot = REPO_ROOT) {
  return collectQualityEvidence(repoRoot);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify({ requestOk: true, gate: 'verify-repository',
      ...runRepositoryQualityChecks() }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
