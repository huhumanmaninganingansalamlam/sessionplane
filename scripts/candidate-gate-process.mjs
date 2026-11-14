import { spawn } from 'node:child_process';

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
  return await new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
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
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      // Even after npm has exited, its descendants may still own the group.
      if (fault !== null) signalOwnGroup('SIGKILL');
      if (escalation !== null) clearTimeout(escalation);
      resolve({
        stdout: Buffer.concat(stdoutBuffers).toString('utf8'),
        stderr: Buffer.concat(stderrBuffers).toString('utf8'),
        status: fault === null ? code : null,
        signal: signal ?? null,
        error: fault?.message ?? spawnError?.message ?? null,
        errorCode: fault?.code ?? spawnError?.code ?? null,
      });
    });
  });
}
