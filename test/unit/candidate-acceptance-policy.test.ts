import assert from 'node:assert/strict';
import test from 'node:test';
import { candidateGatePlan, candidateGateFailureSummary, parseCandidateAcceptanceArgs } from '../../scripts/candidate-acceptance-policy.mjs';

test('candidate gate plan uses nine bounded stage-specific budgets', () => {
  const plan = candidateGatePlan('/exact/node');
  assert.equal(plan.length, 9);
  assert.equal(new Set(plan.map(step => step.name)).size, 9);
  for (const step of plan) {
    assert.ok(Number.isSafeInteger(step.timeoutMs));
    assert.ok(step.timeoutMs >= 120_000 && step.timeoutMs <= 480_000);
  }
  assert.ok(plan.find(step => step.name === 'chromium-composition')!.timeoutMs > 180_000);
  assert.ok(plan.find(step => step.name === 'public-core-ci')!.timeoutMs > 150_000);
  assert.equal(plan.find(step => step.name === 'semantic-adapter')!.command, '/exact/node');
  assert.throws(() => candidateGatePlan(''), /exact Node binary/);
});

test('timeout summary retains process error and bounded stdout/stderr tails', () => {
  const summary = candidateGateFailureSummary({
    error: 'spawnSync npm ETIMEDOUT',
    stderr: 'noise'.repeat(300) + 'LAST_STDERR',
    stdout: 'noise'.repeat(300) + 'LAST_STDOUT',
  });
  assert.match(summary, /ETIMEDOUT/);
  assert.match(summary, /LAST_STDERR/);
  assert.match(summary, /LAST_STDOUT/);
  assert.ok(summary.length <= 1250);
  assert.equal(candidateGateFailureSummary({ error: null, stderr: '', stdout: '' }),
    'candidate gate exited unsuccessfully without captured output');
});

test('acceptance mode binds dev by default and main only through explicit exact mode', () => {
  assert.deepEqual(parseCandidateAcceptanceArgs([]), {
    liveReadonly: false, expectedBranch: 'dev', releaseMain: false,
  });
  assert.deepEqual(parseCandidateAcceptanceArgs(['--live-readonly']), {
    liveReadonly: true, expectedBranch: 'dev', releaseMain: false,
  });
  assert.deepEqual(parseCandidateAcceptanceArgs(['--release-main']), {
    liveReadonly: false, expectedBranch: 'main', releaseMain: true,
  });
  assert.deepEqual(parseCandidateAcceptanceArgs(['--live-readonly', '--release-main']), {
    liveReadonly: true, expectedBranch: 'main', releaseMain: true,
  });
  for (const args of [['--main'], ['--release-main', '--release-main'],
    ['--live-readonly', '--live-readonly'], ['--release-main', '--ignore-source']]) {
    assert.throws(() => parseCandidateAcceptanceArgs(args), /Usage/);
  }
});
