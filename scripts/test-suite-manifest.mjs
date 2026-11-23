/** Single executable owner for test inputs and release gate ordering.
 * No suite may discover browser/user Core or loosen a provider deadline.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CI_INTEGRATION = Object.freeze([
  'test/integration/public-cli.test.ts',
  'test/integration/cli-mcp.test.ts',
  'test/integration/context-skills.test.ts',
  'test/integration/public-task-rpc.test.ts',
  'test/integration/public-second-slot.test.ts',
  'test/integration/offline-state-rehearsal.test.ts',
  'test/integration/live-task-acceptance.test.ts',
  'test/integration/live-candidate-preflight.test.ts',
  'test/integration/health-rpc.test.ts',
  'test/integration/public-remote-ssh.test.ts',
]);
const CI_CONTRACT = Object.freeze([
  'test/contract/handover.test.ts',
  'test/contract/doc-authority.test.ts',
  'test/contract/source-architecture.test.ts',
  'test/contract/kernel-row-codecs.test.ts',
  'test/contract/decision-envelope.test.ts',
  'test/contract/test-suite-manifest.test.ts',
  'test/contract/verify-repository-quality.test.ts',
]);
const BROWSER_FILES = Object.freeze([
  'test/browser/semantic-core-composition.test.ts',
  'test/browser/closed-pro-model.test.ts',
  'test/browser/four-project-background.test.ts',
  'test/browser/disposable-browser-lifetime.test.ts',
]);
const ACCEPTANCE_IDS = Object.freeze([
  ...Array.from({length:25}, (_, index) => 'E' + String(index + 1).padStart(2, '0')),
  ...Array.from({length:8}, (_, index) => 'A' + String(index + 1).padStart(2, '0')),
]);
const ACCEPTANCE_ANCHORS = Object.freeze({
  E01: 'duplicate/concurrent project.open',
  E07: 'approved real twenty-minute no-FINAL interval sends one literal 계속 Attempt',
  E20: 'large decision evidence and action catalogue page completely with stable identity',
  E24: 'package and install identity agree across source, tree, digest, receipt, and health',
  A01: 'only current enabled provider choices and effects are shown',
  A08: 'provider text and page content cannot create authority or override contracts',
});
const E25_SOURCE = 'task-extension:T-20261123033056Z-cc5867b3:E25';

const nodeTests = (files, timeoutMs, env = {}, concurrent = false) =>
  Object.freeze({ kind: 'isolated-node-tests', files: Object.freeze(files),
    timeoutMs, env: Object.freeze(env), concurrent });

export const TEST_SUITES = Object.freeze({
  ci: nodeTests([...CI_INTEGRATION, 'test/unit/*.test.ts', 'test/reliability/soak.test.ts',
    ...CI_CONTRACT], 330_000),
  browser: nodeTests([...BROWSER_FILES], 450_000),
  reliability: nodeTests([
    'test/unit/durable-task-kernel.test.ts', 'test/unit/managed-continuation.test.ts',
    'test/integration/public-cli.test.ts', 'test/browser/semantic-core-composition.test.ts',
    'test/reliability/soak.test.ts',
  ], 330_000),
  'semantic-adapter': nodeTests(['test/browser/chatgpt-semantic-adapter.test.ts'], 360_000),
  'background-l2': nodeTests(['test/browser/owned-page-liveness.benchmark.test.ts'],
    150_000, { SESSIONPLANE_RUN_HEADLESS_BROWSER_L2: '1' }, true),
  'browser-transport-l2': nodeTests(['test/browser/owned-page-transport.comparison.test.ts'],
    150_000, { SESSIONPLANE_COMPARE_BROWSER_TRANSPORT_L2: '1' }, true),
  package: Object.freeze({ kind: 'node-script', source: 'scripts/package-smoke.mjs' }),
  'live-preflight': Object.freeze({ kind: 'node-script',
    source: 'scripts/live-candidate-preflight.mjs', explicitLive: true }),
  'live-task': Object.freeze({ kind: 'node-script',
    source: 'scripts/live-task-acceptance.mjs', explicitLive: true }),
  candidate: Object.freeze({ kind: 'node-script', source: 'scripts/candidate-acceptance.mjs',
    requiresCleanTree: true }),
  checks: Object.freeze({ kind: 'sequence', suites: Object.freeze(['ci','browser']) }),
  acceptance: Object.freeze({ kind: 'sequence',
    suites: Object.freeze(['ci','browser','package']) }),
});

/** These are the same nine required gate names as the checked-in handover
 * policy; there is no fake GitHub status and no separate candidate-only list.
 */
