#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_AUTHORITY_DOCUMENT_PATHS = Object.freeze([
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
]);

const REPOSITORY_AUTHORITY_DOCUMENT_PATHS = Object.freeze([
  'docs/PRD.md',
  'README.md',
  'CONTRIBUTING.md',
]);

const VERSION_TOKEN = /\bv?(\d+\.\d+\.\d+)\b/g;
const CURRENT_CLAIM = /(?:current.{0,48}version|version.{0,48}current|current product|source version|implemented(?: and accepted)? in|accepted in|\bstatus\b|현재.{0,24}(?:제품|정식).{0,24}버전|제품 버전|현재 버전|상태\s*\|)/i;

function parsePackage(packagePath) {
  let value;
  try {
    value = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read product identity from ${packagePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version)) {
    throw new Error(`package.json must contain a semantic version: ${packagePath}`);
  }
  return value;
}

export function readCurrentProductIdentity(repoRoot) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  const packagePath = path.join(resolvedRepoRoot, 'package.json');
  const packageJson = parsePackage(packagePath);
  let sourceCommit = null;
  try {
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolvedRepoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // A copied fixture or source archive may not contain Git metadata.
  }
  return Object.freeze({
    repoRoot: resolvedRepoRoot,
    packagePath,
    packageName: typeof packageJson.name === 'string' ? packageJson.name : null,
    version: packageJson.version,
    sourceCommit,
  });
}

function readDocuments(root, relativePaths, requiredVersionClaimPath = null) {
  return relativePaths.map((relativePath) => {
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`Missing authority document under ${root}: ${relativePath}`);
    }
    return Object.freeze({
      workspaceRoot: root,
      relativePath,
      absolutePath,
      content: readFileSync(absolutePath, 'utf8'),
      requiresCurrentVersionClaim: relativePath === requiredVersionClaimPath,
    });
  });
}

export function collectAuthorityDocuments(workspaceRoot) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  return readDocuments(resolvedWorkspaceRoot, WORKSPACE_AUTHORITY_DOCUMENT_PATHS, 'docs/PRD.md');
}

function collectRepositoryDocuments(repoRoot) {
  const resolvedRepoRoot = path.resolve(repoRoot);
  return readDocuments(resolvedRepoRoot, REPOSITORY_AUTHORITY_DOCUMENT_PATHS);
}

function linesOf(document) {
  return document.content.split(/\r?\n/).map((text, index) => ({
    text,
    line: index + 1,
  }));
}

function cleanMarkdownTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith('<')) {
    const closing = target.indexOf('>');
    if (closing >= 0) target = target.slice(1, closing);
  } else {
    const title = target.match(/^(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?$/);
    if (title) target = title[1];
  }
  return target.trim();
}

function markdownLinks(document) {
  const links = [];
  const pattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
  let match;
  while ((match = pattern.exec(document.content)) !== null) {
    const prefix = document.content.slice(0, match.index);
    const line = prefix.split(/\r?\n/).length;
    links.push({ target: cleanMarkdownTarget(match[1]), line });
  }
  return links;
}

function localLinkPath(document, target) {
  if (!target || target.startsWith('#')) return null;
  if (/^(?:https?:|mailto:|tel:|data:)/i.test(target)) return null;
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
  if (!withoutFragment) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    decoded = withoutFragment;
  }
  if (path.isAbsolute(decoded)) return { absolute: true, path: decoded };
  return { absolute: false, path: path.resolve(path.dirname(document.absolutePath), decoded) };
}

export function verifyCurrentVersionClaims(identity, documents) {
  const failures = [];
  const requiredClaims = new Map();
  for (const document of documents) {
    if (document.requiresCurrentVersionClaim) requiredClaims.set(document.relativePath, 0);
    for (const { text, line } of linesOf(document)) {
      if (!CURRENT_CLAIM.test(text)) continue;
      const versions = [...text.matchAll(VERSION_TOKEN)].map((match) => match[1]);
      if (versions.length === 0) continue;
      if (document.requiresCurrentVersionClaim) {
        requiredClaims.set(document.relativePath, requiredClaims.get(document.relativePath) + versions.length);
      }
      for (const version of versions) {
        if (version !== identity.version) {
          failures.push(`${document.relativePath}:${line}: current version claim ${version} does not match package.json ${identity.version}`);
        }
      }
    }
  }
  for (const [relativePath, count] of requiredClaims) {
    if (count === 0) {
      failures.push(`${relativePath}: no current product-version claim was found; expected ${identity.version}`);
    }
  }
  return failures;
}

