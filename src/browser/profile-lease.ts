
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import type { BrowserOwnerState } from "./browser-owner-state.ts";
import { BrowserOwnerError } from "./browser-owner-types.ts";
import type { ProfileLockPayload, AdoptedBrowser } from "./browser-owner-types.ts";
import { isCdpEndpointReady } from "./browser-process-helpers.ts";

export async function acquireProfileLease(state: BrowserOwnerState): Promise<AdoptedBrowser | null> {
    mkdirSync(state.profile.profileDir, { recursive: true, mode: 0o700 });
    chmodSync(state.profile.profileDir, 0o700);
    const token = crypto.randomUUID();
    const payload: ProfileLockPayload = {
      pid: state.process.pid,
      token,
      createdAt: state.process.now().toISOString(),
    };
    let adopted: AdoptedBrowser | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let descriptor: number | null = null;
      try {
        descriptor = openSync(state.profile.lockPath, 'wx', 0o600);
        writeFileSync(
          descriptor,
          JSON.stringify(
            adopted === null
              ? payload
              : adopted.mode === 'manual'
                ? {
                    ...payload,
                    mode: 'manual',
                    browserPid: adopted.browserPid,
                  }
                : {
                    ...payload,
                    mode: 'cdp',
                    browserPid: adopted.browserPid,
                    debuggingPort: adopted.debuggingPort,
                  },
          ),
          { encoding: 'utf8' },
        );
        closeSync(descriptor);
        descriptor = null;
        chmodSync(state.profile.lockPath, 0o600);
        state.profile.lockToken = token;
        return adopted;
      } catch (error) {
        if (descriptor !== null) closeSync(descriptor);
        if (!isErrno(error, 'EEXIST')) throw error;

        const existing = readProfileLock(state.profile.lockPath);
        if (isProcessAlive(existing.pid)) {
          throw new BrowserOwnerError(
            'browser.unavailable',
            `Persistent profile is already owned by process ${existing.pid}`,
          );
        }
        if (existing.browserPid !== undefined && isProcessAlive(existing.browserPid)) {
          if (!processOwnsProfile(existing.browserPid, state.profile.profileDir)) {
            throw new BrowserOwnerError(
              'browser.unavailable',
              `Stale profile lock references live process ${existing.browserPid}, but exact profile ownership cannot be proven`,
            );
          }
          if (existing.mode === 'manual') {
            adopted = {
              mode: 'manual',
              browserPid: existing.browserPid,
            };
          } else if (
            existing.debuggingPort !== undefined &&
            processOwnsDebuggingPort(existing.browserPid, existing.debuggingPort) &&
            (await isCdpEndpointReady(existing.debuggingPort))
          ) {
            adopted = {
              mode: 'cdp',
              browserPid: existing.browserPid,
              debuggingPort: existing.debuggingPort,
            };
          } else {
            throw new BrowserOwnerError('browser.unavailable',
              'Existing profile browser is alive but its CDP endpoint cannot be verified; preserved without restart');
          }
        }
        unlinkSync(state.profile.lockPath);
      }
    }
    throw new BrowserOwnerError('browser.unavailable', 'Could not acquire persistent profile lock');
  }

export function releaseProfileLease(state: BrowserOwnerState): void {
    const token = state.profile.lockToken;
    state.profile.lockToken = null;
    if (token === null || !existsSync(state.profile.lockPath)) return;
    try {
      const payload = readProfileLock(state.profile.lockPath);
      if (payload.token === token) unlinkSync(state.profile.lockPath);
    } catch {
      // Ownership cannot be proven; retaining the lock is the only safe result.
      return;
    }
  }
export function processOwnsProfile(pid: number, profileDir: string): boolean {
  const expected = `--user-data-dir=${path.resolve(profileDir)}`;
  const commandLine = readProcessCommandLine(pid);
  return commandLine !== null && commandLineContainsArgument(commandLine, expected);
}

export function processOwnsDebuggingPort(pid: number, debuggingPort: number): boolean {
  const expected = `--remote-debugging-port=${debuggingPort}`;
  const commandLine = readProcessCommandLine(pid);
  return commandLine !== null && commandLineContainsArgument(commandLine, expected);
}

export function readProcessCommandLine(pid: number): string | null {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    return result.status === 0 ? result.stdout : null;
  }
  return null;
}

export function commandLineContainsArgument(commandLine: string, expected: string): boolean {
  const normalized = commandLine.replaceAll('\0', ' ');
  let offset = 0;
  for (;;) {
    const index = normalized.indexOf(expected, offset);
    if (index < 0) return false;
    const before = index === 0 ? '' : normalized[index - 1] ?? '';
    const afterIndex = index + expected.length;
    const after = afterIndex >= normalized.length ? '' : normalized[afterIndex] ?? '';
    if ((before === '' || /\s/.test(before)) && (after === '' || /\s/.test(after))) return true;
    offset = index + expected.length;
  }
}

export function readProfileLock(lockPath: string): ProfileLockPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as unknown;
  } catch (error) {
    throw new BrowserOwnerError(
      'browser.unavailable',
      `Persistent profile lock is unreadable: ${lockPath}`,
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new BrowserOwnerError('browser.unavailable', `Persistent profile lock is malformed: ${lockPath}`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.token !== 'string' ||
    typeof record.createdAt !== 'string' ||
    (record.mode !== undefined && record.mode !== 'cdp' && record.mode !== 'manual') ||
    (record.browserPid !== undefined &&
      (typeof record.browserPid !== 'number' ||
        !Number.isSafeInteger(record.browserPid) ||
        record.browserPid <= 0)) ||
    (record.debuggingPort !== undefined &&
      (typeof record.debuggingPort !== 'number' ||
        !Number.isSafeInteger(record.debuggingPort) ||
        record.debuggingPort <= 0 ||
        record.debuggingPort > 65_535)) ||
    (record.mode === 'manual' && record.debuggingPort !== undefined) ||
    (record.mode === 'cdp' &&
      (record.browserPid === undefined || record.debuggingPort === undefined))
  ) {
    throw new BrowserOwnerError('browser.unavailable', `Persistent profile lock is malformed: ${lockPath}`);
  }
  return parsed as ProfileLockPayload;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ', 1)[0];
        if (state === 'Z' || state === 'X') return false;
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return false;
        // An unreadable state is not evidence that a live owner has exited.
      }
    }
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

export function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}