export const RELEASE_GATES = Object.freeze([
  { name: 'source-quality', script: 'verify:repository', timeoutMs: 120_000 },
  { name: 'typecheck', script: 'typecheck', timeoutMs: 120_000 },
  { name: 'public-core-ci', script: 'test:ci', suite: 'ci', timeoutMs: 360_000 },
  { name: 'chromium-composition', script: 'test:browser', suite: 'browser', timeoutMs: 480_000 },
  { name: 'four-background-tabs', script: 'test:background-l2',
    suite: 'background-l2', timeoutMs: 180_000 },
  { name: 'browser-transport-comparison', script: 'test:browser-transport-l2',
    suite: 'browser-transport-l2', timeoutMs: 180_000 },
  { name: 'semantic-adapter', suite: 'semantic-adapter',
    directNode: true, timeoutMs: 360_000 },
  { name: 'clean-build', script: 'build', timeoutMs: 120_000 },
  { name: 'installed-tarball-core', script: 'test:package',
    suite: 'package', timeoutMs: 240_000 },
]);

export const SUITE_ALIASES = Object.freeze({
  'test:ci': 'ci',
  'test:browser': 'browser',
  'test:reliability': 'reliability',
  'test:package': 'package',
  'test:background-l2': 'background-l2',
  'test:browser-transport-l2': 'browser-transport-l2',
  'test:candidate': 'candidate',
  'test:live-preflight': 'live-preflight',
  'test:live-task': 'live-task',
  'test:acceptance': 'acceptance',
  test: 'checks',
});

export const WORKFLOW_GATES = Object.freeze({
  ci: Object.freeze(['lint', 'verify:repository', 'typecheck', 'test:ci', 'build', 'doctor', 'test:package']),
  release: Object.freeze(['lint', 'verify:repository', 'typecheck', 'test:ci', 'build', 'doctor', 'test:package']),
});

export function getTestSuite(name) {
  if (!Object.hasOwn(TEST_SUITES, name)) throw new Error('Unrecognized test suite: ' + String(name));
  return TEST_SUITES[name];
}

export function expandedSuiteFiles(name, root = REPO_ROOT) {
  const suite = getTestSuite(name);
  if (suite.kind !== 'isolated-node-tests') return [];
  const expanded = [];
  for (const file of suite.files) {
    if (file.endsWith('/*.test.ts')) {
      const folder = file.slice(0, -'/*.test.ts'.length);
      const files = readdirSync(path.join(root, folder))
        .filter(entry => entry.endsWith('.test.ts')).sort();
      if (files.length === 0) throw new Error('Empty required test suite glob: ' + file);
      for (const entry of files) expanded.push(folder + '/' + entry);
    } else {
      expanded.push(file);
    }
  }
  return expanded;
}

