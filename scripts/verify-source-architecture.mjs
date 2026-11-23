#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { sourceLine, withSourceTrees, walkSource } from './source-analysis.mjs';

// Only these explicit assembly files may instantiate concrete provider runtimes.
export const COMPOSITION_ROOTS = Object.freeze([
  'main.ts',
  'core/semantic-core-runtime.ts',
  'core/runtime/assemble-semantic-runtime.ts',
  'core/runtime/assemble-provider-runtime.ts',
  'core/runtime/assemble-browser-rpc.ts',
  'cli/main.ts',
  'cli/commands/doctor.ts',
]);

// These are ownership rules, not an aspirational generic layers diagram.
// A new dependency must be justified by the consumer's responsibility.
export const SOURCE_LAYER_RULES = Object.freeze({
  domain: ['domain'],
  storage: ['storage', 'domain'],
  browser: ['browser', 'scheduler', 'telemetry', 'domain'],
  providers: ['providers', 'browser', 'domain'],
  core: ['core', 'domain', 'providers', 'browser', 'storage', 'scheduler', 'telemetry', 'config', 'logging'],
  rpc: ['rpc', 'domain', 'config', 'logging', 'core'],
  cli: ['cli', 'rpc', 'config', 'skills'],
  mcp: ['mcp', 'cli', 'rpc', 'config'],
});

export function classifySourceModule(filePath) {
  const normalized = filePath.replaceAll('\\', '/').replace(/^src\//, '');
  if (COMPOSITION_ROOTS.includes(normalized)) return 'composition';
  if (normalized === 'main.ts') return 'composition';
  const first = normalized.split('/')[0];
  return Object.hasOwn(SOURCE_LAYER_RULES, first) ? first : first === 'config.ts' ? 'config' : first === 'logging.ts' ? 'logging' : first;
}

export function collectRelativeImports(sourceRoot) {
  const root = path.resolve(sourceRoot);
  return withSourceTrees(root, (trees) => {
    const edges = [];
    for (const tree of trees) {
      walkSource(tree.sourceFile, (node) => {
        let specifier, typeOnly = false;
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          specifier = node.moduleSpecifier;
          typeOnly = Boolean(node.importClause?.isTypeOnly || node.isTypeOnly);
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          specifier = node.arguments[0];
        }
        if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return;
        const target = path.resolve(path.dirname(tree.absolutePath), specifier.text);
        const relativeTarget = path.relative(root, target).split(path.sep).join('/');
        edges.push({
          from: tree.relativePath,
          to: relativeTarget,
          line: sourceLine(tree, node),
          typeOnly,
          specifier: specifier.text,
        });
      });
    }
    return { sourceRoot: root, edges };
  });
}

function ruleViolation(edge, rules) {
  const source = classifySourceModule(edge.from);
  const target = classifySourceModule(edge.to);
  if (edge.to === '..' || edge.to.startsWith('../') || path.isAbsolute(edge.to)) {
    return ['source escape', 'Move the dependency under src/ or a declared platform package'];
  }
  if (source === 'composition') return null;
  const allowed = rules[source];
  if (allowed && !allowed.includes(target)) {
    return [`${source} must not depend on ${target}`, `Move the contract to a shared domain/port or inject the owning ${target} service`];
  }
  if (source === 'providers' && /^browser\/(?:browser-owner|page-registry)\.ts$/.test(edge.to)) {
    return ['provider imports a concrete browser owner', 'Use the exact owned-page/operation contract'];
  }
  if (source === 'core' && !edge.typeOnly
      && (/^providers\/chatgpt\//.test(edge.to) || /^storage\/.*repository\.ts$/.test(edge.to))) {
    return ['core constructs a concrete provider/store outside composition', 'Move construction into main.ts or semantic-core-runtime.ts and inject a narrow port'];
  }
  if (source === 'rpc' && (target === 'browser' || target === 'storage')) {
    return ['RPC transport imports a concrete runtime implementation', 'Supply a typed service port from the composition root'];
  }
  return null;
}

export function validateImportEdge(edge, rules = SOURCE_LAYER_RULES) {
  const violation = ruleViolation(edge, rules);
  if (!violation) return null;
  return {
    ...edge,
    rule: violation[0],
    suggestion: violation[1],
  };
}

export function assertSourceArchitecture(report) {
  const issues = report.edges.map((edge) => validateImportEdge(edge)).filter(Boolean);
  if (issues.length) {
    throw new Error('Source architecture violations:\n' + issues.map((issue) =>
      `${issue.from}:${issue.line} -> ${issue.to}: ${issue.rule}; ${issue.suggestion}`
    ).join('\n'));
  }
  return report;
}

function run() {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const report = collectRelativeImports(sourceRoot);
  assertSourceArchitecture(report);
  console.log(`Source architecture passed (${report.edges.length} relative imports).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
