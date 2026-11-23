#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { logicalLines, sourceLine, withSourceTrees } from './source-analysis.mjs';

export const QUALITY_BUDGET = Object.freeze({
  fileLogicalLines: 600,
  declarationLogicalLines: 150,
});

// Temporary, exact-path ratchets. Each entry has one owning child Task and
// must disappear (not be raised) before the final integration Task.
export const EXISTING_SIZE_CEILINGS = Object.freeze({
  'core/semantic-decision-gateway.ts': 1192, // T-20261123033055Z-d4557f7e
  'core/managed-continuation.ts': 694, // T-20261123033055Z-4366babb
  'core/semantic-core-runtime.ts': 817, // T-20261123033139Z-af36a8be
  'browser/ref-snapshot.ts': 621, // T-20261123033056Z-d4464c8f
});

// Exact declaration names and occurrence indices; they cannot grow while
// their owners are being decomposed. New 151+ line methods never get an exception.
const EXISTING_DECLARATION_CEILINGS = Object.freeze({
  'browser/ref-snapshot.ts::BrowserRefSnapshotStore.capture#0': 408, // browser lifecycle child
  'browser/ref-snapshot.ts::BrowserRefSnapshotStore.callback#0': 328,
  'config.ts::resolveConfig#0': 152, // final integration cleanup
  'core/managed-continuation.ts::ManagedContinuationService.#run#0': 166,
  'core/semantic-core-runtime.ts::createSemanticCoreRuntime#0': 670,
  'core/semantic-decision-gateway.ts::SemanticDecisionGateway.inspect#0': 154,
  'core/semantic-decision-gateway.ts::SemanticDecisionGateway.decide#0': 152,
  'main.ts::startCore#0': 245, // composition child
  'providers/chatgpt/hostspan-permission.ts::inspectHostSpanActivity#0': 204,
  'providers/chatgpt/hostspan-permission.ts::callback#10': 178,
  'providers/chatgpt/hostspan-permission.ts::controlHostSpanPermission#0': 189,
});

// Pre-existing ignored failures are counted, not excused by a directory glob.
// Later children must turn these into explicit outcomes or narrower catch paths.
const EXISTING_EMPTY_CATCH_COUNTS = Object.freeze({
  'browser/browser-metrics.ts': 3,
  'browser/browser-owner.ts': 3,
  'browser/ref-snapshot.ts': 1,
  'core/managed-continuation.ts': 15,
  'core/semantic-core-runtime.ts': 1,
  'core/semantic-decision-gateway.ts': 7,
  'core/semantic-exact-task-port.ts': 1,
  'providers/chatgpt/hostspan-permission.ts': 1,
});
const EXISTING_DURABLE_JSON_CAST_COUNTS = Object.freeze({
  'core/semantic-decision-gateway.ts': 3, // durable Decision child
});
const EXISTING_STORAGE_PROVIDER_TOKENS = Object.freeze({
  'storage/conversation-load-recovery-repository.ts': 9, // typed store child
  'storage/page-binding-repository.ts': 2, // typed store child
  'storage/session-repository.ts': 1, // typed store child
  'storage/migrations/0014-kernel-root-dispatch-evidence.ts': 1, // historical immutable migration
});

function namedFunction(node, sf) {
  const anonymous = ts.isArrowFunction(node) || ts.isFunctionExpression(node);
  if (anonymous) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
      return parent.name.getText(sf);
    }
    return 'callback';
  }
  return node.name?.getText(sf) || 'constructor';
}

