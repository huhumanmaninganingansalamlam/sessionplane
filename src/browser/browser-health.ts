import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

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
  readonly source: 'playwright';
  readonly product: 'chromium';
}

export interface BrowserStatusSource {
  readonly state: BrowserRuntimeState;
  readonly profileDir: string;
  readonly headless: boolean;
  readonly chrome: ChromeInstallation | null;
  readonly transport: 'playwright' | null;
  readonly ownership: 'playwright' | null;
  readonly browserPid: number | null;
  readonly debuggingPort: number | null;
  readonly lastError: string | null;
}

export function findPlaywrightChromium(
  executablePath?: string,
): ChromeInstallation | null {
  let candidate: string;
  try {
    candidate = path.resolve(executablePath ?? chromium.executablePath());
    accessSync(candidate, constants.X_OK);
  } catch {
    return null;
  }

  const result = spawnSync(candidate, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) {
    return null;
  }
  const version = result.stdout.trim() || result.stderr.trim();
  if (version === '') {
    return null;
  }
  return Object.freeze({
    executable: candidate,
    version,
    source: 'playwright',
    product: 'chromium',
  });
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
    transport: status.transport,
    ownership: status.ownership,
    browserPid: status.browserPid,
    debuggingPort: status.debuggingPort,
    lastError: status.lastError,
    pageCount: openBindings.length,
    conflictCount: openBindings.filter((binding) => binding.state === 'conflict').length,
    identityLostCount: openBindings.filter((binding) => binding.state === 'identity_lost').length,
  };
}
