import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TEST_SUITES, RELEASE_GATES, WORKFLOW_GATES, SUITE_ALIASES, REPO_ROOT,
  expandedSuiteFiles, getTestSuite, validateTestSuiteManifest,
} from '../../scripts/test-suite-manifest.mjs';
import { buildSuiteCommand } from '../../scripts/run-test-suite.mjs';
import { candidateGatePlan } from '../../scripts/candidate-acceptance-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => readFileSync(path.join(root,name), 'utf8');
const packageJson = JSON.parse(read('package.json'));

test('manifest owns every release gate, current source path and executable npm alias', () => {
  const result = validateTestSuiteManifest(root);
  assert.equal(result.gates, 9);
  assert.equal(result.suites, 12);
  assert.ok(result.tests >= 50, 'all current unit, integration, contract and browser files are enumerated');
  assert.equal(result.acceptance, 33);
  const required = JSON.parse(read('scripts/ops/handover-manifest.json')).requiredGates;
  assert.deepEqual(RELEASE_GATES.map(g => g.name), required);
  for (const [alias,suite] of Object.entries(SUITE_ALIASES)) {
    assert.equal(packageJson.scripts[alias], 'node scripts/run-test-suite.mjs '+suite);
  }
  const candidate = candidateGatePlan('/exact/node');
  assert.deepEqual(candidate.map(g => g.name), required);
  assert.equal(candidate.find(g => g.name === 'semantic-adapter')?.command, '/exact/node');
  assert.deepEqual(candidate.find(g => g.name === 'semantic-adapter')?.argv,
    ['scripts/run-test-suite.mjs', 'semantic-adapter']);
});

test('the runner expands mandatory unit glob and preserves the exact safety budget', () => {
  const ci = buildSuiteCommand('ci', { root, nodeBinary: '/exact/node', env: {} });
  assert.equal(ci.command, '/exact/node');
  assert.equal(ci.argv[0], 'scripts/run-isolated-test.mjs');
  assert.ok(ci.argv.includes('--timeout-ms=330000'));
  assert.ok(ci.argv.includes('--test-concurrency=1'));
  assert.ok(ci.argv.includes('test/unit/durable-task-kernel.test.ts'));
  assert.ok(ci.argv.includes('test/unit/semantic-runtime-assembly.test.ts'));
  assert.ok(ci.argv.includes('test/contract/test-suite-manifest.test.ts'));
  assert.equal(ci.argv.filter(p => p.endsWith('.test.ts')).length,
    expandedSuiteFiles('ci',root).length);
  const due = buildSuiteCommand('background-l2', { root, env: {} });
  assert.equal(due.env.SESSIONPLANE_RUN_HEADLESS_BROWSER_L2, '1');
  assert.equal(due.argv.includes('--test-concurrency=1'),false);
  assert.throws(() => getTestSuite('deleted-private-internal'), /Unrecognized/);
});

test('actual CI and release workflows run the declared npm gates, not decorative statuses', () => {
  for (const [workflow, commands] of Object.entries(WORKFLOW_GATES)) {
    const yaml = read('.github/workflows/' + workflow + '.yml');
    for (const command of commands) {
      assert.ok(yaml.includes('npm run '+command),
        'Missing executable '+command+' in '+workflow);
      assert.ok(Object.hasOwn(packageJson.scripts,command));
    }
  }
  const ciNames = new Set(expandedSuiteFiles('ci',root));
  const browserNames = new Set(expandedSuiteFiles('browser',root));
  assert.equal([...ciNames].some(name => browserNames.has(name)),false,
    'same costly browser test cannot accidentally execute twice in a single candidate suite');
  assert.ok(TEST_SUITES.acceptance.suites.includes('package'));
});

test('authoritative E01-E24/A01-A08 and the explicit E25 extension retain exact evidence owners', () => {
  const mapping = JSON.parse(read('test/acceptance-map.json'));
  const expected = [...Array.from({length:25},(_,i) => 'E'+String(i+1).padStart(2,'0')),
    ...Array.from({length:8},(_,i) => 'A'+String(i+1).padStart(2,'0'))];
  assert.deepEqual(Object.keys(mapping).sort(),expected.sort());
  const tested = new Set([...expandedSuiteFiles('ci',root),
    ...expandedSuiteFiles('browser',root),...expandedSuiteFiles('semantic-adapter',root)]);
  for (const [id,item] of Object.entries(mapping)) {
    assert.ok(item.invariant && item.owner && item.evidence, id);
    assert.equal(item.source, id === 'E25'
      ? 'task-extension:T-20261123033056Z-cc5867b3:E25'
      : 'sessionplane-acceptance:'+id, id+' source');
    assert.ok(tested.has(item.test),id+' references a deleted or nonblocking test');
    if (item.evidence.includes('L3') || item.evidence.includes('L4')) {
      assert.equal(item.owner,'test-and-authorized-operations');
    }
  }
  assert.deepEqual({
    E01: mapping.E01.invariant,
    E20: mapping.E20.invariant,
    E24: mapping.E24.invariant,
    A01: mapping.A01.invariant,
    A08: mapping.A08.invariant,
  }, {
    E01: 'duplicate/concurrent project.open',
    E20: 'large decision evidence and action catalogue page completely with stable identity',
    E24: 'package and install identity agree across source, tree, digest, receipt, and health',
    A01: 'only current enabled provider choices and effects are shown',
    A08: 'provider text and page content cannot create authority or override contracts',
  });
  assert.equal(mapping.E07.evidence.includes('L3-required'),true,
    'a virtual-clock test is not an actual twenty-minute L3 run');
  assert.equal(mapping.E24.evidence.includes('L4-required'),true,
    'a source fixture is not installed-package evidence');
});
