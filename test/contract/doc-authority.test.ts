import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertNoImplementedContractMarkedPlanned,
  assertNoLiveLinksToArchivedTasks,
  collectAuthorityDocuments,
  readCurrentProductIdentity,
  verifyCurrentVersionClaims,
  verifyInternalMarkdownLinks,
} from '../../scripts/verify-doc-authority.mjs';

const authorityPaths = [
  'docs/PRD.md',
  'docs/README.md',
  'docs/architecture/sessionplane-design-map.md',
  'docs/architecture/overview.md',
  'docs/specs/sessionplane-product-requirements.md',
  'docs/specs/sessionplane-interface-contracts.md',
  'docs/specs/sessionplane-acceptance.md',
  'repos/docs/PRD.md',
  'repos/README.md',
  'repos/CONTRIBUTING.md',
];

function put(root: string, relativePath: string, content: string): void {
  const absolutePath = path.join(root, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');
}

function createFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-doc-authority-'));
  put(root, 'repos/package.json', JSON.stringify({ name: 'sessionplane', version: '0.4.111' }));
  put(root, 'docs/archive/README.md', '# Archive\n');
  const bodies: Record<string, string> = {
    'docs/PRD.md': '# Authority\n\n> Current product version: `0.4.111`.\n\n[Architecture](architecture/overview.md)\n',
    'docs/README.md': '# Docs\n\n[Authority](PRD.md)\n',
    'docs/architecture/sessionplane-design-map.md': '# Map\n\n[Authority](../PRD.md)\n',
    'docs/architecture/overview.md': '# Architecture\n\n[Requirements](../specs/sessionplane-product-requirements.md)\n',
    'docs/specs/sessionplane-product-requirements.md': '# Requirements\n\n[Interfaces](sessionplane-interface-contracts.md)\n',
    'docs/specs/sessionplane-interface-contracts.md': '# Interfaces\n\n[Acceptance](sessionplane-acceptance.md)\n',
    'docs/specs/sessionplane-acceptance.md': '# Acceptance\n\n[History](../archive/README.md)\n',
    'repos/docs/PRD.md': '# Product contract\n',
    'repos/README.md': '# Repository\n\n[Contract](docs/PRD.md)\n',
    'repos/CONTRIBUTING.md': '# Contributing\n\n[Contract](docs/PRD.md)\n',
  };
  for (const relativePath of authorityPaths) put(root, relativePath, bodies[relativePath]);
  return root;
}

function allFailures(root: string): string[] {
  const identity = readCurrentProductIdentity(path.join(root, 'repos'));
  const documents = collectAuthorityDocuments(root);
  return [
    ...verifyCurrentVersionClaims(identity, documents),
    ...verifyInternalMarkdownLinks(documents),
    ...assertNoLiveLinksToArchivedTasks(documents),
    ...assertNoImplementedContractMarkedPlanned(documents),
  ];
}

test('current authority passes with the package version and resolvable links', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(allFailures(root), []);
});

test('stale version and broken link fail, then pass after the fixture is restored', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'docs/PRD.md', '# Authority\n\n> Current product version: `0.4.109`. Historical evidence remains archived.\n\n[Missing](architecture/missing.md)\n');
  const identity = readCurrentProductIdentity(path.join(root, 'repos'));
  let documents = collectAuthorityDocuments(root);
  assert.ok(verifyCurrentVersionClaims(identity, documents).some((failure) => failure.includes('0.4.109')));
  assert.ok(verifyInternalMarkdownLinks(documents).some((failure) => failure.includes('architecture/missing.md')));

  put(root, 'docs/PRD.md', '# Authority\n\n> Current product version: `0.4.111`.\n\n[Architecture](architecture/overview.md)\n');
  documents = collectAuthorityDocuments(root);
  assert.deepEqual(verifyCurrentVersionClaims(identity, documents), []);
  assert.deepEqual(verifyInternalMarkdownLinks(documents), []);
});

test('the workspace entrypoint must state the current product version', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'docs/PRD.md', '# Authority\n\n[Architecture](architecture/overview.md)\n');
  const identity = readCurrentProductIdentity(path.join(root, 'repos'));
  const failures = verifyCurrentVersionClaims(identity, collectAuthorityDocuments(root));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no current product-version claim/);
});

test('former live links to archived Tasks are rejected', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const taskName = 'T-20261107004245Z--completed.md';
  put(root, `docs/archive/tasks/${taskName}`, '# Completed\n');
  put(root, 'docs/architecture/sessionplane-design-map.md', `# Map\n\n[Old live path](../tasks/${taskName})\n`);
  let documents = collectAuthorityDocuments(root);
  assert.equal(assertNoLiveLinksToArchivedTasks(documents).length, 1);

  put(root, 'docs/architecture/sessionplane-design-map.md', `# Map\n\n[Archived Task](../archive/tasks/${taskName})\n`);
  documents = collectAuthorityDocuments(root);
  assert.deepEqual(assertNoLiveLinksToArchivedTasks(documents), []);
  assert.deepEqual(verifyInternalMarkdownLinks(documents), []);
});

test('implemented contracts cannot be labelled as planned work', (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'docs/specs/sessionplane-interface-contracts.md', '# Interfaces\n\n## Planned agent tools\n');
  const failures = assertNoImplementedContractMarkedPlanned(collectAuthorityDocuments(root));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /planned/i);
});
