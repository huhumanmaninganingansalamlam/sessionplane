#!/usr/bin/env node
/**
 * Non-release candidate gate. Runs real isolated Core, disposable Chromium
 * fixtures and the installed tarball; never starts an actual user Core or
 * modifies an installed browser/profile. Optionally collects a READ-ONLY
 * live-source compatibility preflight, always separate from L3 acceptance.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--live-readonly') || args.length > 1) {
  throw new Error('Usage: node scripts/candidate-acceptance.mjs [--live-readonly]');
}
const liveReadonly = args[0] === '--live-readonly';
const receiptDir = mkdtempSync(path.join(tmpdir(), 'sessionplane-candidate-acceptance-'));
const head = exec('git', ['rev-parse', 'HEAD'], 10_000).stdout.trim();
const branch = exec('git', ['branch', '--show-current'], 10_000).stdout.trim();
const status = exec('git', ['status', '--porcelain'], 10_000).stdout.trim();
if (status || branch !== 'dev' || !/^[a-f0-9]{40}$/.test(head)) {
  throw new Error('Acceptance requires committed clean dev candidate, never a WIP tree');
}
const sourceTree = exec('git', ['rev-parse', 'HEAD^{tree}'], 10_000).stdout.trim();
const gates = [];
const plan = [
  { name: 'typecheck', argv: ['run', 'typecheck'], timeoutMs: 90_000 },
  { name: 'public-core-ci', argv: ['run', 'test:ci'], timeoutMs: 150_000 },
  { name: 'chromium-composition', argv: ['run', 'test:browser'], timeoutMs: 180_000 },
  { name: 'four-background-tabs', argv: ['run', 'test:background-l2'], timeoutMs: 90_000 },
  { name: 'browser-transport-comparison', argv: ['run', 'test:browser-transport-l2'], timeoutMs: 90_000 },
  { name: 'semantic-adapter', command: process.execPath,
    argv: ['--test', '--test-concurrency=1', '--experimental-strip-types',
      'test/browser/chatgpt-semantic-adapter.test.ts'], timeoutMs: 180_000 },
  { name: 'clean-build', argv: ['run', 'build'], timeoutMs: 90_000 },
  { name: 'installed-tarball-core', argv: ['run', 'test:package'], timeoutMs: 120_000 },
];
let successful = true;
let packageSha256 = null;
for (const step of plan) {
  const command = step.command ?? 'npm';
  const startedAt = Date.now();
  const result = exec(command, step.argv, step.timeoutMs);
  const merged = result.stdout + '\n' + result.stderr;
  const tests = /\btests (\d+)(?![\s\S]*\btests \d+)/.exec(merged);
  const passed = /\bpass (\d+)(?![\s\S]*\bpass \d+)/.exec(merged);
  const failed = /\bfail (\d+)(?![\s\S]*\bfail \d+)/.exec(merged);
  const skipped = /\bskipped (\d+)(?![\s\S]*\bskipped \d+)/.exec(merged);
  const gate = {
    name: step.name, passed: result.status === 0 && result.error === null,
    exitCode: result.status, durationMs: Date.now() - startedAt,
    tests: tests ? Number(tests[1]) : null,
    assertionsPassed: passed ? Number(passed[1]) : null,
    assertionsFailed: failed ? Number(failed[1]) : null,
    skipped: skipped ? Number(skipped[1]) : null,
    stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'),
  };
  if (!gate.passed) {
    gate.error = (result.error ?? result.stderr ?? result.stdout).slice(-1000);
    successful = false;
  }
  if (step.name === 'installed-tarball-core' && gate.passed) {
    const last = merged.split('\n').find(line => line.includes('"gate":"package-smoke"'));
    if (last) {
      try {
        const pkg = JSON.parse(last.trim());
        if (pkg.requestOk !== true || pkg.gate !== 'package-smoke') throw new Error('Invalid package gate');
        packageSha256 = pkg.packageSha256 ?? null;
        if (!/^[0-9a-f]{64}$/.test(packageSha256)) {
          throw new Error('Unverified candidate package SHA-256');
        }
      } catch { successful = false; gate.passed = false; gate.error = 'Package smoke receipt unparseable'; }
    } else { successful = false; gate.passed = false; gate.error = 'Missing package smoke receipt'; }
  }
  gates.push(gate);
  console.error(JSON.stringify({ gate: gate.name, passed: gate.passed,
    assertions: gate.assertionsPassed, seconds: Number((gate.durationMs / 1000).toFixed(1)) }));
  if (!gate.passed) break;
}
const identityFile = path.join(root, 'dist', 'build-identity.json');
let buildIdentity = null;
if (existsSync(identityFile)) {
  try { buildIdentity = JSON.parse(readFileSync(identityFile, 'utf8')); }
  catch { successful = false; }
}
if (buildIdentity?.sourceCommit !== head ||
    buildIdentity?.sourceTree !== sourceTree ||
    buildIdentity?.sourceState !== 'clean') {
  successful = false;
}
let installedLive = null;
if (liveReadonly) {
  const result = exec(process.execPath,
    ['scripts/live-candidate-preflight.mjs'], 45_000);
  try {
    installedLive = JSON.parse(result.stdout);
  } catch { installedLive = {
    outcome: { candidateMatchesLiveCore: false,
      blockers: ['live-readonly-preflight-unavailable'] },
  }; }
  // A mismatch means L3 is pending; it does not turn L1/L2 into a failure.
  installedLive = {
    mode: 'read_only',
    installedSchema: installedLive.installed?.schemaVersion ?? null,
    candidateSchema: installedLive.candidate?.schemaVersion ?? null,
    candidateMatchesLiveCore: installedLive.outcome?.candidateMatchesLiveCore === true,
    blockers: installedLive.outcome?.blockers ?? ['unknown'],
    mutationPerformed: false,
  };
}
const report = {
  contract: 'sessionplane-candidate-acceptance-v1',
  evaluatedAt: new Date().toISOString(),
  source: { branch, head, tree: sourceTree,
    buildMatchesCleanHead: buildIdentity?.sourceCommit === head &&
      buildIdentity?.sourceTree === sourceTree &&
      buildIdentity?.sourceState === 'clean' },
  candidateL1L2L4Passed: successful,
  l3LiveCandidateTested: false,
  actualTwentyMinuteDueObserved: false,
  actualFourLiveProviderBackgroundProjectsProven: false,
  externalPackageSha256: packageSha256,
  ...(installedLive ? { installedLive } : {}),
  gates,
};
writeFileSync(path.join(receiptDir, 'candidate-acceptance.json'),
  JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ...report, receiptDir }, null, 2));
if (!successful) process.exitCode = 1;

function exec(command, argv, timeoutMs) {
  const run = spawnSync(command, argv, {
    cwd: root, env: process.env, encoding: 'utf8',
    timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024,
  });
  return { stdout: run.stdout ?? '', stderr: run.stderr ?? '',
    status: run.status, error: run.error?.message ?? null };
}
