import { prepareBrowserMetrics, pruneBrowserMetrics } from './browser-metrics.ts';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { chromium, type APIRequestContext, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import {
  findHostBrowser,
  type BrowserPreference,
  type BrowserRuntimeState,
  type BrowserStatusSource,
  type ChromeInstallation,
} from './browser-health.ts';
import { isChatGptUrl, isProviderUrl, parseProviderConversationId, type PageBindingSnapshot } from './page-binding.ts';
import { PageRegistry } from './page-registry.ts';
import { focusNativeTab, syncNativeTeamGroups, teamGroupsManifest, TEAM_GROUPS_EXTENSION_ID, resolveNativeTeamTabs, type TeamTabs } from './team-tab-groups.ts';
import {
  assertDedicatedBrowserProfile,
  BrowserProfileError,
  ensureProfileBrowserIdentity,
  resolveBrowserProfileDir,
} from './browser-profile.ts';
import type { BrowserOwnerState } from "./browser-owner-state.ts";
import { BrowserOwnerError } from "./browser-owner-types.ts";
import type { ProfileLockPayload, AdoptedBrowser, ManualLoginSnapshot, ManualLoginResumeSnapshot } from "./browser-owner-types.ts";
import { isProcessAlive, isErrno } from "./profile-lease.ts";

export function buildHostBrowserArguments(input: {
  readonly profileDir: string;
  readonly debuggingPort: number;
  readonly headless: boolean;
  readonly persistentMetrics?: boolean;
}): readonly string[] {
  if (
    !Number.isSafeInteger(input.debuggingPort) ||
    input.debuggingPort <= 0 ||
    input.debuggingPort > 65_535
  ) {
    throw new Error('debuggingPort must be an integer from 1 to 65535');
  }
  return Object.freeze([
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${input.debuggingPort}`,
    `--user-data-dir=${path.resolve(input.profileDir)}`,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    ...(input.persistentMetrics ? ['--enable-features=PersistentHistograms'] : ['--disable-features=PersistentHistograms']),
    // Recover persisted tabs and form state when both core and browser have exited.
    '--restore-last-session',
    ...(input.headless ? ['--headless=new'] : []),
    'about:blank',
  ]);
}

export function buildManualLoginArguments(input: {
  readonly profileDir: string;
  readonly loginUrl: string;
  readonly persistentMetrics?: boolean;
}): readonly string[] {
  return Object.freeze([
    `--user-data-dir=${path.resolve(input.profileDir)}`,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
    ...(input.persistentMetrics ? ['--enable-features=PersistentHistograms'] : ['--disable-features=PersistentHistograms']),
    '--new-window',
    input.loginUrl,
  ]);
}

export function isRetryableBrowserLaunchError(error: unknown, stderr = ''): boolean {
  const message = `${error instanceof Error ? error.message : String(error)}\n${stderr}`.toLowerCase();
  return (
    message.includes('eaddrinuse') ||
    message.includes('address already in use') ||
    message.includes('bind() failed')
  );
}

export async function verifyExpectedAutomationSurface(
  context: BrowserContext,
  headless: boolean,
): Promise<void> {
  if (headless) return;
  const existing = context.pages()[0];
  const page = existing ?? await context.newPage();
  const webdriver = await page.evaluate(() => navigator.webdriver).catch(() => null);
  if (existing === undefined) await page.close().catch(() => undefined);
  if (webdriver !== false) {
    throw new BrowserOwnerError(
      'browser.unavailable',
      'Headed host browser exposed navigator.webdriver; refusing the automated launch surface',
    );
  }
}

export async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    const fail = (error: Error): void => {
      server.close();
      reject(error);
    };
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not reserve a loopback debugging port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error === undefined ? resolve(port) : reject(error)));
    });
    server.unref();
  });
}

export async function waitForCdpEndpoint(
  port: number,
  browserProcess: ChildProcess,
  timeoutMs: number,
  stderrTail: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let spawnError: Error | null = null;
  const onError = (error: Error): void => {
    spawnError = error;
  };
  browserProcess.once('error', onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError !== null) throw spawnError;
      if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) {
        throw new Error(
          `Host browser exited before CDP became ready${formatStderrSuffix(stderrTail())}`,
        );
      }
      if (await isCdpEndpointReady(port)) return;
      await delay(100);
    }
  } finally {
    browserProcess.off('error', onError);
  }
  throw new Error(`Host browser CDP endpoint did not become ready${formatStderrSuffix(stderrTail())}`);
}

export async function waitForManualBrowserStartup(
  browserProcess: ChildProcess,
  timeoutMs: number,
  stderrTail: () => string,
): Promise<void> {
  const deadline = Date.now() + Math.max(250, timeoutMs);
  let spawnError: Error | null = null;
  const onError = (error: Error): void => {
    spawnError = error;
  };
  browserProcess.once('error', onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError !== null) throw spawnError;
      if (browserProcess.exitCode !== null || browserProcess.signalCode !== null) {
        throw new Error(
          `Manual login browser exited during startup${formatStderrSuffix(stderrTail())}`,
        );
      }
      if (Date.now() + 100 >= deadline) return;
      await delay(100);
    }
  } finally {
    browserProcess.off('error', onError);
  }
}

export function formatStderrSuffix(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? '' : `: ${trimmed.slice(-2_000)}`;
}

export async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

export async function settleWithin<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
): Promise<Result | undefined> {
  return await Promise.race([
    operation.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export async function terminateProcessGroup(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  const signal = (value: NodeJS.Signals): void => {
    try {
      if (process.platform === 'win32') process.kill(pid, value);
      else process.kill(-pid, value);
    } catch (error) {
      if (!isErrno(error, 'ESRCH')) {
        if (process.platform !== 'win32' && isErrno(error, 'EINVAL')) {
          process.kill(pid, value);
          return;
        }
        throw error;
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isProcessAlive(pid)) await delay(50);
  if (!isProcessAlive(pid)) return;
  signal('SIGKILL');
  const killDeadline = Date.now() + 1_000;
  while (Date.now() < killDeadline && isProcessAlive(pid)) await delay(50);
}

export async function isCdpEndpointReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const value = await response.json() as unknown;
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).webSocketDebuggerUrl === 'string'
    );
  } catch {
    return false;
  }
}

export async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
