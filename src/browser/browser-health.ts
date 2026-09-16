import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { PageBindingSnapshot } from './page-binding.ts';

export type BrowserRuntimeState =
  | 'not_started'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'disconnected'
  | 'error';

export interface ChromeInstallation {
  readonly executable: string;
  readonly version: string;
}

export interface BrowserStatusSource {
  readonly state: BrowserRuntimeState;
  readonly profileDir: string;
  readonly headless: boolean;
  readonly chrome: ChromeInstallation | null;
  readonly lastError: string | null;
}

export function findInstalledChrome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ChromeInstallation | null {
  const pathCandidates = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => [
      join(directory, 'google-chrome'),
      join(directory, 'google-chrome-stable'),
    ]);
  const platformCandidates =
    platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : platform === 'win32'
        ? [
            join(env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
            join(env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
            join(env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];

  for (const candidate of [...new Set([...pathCandidates, ...platformCandidates])]) {
    if (candidate === '' || (!isAbsolute(candidate) && !candidate.includes('/'))) {
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
    } catch {
      continue;
    }
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) {
      return {
        executable: candidate,
        version: result.stdout.trim() || result.stderr.trim(),
      };
    }
  }
  return null;
}

export function summarizeBrowserHealth(
  status: BrowserStatusSource,
  bindings: readonly PageBindingSnapshot[],
): Readonly<Record<string, unknown>> {
  const openBindings = bindings.filter((binding) => binding.state !== 'closed');
  return {
    state: status.state,
    profileDir: status.profileDir,
    headless: status.headless,
    chrome: status.chrome,
    lastError: status.lastError,
    pageCount: openBindings.length,
    conflictCount: openBindings.filter((binding) => binding.state === 'conflict').length,
    identityLostCount: openBindings.filter((binding) => binding.state === 'identity_lost').length,
  };
}

