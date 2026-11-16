import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { cleanCandidateDisposableChromes } from './disposable-browser-guard.mjs';

/**
 * Launch each acceptance gate in a new, bounded POSIX process group.
 * npm's top-level PID is not its entire test tree: on timeout, killing only
 * npm can leave a Chromium test worker alive with access to the fixture.
 *
 * This helper sends signals exclusively to the new group ID assigned to
 * *its own* detached child. It must never be used to manage the installed
 * SessionPlane Core, an adopted browser, or a caller's unrelated process.
 */
export async function runIsolatedCandidateCommand(command, args, {
  cwd, env, timeoutMs, maxOutputBytes = 12 * 1024 * 1024,
  killGraceMs = 3_000,
} = {}) {
  if (process.platform === 'win32') {
    throw new Error('Candidate process-group supervisor requires POSIX');
  }
  if (typeof command !== 'string' || !command ||
      !Array.isArray(args) || !args.every(arg => typeof arg === 'string') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(killGraceMs) || killGraceMs < 1 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new TypeError('Invalid bounded candidate command');
  }
  const gateToken = randomUUID();
  const gateRoot = mkdtempSync(path.join('/tmp', 'spg-'));
  return await new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd, env: { ...env, SESSIONPLANE_CANDIDATE_GATE_TOKEN: gateToken,
          SESSIONPLANE_CANDIDATE_GATE_ROOT: gateRoot,
          TMPDIR: gateRoot, TMP: gateRoot, TEMP: gateRoot },
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      rmSync(gateRoot, { recursive: true, force: true });
      resolve({
        stdout: '', stderr: '', status: null, signal: null,
        error: error.message, errorCode: error.code ?? 'ESPAWN',
      });
      return;
    }
    let fault = null;
    let spawnError = null;
    let byteCount = 0;
    const stdoutBuffers = [];
    const stderrBuffers = [];
    let escalation = null;

    const signalOwnGroup = signal => {
      if (!Number.isInteger(child.pid) || child.pid <= 1) return;
      try {
        // Negative PID targets the newly-created *dedicated* group only.
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') spawnError ??= error;
      }
    };
    const abortOwnGroup = (code, message) => {
      if (fault !== null) return;
      fault = { code, message };
      signalOwnGroup('SIGTERM');
      escalation = setTimeout(() => signalOwnGroup('SIGKILL'), killGraceMs);
    };
    const recordChunk = (chunk, buffers) => {
      const available = Math.max(0, maxOutputBytes - byteCount);
      if (available > 0) buffers.push(chunk.subarray(0, available));
      byteCount += chunk.length;
      if (byteCount > maxOutputBytes) {
        abortOwnGroup('EOUTPUTLIMIT',
          'Candidate gate exceeded bounded stdout/stderr capture budget');
      }
    };
    child.stdout?.on('data', chunk => recordChunk(chunk, stdoutBuffers));
    child.stderr?.on('data', chunk => recordChunk(chunk, stderrBuffers));
    child.once('error', error => {
      spawnError = error;
      abortOwnGroup(error.code ?? 'ESPAWN', error.message);
    });
    const deadline = setTimeout(() => abortOwnGroup('ETIMEDOUT',
      'Candidate gate exceeded its finite execution deadline'), timeoutMs);
    child.once('close', async (code, signal) => {
      clearTimeout(deadline);
      if (fault !== null) signalOwnGroup('SIGKILL');
      if (escalation !== null) clearTimeout(escalation);
      let cleanupError = null;
      let cleanupResult = null;
      try {
        cleanupResult = await cleanCandidateDisposableChromes(gateToken, gateRoot);
        if (cleanupResult.remaining !== 0 || cleanupResult.cleaned !== 0) {
          cleanupError = `Candidate left ${cleanupResult.cleaned + cleanupResult.remaining} disposable Chrome process groups; ${cleanupResult.remaining} could not be stopped`;
        }
      } catch (error) {
        cleanupError = `Candidate browser cleanup failed: ${error.message}`;
      }
      // A detected leak still fails the gate, but once every exact disposable
      // browser is stopped its unique test root is disposable too.
      if (cleanupResult?.remaining === 0) {
        try { rmSync(gateRoot, { recursive: true, force: true }); }
        catch (error) { cleanupError = `Candidate temporary root cleanup failed: ${error.message}`; }
      }
      resolve({
        stdout: Buffer.concat(stdoutBuffers).toString('utf8'),
        stderr: Buffer.concat(stderrBuffers).toString('utf8'),
        status: fault === null && cleanupError === null ? code : null,
        signal: signal ?? null,
        error: cleanupError ?? fault?.message ?? spawnError?.message ?? null,
        errorCode: cleanupError ? 'EDISPOSABLECHROME' : fault?.code ?? spawnError?.code ?? null,
      });
    });
  });
}