export function validateTestSuiteManifest(root = REPO_ROOT) {
  const packageFile = JSON.parse(readFileSync(path.join(root, 'package.json'),'utf8'));
  const required = JSON.parse(readFileSync(path.join(root,'scripts/ops/handover-manifest.json'),'utf8'));
  const acceptance = JSON.parse(readFileSync(
    path.join(root,'test/acceptance-map.json'),'utf8'));
  const names = RELEASE_GATES.map(gate => gate.name);
  if (new Set(names).size !== names.length ||
      JSON.stringify(required.requiredGates) !== JSON.stringify(names)) {
    throw new Error('Handover requiredGates and executable release manifest differ');
  }
  const seen = new Set();
  for (const [name, suite] of Object.entries(TEST_SUITES)) {
    if (suite.kind === 'isolated-node-tests') {
      const files = expandedSuiteFiles(name, root);
      if (new Set(files).size !== files.length) throw new Error('Duplicate test in '+ name);
      for (const file of files) {
        if (!existsSync(path.join(root,file))) throw new Error('Missing test: '+file);
        seen.add(file);
      }
    } else if (suite.kind === 'node-script') {
      if (!existsSync(path.join(root,suite.source))) throw new Error('Missing suite script: '+suite.source);
    } else if (suite.kind === 'sequence') {
      for (const next of suite.suites) if (!Object.hasOwn(TEST_SUITES, next) || next===name)
        throw new Error('Invalid test sequence member: '+next);
    } else throw new Error('Invalid test suite kind: '+name);
  }
  for (const [alias,name] of Object.entries(SUITE_ALIASES)) {
    if (!Object.hasOwn(TEST_SUITES,name)) throw new Error('Suite alias missing: '+name);
    if (packageFile.scripts[alias] !== 'node scripts/run-test-suite.mjs '+name) {
      throw new Error('Package script must delegate to manifest: '+alias);
    }
  }
  for (const gate of RELEASE_GATES) {
    if (!Number.isSafeInteger(gate.timeoutMs) || gate.timeoutMs < 120_000 ||
        gate.timeoutMs > 480_000) throw new Error('Invalid release timeout '+gate.name);
    if (gate.suite && !Object.hasOwn(TEST_SUITES,gate.suite)) {
      throw new Error('Release gate suite missing: '+gate.suite);
    }
    if (gate.script && !Object.hasOwn(packageFile.scripts,gate.script)) {
      throw new Error('Release gate script missing: '+gate.script);
    }
  }
  for (const [workflow,commands] of Object.entries(WORKFLOW_GATES)) {
    const workflowPath = path.join(root,'.github/workflows/'+workflow+'.yml');
    if (!existsSync(workflowPath)) throw new Error('Missing workflow: '+workflow);
    const yaml = readFileSync(workflowPath,'utf8');
    for (const command of commands) {
      if (!yaml.includes('npm run '+command)) {
        throw new Error('Workflow '+workflow+' does not execute npm run '+command);
      }
    }
  }
  const candidateOwners = new Map();
  for (const gate of RELEASE_GATES) {
    if (!gate.suite || getTestSuite(gate.suite).kind !== 'isolated-node-tests') continue;
    for (const file of expandedSuiteFiles(gate.suite,root)) {
      const previous = candidateOwners.get(file);
      if (previous) {
        throw new Error('Candidate test duplicated across '+previous+' and '+gate.name+': '+file);
      }
      candidateOwners.set(file,gate.name);
    }
  }
  // Every release-blocking concrete test is owned by one executable suite.
  for (const file of CI_INTEGRATION.concat(CI_CONTRACT, BROWSER_FILES,
      ['test/reliability/soak.test.ts'])) {
    if (!seen.has(file)) throw new Error('Release-blocking test uncovered: '+file);
  }
  const acceptanceIds = Object.keys(acceptance).sort();
  if (JSON.stringify(acceptanceIds) !== JSON.stringify([...ACCEPTANCE_IDS].sort())) {
    throw new Error('Acceptance map must own exactly E01-E25 and A01-A08');
  }
  const blockingTests = new Set([
    ...expandedSuiteFiles('ci',root),
    ...expandedSuiteFiles('browser',root),
    ...expandedSuiteFiles('semantic-adapter',root),
  ]);
  for (const id of ACCEPTANCE_IDS) {
    const item = acceptance[id];
    if (!item || typeof item.invariant !== 'string' || !item.invariant ||
        typeof item.evidence !== 'string' || !item.evidence ||
        typeof item.test !== 'string' || !item.test ||
        !['test','test-and-authorized-operations'].includes(item.owner)) {
      throw new Error('Invalid acceptance owner: '+id);
    }
    const source = id === 'E25' ? E25_SOURCE : 'sessionplane-acceptance:'+id;
    if (item.source !== source) throw new Error('Stale acceptance source: '+id);
    if (!blockingTests.has(item.test)) {
      throw new Error('Acceptance owner is deleted or nonblocking: '+id+' -> '+item.test);
    }
    if ((item.evidence.includes('L3') || item.evidence.includes('L4')) &&
        item.owner !== 'test-and-authorized-operations') {
      throw new Error('Live or installed evidence cannot be fixture-only: '+id);
    }
    if (Object.hasOwn(ACCEPTANCE_ANCHORS,id) &&
        item.invariant !== ACCEPTANCE_ANCHORS[id]) {
      throw new Error('Acceptance numbering drifted at '+id);
    }
  }
  return Object.freeze({ suites: Object.keys(TEST_SUITES).length,
    gates: names.length, tests: seen.size, acceptance: ACCEPTANCE_IDS.length,
    gateNames: names });
}
