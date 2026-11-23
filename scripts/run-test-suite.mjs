#!/usr/bin/env node
/** Minimal single-suite subprocess: no test files or budgets are encoded here. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandedSuiteFiles, getTestSuite, REPO_ROOT,
  validateTestSuiteManifest } from './test-suite-manifest.mjs';

export function buildSuiteCommand(name, options = {}) {
  const suite = getTestSuite(name);
  const root = options.root ?? REPO_ROOT;
  const env = { ...(options.env ?? process.env), ...(suite.env ?? {}) };
  if (suite.kind === 'isolated-node-tests') {
    const flags = ['--test', ...(suite.concurrent ? [] : ['--test-concurrency=1']),
      '--experimental-strip-types', ...expandedSuiteFiles(name, root)];
    return {
      command: options.nodeBinary ?? process.execPath,
      argv: ['scripts/run-isolated-test.mjs', '--timeout-ms='+suite.timeoutMs,
        '--', ...flags], cwd: root, env,
    };
  }
  if (suite.kind === 'node-script') {
    return { command: options.nodeBinary ?? process.execPath,
      argv: [suite.source, ...(options.args ?? [])], cwd: root, env };
  }
  if (suite.kind === 'sequence') {
    return { kind: 'sequence', suites: suite.suites, cwd: root, env };
  }
  throw new Error('No executable runner for '+name);
}

export function runTestSuite(name, options = {}) {
  const plan = buildSuiteCommand(name,options);
  if (plan.kind === 'sequence') {
    for (const next of plan.suites) {
      const code = runTestSuite(next, options);
      if (code !== 0) return code;
    }
    return 0;
  }
  const run = spawnSync(plan.command,plan.argv,{
    cwd:plan.cwd, env:plan.env, stdio:'inherit',
  });
  if (run.error) throw run.error;
  if (run.signal) throw new Error('Test suite interrupted by '+run.signal);
  return run.status ?? 1;
}
const entry = process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if (entry) {
  try {
    validateTestSuiteManifest();
    const requested = process.argv[2];
    const args = process.argv.slice(3).filter(value=>value!=='--');
    process.exitCode = runTestSuite(requested,{args});
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode=1;
  }
}