export function measureSourceDeclarations(sourceRoot) {
  return withSourceTrees(sourceRoot, (trees) => {
    const report = {
      sourceRoot: path.resolve(sourceRoot),
      files: [], declarations: [], emptyCatches: [], durableJsonCasts: [],
      providerLeaks: [], foregroundMutations: [],
    };
    for (const tree of trees) {
      const { relativePath: file, source, sourceFile: sf } = tree;
      report.files.push({ file, lines: logicalLines(source) });
      if (file.startsWith('domain/') || file.startsWith('storage/')) {
        const matches = source.match(/\b(?:chatgpt|grok|gemini)\b/gi) || [];
        if (matches.length) report.providerLeaks.push({ file, count: matches.length });
      }
      const names = new Map();
      function walk(node, owner = '') {
        const isFunction = ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)
          || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
          || ts.isSetAccessorDeclaration(node) || ts.isArrowFunction(node)
          || ts.isFunctionExpression(node);
        if (isFunction) {
          const label = (owner ? owner + '.' : '') + namedFunction(node, sf);
          const occurrence = names.get(label) || 0;
          names.set(label, occurrence + 1);
          report.declarations.push({
            file, name: `${file}::${label}#${occurrence}`,
            line: sourceLine(tree, node),
            lines: logicalLines(source.slice(node.getStart(sf), node.end)),
          });
        }
        if (ts.isCatchClause(node) && node.block?.statements?.length === 0) {
          report.emptyCatches.push({ file, line: sourceLine(tree, node) });
        }
        if ((file.startsWith('storage/') || file.startsWith('core/'))
          && ts.isAsExpression(node) && ts.isCallExpression(node.expression)
          && node.expression.expression.getText(sf) === 'JSON.parse'
          && /^Record<\s*string\s*,\s*unknown\s*>$/.test(node.type.getText(sf))) {
          report.durableJsonCasts.push({ file, line: sourceLine(tree, node) });
        }
        if (ts.isCallExpression(node) && node.expression.getText(sf).endsWith('.bringToFront')) {
          report.foregroundMutations.push({ file, line: sourceLine(tree, node) });
        }
        const next = ts.isClassDeclaration(node) ? (node.name?.text || owner) : owner;
        node.forEachChild((child) => walk(child, next));
      }
      walk(sf);
    }
    return report;
  });
}

export function findUnvalidatedDurableJsonCasts(sourceRoot) {
  return measureSourceDeclarations(sourceRoot).durableJsonCasts;
}

export function findEmptyCatchClauses(sourceRoot) {
  return measureSourceDeclarations(sourceRoot).emptyCatches;
}

function assertPerFileCount(items, allowed, what, issues) {
  const actual = new Map();
  for (const item of items) actual.set(item.file, (actual.get(item.file) || 0) + (item.count || 1));
  for (const [file, count] of actual) {
    if (count > (allowed[file] || 0)) {
      issues.push(`${file}: ${what} ${count}, legacy maximum ${allowed[file] || 0}; add an explicit decoder or handled outcome`);
    }
  }
}

export function assertSourceQuality(report) {
  const issues = [];
  for (const { file, lines } of report.files) {
    const ceiling = EXISTING_SIZE_CEILINGS[file] || QUALITY_BUDGET.fileLogicalLines;
    if (lines > ceiling) issues.push(`${file}: ${lines} logical lines exceeds ${ceiling}; split at a real responsibility boundary`);
  }
  for (const { file, name, line, lines } of report.declarations) {
    const ceiling = EXISTING_DECLARATION_CEILINGS[name] || QUALITY_BUDGET.declarationLogicalLines;
    if (lines > ceiling) issues.push(`${file}:${line} ${name} has ${lines} logical lines (max ${ceiling}); extract a named operation`);
  }
  assertPerFileCount(report.emptyCatches, EXISTING_EMPTY_CATCH_COUNTS, 'empty catch clauses', issues);
  assertPerFileCount(report.durableJsonCasts, EXISTING_DURABLE_JSON_CAST_COUNTS, 'unchecked durable JSON casts', issues);
  for (const { file, count } of report.providerLeaks) {
    const ceiling = EXISTING_STORAGE_PROVIDER_TOKENS[file] || 0;
    if (count > ceiling) issues.push(`${file}: ${count} provider-specific tokens in domain/storage (legacy max ${ceiling}); move provider routing out of durable transaction logic`);
  }
  for (const { file, line } of report.foregroundMutations) {
    if (!/^browser\/diagnostics\//.test(file)) issues.push(`${file}:${line}: bringToFront outside a named diagnostics module`);
  }
  if (issues.length) throw new Error('Source quality violations:\n' + issues.join('\n'));
  return report;
}

function run() {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const report = assertSourceQuality(measureSourceDeclarations(sourceRoot));
  console.log(`Source quality passed (${report.files.length} files, ${report.declarations.length} declarations).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
