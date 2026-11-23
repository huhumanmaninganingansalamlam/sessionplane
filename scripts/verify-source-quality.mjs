#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { logicalLines, sourceLine, withSourceTrees } from './source-analysis.mjs';

export const QUALITY_BUDGET = Object.freeze({
  fileLogicalLines: 600,
  declarationLogicalLines: 150,
});

// Final state: no production file or declaration has a temporary size waiver.
export const EXISTING_SIZE_CEILINGS = Object.freeze({});

// Historical immutable migration data may contain a provider literal. This is
// not a supported runtime branch and cannot grow or spread to transaction code.
export const HISTORICAL_STORAGE_PROVIDER_TOKENS = Object.freeze({
  'storage/migrations/0014-kernel-root-dispatch-evidence.ts': 1,
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

function isFunctionDeclaration(node) {
  return ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)
    || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node) || ts.isArrowFunction(node)
    || ts.isFunctionExpression(node);
}

function declarationLogicalLines(node, source, sf) {
  const nested = [];
  function collect(current) {
    current.forEachChild((child) => {
      if (child !== node && isFunctionDeclaration(child)) {
        nested.push([child.getStart(sf), child.end]);
      } else {
        collect(child);
      }
    });
  }
  collect(node);
  let ownSource = '';
  let cursor = node.getStart(sf);
  for (const [start, end] of nested.sort((left, right) => left[0] - right[0])) {
    if (start < cursor) continue;
    ownSource += source.slice(cursor, start);
    cursor = end;
  }
  ownSource += source.slice(cursor, node.end);
  return logicalLines(ownSource);
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
        if (isFunctionDeclaration(node)) {
          const label = (owner ? owner + '.' : '') + namedFunction(node, sf);
          const occurrence = names.get(label) || 0;
          names.set(label, occurrence + 1);
          report.declarations.push({
            file, name: `${file}::${label}#${occurrence}`,
            line: sourceLine(tree, node),
            lines: declarationLogicalLines(node, source, sf),
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

export function assertSourceQuality(report) {
  const issues = [];
  for (const { file, lines } of report.files) {
    if (lines > QUALITY_BUDGET.fileLogicalLines) {
      issues.push(`${file}: ${lines} logical lines exceeds ${QUALITY_BUDGET.fileLogicalLines}; split at a real responsibility boundary`);
    }
  }
  for (const { file, name, line, lines } of report.declarations) {
    if (lines > QUALITY_BUDGET.declarationLogicalLines) {
      issues.push(`${file}:${line} ${name} has ${lines} direct logical lines (max ${QUALITY_BUDGET.declarationLogicalLines}); extract a named operation`);
    }
  }
  for (const { file, line } of report.emptyCatches) {
    issues.push(`${file}:${line}: empty catch clause; return a typed outcome or handle the exact optional operation`);
  }
  for (const { file, line } of report.durableJsonCasts) {
    issues.push(`${file}:${line}: unchecked durable JSON cast; use a named decoder`);
  }
  for (const { file, count } of report.providerLeaks) {
    const historicalMaximum = HISTORICAL_STORAGE_PROVIDER_TOKENS[file] || 0;
    if (count > historicalMaximum) {
      issues.push(`${file}: ${count} provider-specific tokens in domain/storage (historical immutable maximum ${historicalMaximum}); move provider routing out of durable transaction logic`);
    }
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
