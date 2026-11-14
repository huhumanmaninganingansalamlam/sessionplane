import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runIsolatedCandidateCommand } from '../../scripts/candidate-gate-process.mjs';

test('isolated candidate process preserves stdout, stderr and successful exit', async () => {
  const result = await runIsolatedCandidateCommand(process.execPath,
    ['-e', 'process.stdout.write("OUT"); process.stderr.write("ERR")'], {
      cwd: process.cwd(), env: process.env, timeoutMs: 5_000,
      maxOutputBytes: 64_000, killGraceMs: 100,
    });
  assert.equal(result.status, 0);
  assert.equal(result.errorCode, null);
  assert.equal(result.stdout, 'OUT');
  assert.equal(result.stderr, 'ERR');
});

test('a deadline kills the candidate command and its own grandchild, not an unrelated process', {
  skip: process.platform !== 'linux',
}, async () => {
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],',
    '  { stdio: ["ignore", "ignore", "ignore"] });',
    'console.log("GRANDCHILD=" + child.pid);',
    'setInterval(() => {}, 1000);',
  ].join(' ');
  let grandchild: number | null = null;
  const unrelated = spawn(process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert.ok(unrelated.pid && unrelated.pid > 1);
  try {
    const result = await runIsolatedCandidateCommand(process.execPath,
      ['-e', parentScript], {
        cwd: process.cwd(), env: process.env, timeoutMs: 800,
        maxOutputBytes: 64_000, killGraceMs: 200,
      });
    assert.equal(result.status, null);
    assert.equal(result.errorCode, 'ETIMEDOUT');
    grandchild = Number(/GRANDCHILD=(\d+)/.exec(result.stdout)?.[1]);
    assert.ok(Number.isInteger(grandchild) && grandchild > 1, 'synthetic grandchild PID observed');
    await new Promise(resolve => setTimeout(resolve, 200));
    const stat = (() => {
      try { return readFileSync('/proc/' + grandchild + '/stat', 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    })();
    assert.ok(stat === null || /\) Z /.test(stat),
      'child process from timed-out candidate must not remain running');
    assert.ok(unrelated.pid && !/\) Z /.test(readFileSync(
      '/proc/' + unrelated.pid + '/stat', 'utf8')),
    'unrelated process must not be touched by the candidate group cleanup');
  } finally {
    unrelated.kill('SIGTERM'); // This test created it; it is never part of the candidate group.
    if (grandchild && Number.isInteger(grandchild)) {
      // Only clean up our synthetic test child if the group assertion failed.
      try {
        const cmd = readFileSync('/proc/' + grandchild + '/cmdline', 'utf8');
        if (cmd.includes('setInterval(() => {}, 1000)')) process.kill(grandchild, 'SIGKILL');
      } catch { /* already gone */ }
    }
  }
});

test('output-budget exhaustion fails closed and keeps captured bytes bounded', async () => {
  const result = await runIsolatedCandidateCommand(process.execPath,
    ['-e', 'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000)'], {
      cwd: process.cwd(), env: process.env, timeoutMs: 5_000,
      maxOutputBytes: 1024, killGraceMs: 100,
    });
  assert.equal(result.status, null);
  assert.equal(result.errorCode, 'EOUTPUTLIMIT');
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
});
