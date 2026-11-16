#!/usr/bin/env node
import { runIsolatedCandidateCommand } from './candidate-gate-process.mjs';

const separator = process.argv.indexOf('--', 2);
if (separator < 0 || separator === process.argv.length - 1) {
  throw new Error('Usage: run-isolated-test.mjs --timeout-ms=N -- <node arguments>');
}
let timeoutMs = null;
for (const argument of process.argv.slice(2, separator)) {
  const match = /^--timeout-ms=(\d+)$/.exec(argument);
  if (!match || timeoutMs !== null) throw new Error('Invalid isolated test options');
  timeoutMs = Number(match[1]);
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
  throw new Error('A finite --timeout-ms is required');
}
const result = await runIsolatedCandidateCommand(
  process.execPath,
  process.argv.slice(separator + 1),
  { cwd: process.cwd(), env: process.env, timeoutMs, maxOutputBytes: 24 * 1024 * 1024 },
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.status !== 0 || result.error !== null) {
  process.stderr.write(`${JSON.stringify({
    isolatedTestError: result.error ?? 'test process exited unsuccessfully',
    errorCode: result.errorCode,
    exitCode: result.status,
    signal: result.signal,
  })}\n`);
  process.exitCode = 1;
}