export function verifyInternalMarkdownLinks(documents) {
  const failures = [];
  for (const document of documents) {
    for (const link of markdownLinks(document)) {
      const resolved = localLinkPath(document, link.target);
      if (!resolved) continue;
      if (resolved.absolute) {
        failures.push(`${document.relativePath}:${link.line}: absolute local Markdown link is not portable: ${link.target}`);
        continue;
      }
      if (!existsSync(resolved.path)) {
        failures.push(`${document.relativePath}:${link.line}: broken Markdown link ${link.target}`);
      }
    }
  }
  return failures;
}

export function assertNoLiveLinksToArchivedTasks(documents) {
  const failures = [];
  const liveMarker = `${path.sep}docs${path.sep}tasks${path.sep}`;
  const archiveMarker = `${path.sep}docs${path.sep}archive${path.sep}tasks${path.sep}`;
  for (const document of documents) {
    for (const link of markdownLinks(document)) {
      const resolved = localLinkPath(document, link.target);
      if (!resolved || resolved.absolute) continue;
      const normalized = path.normalize(resolved.path);
      if (!normalized.includes(liveMarker) || normalized.includes(archiveMarker)) continue;
      const archived = normalized.replace(liveMarker, archiveMarker);
      if (!existsSync(normalized) && existsSync(archived)) {
        failures.push(`${document.relativePath}:${link.line}: archived Task is linked through its former live path: ${link.target}`);
      }
    }
  }
  return failures;
}

export function assertNoImplementedContractMarkedPlanned(documents) {
  const failures = [];
  const forbidden = [
    ['implemented flow marked planned', /\bplanned\s+(?:normal|agent|public|core|interface|gate|surface|method|tool)/i],
    ['implemented contract marked proposed/target', /\b(?:proposed|target)\s+(?:core methods|normal flow|agent tools|public interface|CLI|MCP|contract)/i],
    ['implemented contract awaiting an old Task', /\bawaiting\s+Task\s+\d+/i],
    ['legacy Korean planning language in current authority', /(?:구현 전 승인|계획 상태|승인 대기|아직 구현되지|Task\s*1에서\s*(?:승인|검토)|계획된 공개)/i],
  ];
  for (const document of documents) {
    for (const { text, line } of linesOf(document)) {
      for (const [reason, pattern] of forbidden) {
        if (pattern.test(text)) {
          failures.push(`${document.relativePath}:${line}: ${reason}: ${text.trim()}`);
        }
      }
    }
  }
  return failures;
}

function resolveDocumentsForCli(repoRoot) {
  if (process.env.SESSIONPLANE_WORKSPACE_ROOT) {
    return collectAuthorityDocuments(path.resolve(process.env.SESSIONPLANE_WORKSPACE_ROOT));
  }
  const parent = path.resolve(repoRoot, '..');
  const isCanonicalWorkspace = path.resolve(parent, 'repos') === repoRoot
    && existsSync(path.join(parent, 'docs', 'architecture', 'sessionplane-design-map.md'));
  if (isCanonicalWorkspace) return collectAuthorityDocuments(parent);
  return collectRepositoryDocuments(repoRoot);
}

function run() {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(scriptPath), '..');
  const identity = readCurrentProductIdentity(repoRoot);
  const documents = resolveDocumentsForCli(repoRoot);
  const failures = [
    ...verifyCurrentVersionClaims(identity, documents),
    ...verifyInternalMarkdownLinks(documents),
    ...assertNoLiveLinksToArchivedTasks(documents),
    ...assertNoImplementedContractMarkedPlanned(documents),
  ];
  if (failures.length > 0) {
    console.error('Documentation authority check failed:');
    for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  const source = identity.sourceCommit ? ` at ${identity.sourceCommit.slice(0, 12)}` : '';
  const scope = documents.length === WORKSPACE_AUTHORITY_DOCUMENT_PATHS.length ? 'workspace' : 'repository';
  console.log(`Documentation authority check passed for ${identity.version}${source} (${documents.length} ${scope} documents).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
