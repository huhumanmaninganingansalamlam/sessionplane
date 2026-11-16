#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
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
const childArgs = process.argv.slice(separator + 1);
const inheritedRoot = process.env.SESSIONPLANE_CANDIDATE_GATE_ROOT?.trim() ?? '';
const inheritedToken = process.env.SESSIONPLANE_CANDIDATE_GATE_TOKEN?.trim() ?? '';
const hasParentIsolation = inheritedToken.length > 0 &&
  inheritedRoot.length > 0 && path.resolve(inheritedRoot) === path.resolve(process.env.TMPDIR ?? '') &&
  path.basename(inheritedRoot).startsWith('spg-');
let result;
if (hasParentIsolation) {
  // Do not nest a second TMPDIR inside an already-owned candidate gate. Unix
  // socket paths are bounded, and the parent supervisor already owns the
  // process group plus detached disposable-browser cleanup.
  const child = spawnSync(process.execPath, childArgs, {
    cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: timeoutMs,
    maxBuffer: 24 * 1024 * 1024, killSignal: 'SIGTERM',
  });
  result = {
    stdout: child.stdout ?? '', stderr: child.stderr ?? '',
    status: child.status, signal: child.signal ?? null,
    error: child.error?.message ?? null, errorCode: child.error?.code ?? null,
  };
} else {
  result = await runIsolatedCandidateCommand(
    process.execPath, childArgs,
    { cwd: process.cwd(), env: process.env, timeoutMs,
      maxOutputBytes: 24 * 1024 * 1024 },
  );
}
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
