/**
 * Finite candidate test budgets, independent of product deadlines.
 * A loaded Chromium host can exceed the previous 180-second limit.
 */
export function candidateGatePlan(nodeBinary) {
  if (typeof nodeBinary !== 'string' || !nodeBinary) {
    throw new TypeError('candidate runner requires an exact Node binary');
  }
  return [
    { name: 'typecheck', argv: ['run', 'typecheck'], timeoutMs: 120_000 },
    { name: 'public-core-ci', argv: ['run', 'test:ci'], timeoutMs: 360_000 },
    { name: 'chromium-composition', argv: ['run', 'test:browser'], timeoutMs: 480_000 },
    { name: 'four-background-tabs', argv: ['run', 'test:background-l2'], timeoutMs: 180_000 },
    { name: 'browser-transport-comparison', argv: ['run', 'test:browser-transport-l2'], timeoutMs: 180_000 },
    { name: 'semantic-adapter', command: nodeBinary,
      argv: ['--test', '--test-concurrency=1', '--experimental-strip-types',
        'test/browser/chatgpt-semantic-adapter.test.ts'], timeoutMs: 360_000 },
    { name: 'clean-build', argv: ['run', 'build'], timeoutMs: 120_000 },
    { name: 'installed-tarball-core', argv: ['run', 'test:package'], timeoutMs: 240_000 },
  ];
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
