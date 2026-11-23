/**
 * Finite candidate test budgets, independent of product deadlines.
 * A loaded Chromium host can exceed the previous 180-second limit.
 */
import { RELEASE_GATES } from './test-suite-manifest.mjs';

export function candidateGatePlan(nodeBinary) {
  if (typeof nodeBinary !== 'string' || !nodeBinary) {
    throw new TypeError('candidate runner requires an exact Node binary');
  }
  return RELEASE_GATES.map(gate => Object.freeze({
    name: gate.name, timeoutMs: gate.timeoutMs,
    ...(gate.directNode ? {
      command: nodeBinary, argv: ['scripts/run-test-suite.mjs', gate.suite],
    } : {
      argv: ['run', gate.script],
    }),
  }));
}

// A timeout must retain both the process error and diagnostic output tails.
export function candidateGateFailureSummary({ error, stderr, stdout }) {
  const lines = [];
  if (error) lines.push('process: ' + String(error).slice(0, 240));
  if (stderr) lines.push('stderr tail: ' + String(stderr).slice(-320));
  if (stdout) lines.push('stdout tail: ' + String(stdout).slice(-600));
  return lines.join(String.fromCharCode(10)).slice(0, 1250)
    || 'candidate gate exited unsuccessfully without captured output';
}

/**
 * The same bounded nine-gate runner also validates the exact merged main
 * artifact. Never infer main evidence from a dev receipt, a tag, or a
 * different commit with an equivalent tree: this requires an explicit mode.
 */
export function parseCandidateAcceptanceArgs(args) {
  if (!Array.isArray(args) || args.some(arg =>
      !['--release-main', '--live-readonly'].includes(arg)) ||
      new Set(args).size !== args.length) {
    throw new Error('Usage: candidate-acceptance.mjs [--live-readonly] [--release-main]');
  }
  return {
    liveReadonly: args.includes('--live-readonly'),
    expectedBranch: args.includes('--release-main') ? 'main' : 'dev',
    releaseMain: args.includes('--release-main'),
  };
}
