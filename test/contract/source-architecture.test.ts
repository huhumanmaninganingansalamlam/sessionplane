import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SOURCE_LAYER_RULES,
  COMPOSITION_ROOTS,
  assertSourceArchitecture,
  classifySourceModule,
  collectRelativeImports,
  validateImportEdge,
} from '../../scripts/verify-source-architecture.mjs';
import {
  QUALITY_BUDGET,
  EXISTING_SIZE_CEILINGS,
  assertSourceQuality,
  findEmptyCatchClauses,
  findUnvalidatedDurableJsonCasts,
  measureSourceDeclarations,
} from '../../scripts/verify-source-quality.mjs';

const realSource = path.resolve(import.meta.dirname, '../../src');

function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-source-gates-'));
  const source = path.join(root, 'src');
  mkdirSync(source);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    source,
    put(file: string, contents: string) {
      const target = path.join(source, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents, 'utf8');
    },
  };
}

test('real source obeys explicit import boundaries and bounded legacy budgets', () => {
  assert.ok(Object.hasOwn(SOURCE_LAYER_RULES, 'storage'));
  assert.ok(COMPOSITION_ROOTS.includes('core/semantic-core-runtime.ts'));
  assert.equal(Object.hasOwn(EXISTING_SIZE_CEILINGS, 'storage/task-kernel-repository.ts'), false);
  assert.equal(classifySourceModule('src/storage/example.ts'), 'storage');
  assertSourceArchitecture(collectRelativeImports(realSource));
  assertSourceQuality(measureSourceDeclarations(realSource));
});

test('storage cannot import provider implementation, including a type-only import', (t) => {
  const f = fixture(t);
  f.put('storage/unsafe.ts', "import type { ChatGptSemanticAdapter } from '../providers/chatgpt/semantic-adapter.ts';\n");
  f.put('providers/chatgpt/semantic-adapter.ts', 'export type ChatGptSemanticAdapter = {};\n');
  const report = collectRelativeImports(f.source);
  assert.equal(report.edges.length, 1);
  const violation = validateImportEdge(report.edges[0]);
  assert.match(violation?.rule ?? '', /storage must not depend on providers/);
  assert.throws(() => assertSourceArchitecture(report), /storage\/unsafe\.ts:1 -> providers\/chatgpt\/semantic-adapter\.ts/);
});

test('browser and domain cannot depend on provider runtime', (t) => {
  const f = fixture(t);
  f.put('browser/misbound.ts', "export { kind } from '../providers/chatgpt/kind.ts';\n");
  f.put('providers/chatgpt/kind.ts', 'export const kind = 1;\n');
  f.put('domain/unsafe.ts', "const loader = import('../browser/browser-owner.ts');\nexport { loader };\n");
  const report = collectRelativeImports(f.source);
  assert.throws(() => assertSourceArchitecture(report), /browser\/misbound\.ts.*providers\/chatgpt/);
  assert.equal(report.edges.length, 2);
});

test('new 700-line file and new 200-line method fail with their exact paths', (t) => {
  const f = fixture(t);
  f.put('core/sprawl.ts', Array.from({ length: 700 }, (_, i) => `export const value${i} = ${i};`).join('\n'));
  f.put('providers/too-long.ts', [
    'export class Oversized {',
    '  operate() {',
    ...Array.from({ length: 200 }, (_, i) => `    const local${i} = ${i};`),
    '    return 1;',
    '  }',
    '}',
  ].join('\n'));
  const report = measureSourceDeclarations(f.source);
  assert.ok(QUALITY_BUDGET.fileLogicalLines < 700);
  assert.throws(() => assertSourceQuality(report), /core\/sprawl\.ts: 700 logical lines/);
  assert.ok(report.declarations.some((d: { file: string; lines: number }) =>
    d.file === 'providers/too-long.ts' && d.lines > QUALITY_BUDGET.declarationLogicalLines));
});

test('new empty catch, unchecked durable JSON cast, provider leakage and focus switch fail', (t) => {
  const f = fixture(t);
  f.put('core/unsafe.ts', [
    'export function unsafe(raw: string) {',
    '  try { JSON.parse(raw); } catch {}',
    '  return JSON.parse(raw) as Record<string, unknown>;',
    '}',
  ].join('\n'));
  f.put('storage/unsafe.ts', "export const provider = 'chatgpt';\n");
  f.put('browser/switch.ts', 'export function go(page: {bringToFront(): void}) { page.bringToFront(); }\n');
  assert.equal(findEmptyCatchClauses(f.source).length, 1);
  assert.equal(findUnvalidatedDurableJsonCasts(f.source).length, 1);
  assert.throws(() => assertSourceQuality(measureSourceDeclarations(f.source)), /empty catch clauses/);
});
