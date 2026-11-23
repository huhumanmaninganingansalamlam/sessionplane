import { browserOwnerStatus } from './browser-owner-status.ts';
import { prepareBrowserMetrics, pruneBrowserMetrics } from './browser-metrics.ts';
import { spawn } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';
import { chromium, type APIRequestContext, type Browser, type BrowserContext } from 'playwright-core';
import { findHostBrowser, type BrowserStatusSource, type ChromeInstallation } from './browser-health.ts';


import { TEAM_GROUPS_EXTENSION_ID } from './team-tab-groups.ts';
import { assertDedicatedBrowserProfile, BrowserProfileError, ensureProfileBrowserIdentity, resolveBrowserProfileDir } from './browser-profile.ts';
import type { BrowserOwnerState } from "./browser-owner-state.ts";
import { BrowserOwnerError } from "./browser-owner-types.ts";
import type { BrowserLockMode } from "./browser-owner-types.ts";
import { acquireProfileLease, releaseProfileLease, processOwnsProfile, processOwnsDebuggingPort, readProfileLock, isProcessAlive } from "./profile-lease.ts";
import { scheduleTeamGroups } from "./team-group-synchronizer.ts";
import { identifyOwnedPage } from "./owned-page-recovery.ts";
import { buildHostBrowserArguments, isRetryableBrowserLaunchError, verifyExpectedAutomationSurface, reserveLoopbackPort, waitForCdpEndpoint, waitForChildExit, settleWithin, terminateProcessGroup, delay } from "./browser-process-helpers.ts";
const MAX_LAUNCH_ATTEMPTS = 3;

export function recoveryRequestContext(state: BrowserOwnerState): APIRequestContext {
    return requireOwnedBrowserContext(state).request;
  }

export async function startOrAdoptBrowserProcess(state: BrowserOwnerState): Promise<void> {
    if (state.process.state === 'ready' || state.process.state === 'manual') return;
    if (state.process.state === 'starting' || state.process.state === 'stopping') {
      throw new BrowserOwnerError('browser.unavailable', `Browser owner is ${state.process.state}`);
    }
    if (state.process.state === 'disconnected' || state.process.state === 'error') {
      await stopBrowserOwner(state);
    }

    state.process.state = 'starting';
    state.process.lastError = null;
    let adopting = false;
    try {
      const selectedBrowser = resolveOwnedBrowserProfile(state);
      const adopted = await acquireProfileLease(state);
      adopting = adopted !== null;
      ensureProfileBrowserIdentity(state.profile.profileDir, selectedBrowser, state.process.now);

      if (adopted?.mode === 'manual') {
        state.process.browserPid = adopted.browserPid;
        state.process.debuggingPort = null;
        state.process.ownership = 'manual';
        state.process.state = 'manual';
        return;
      }

      let debuggingPort: number;
      if (adopted === null) {
        debuggingPort = await launchOwnedBrowser(state, selectedBrowser);
      } else {
        state.process.browserPid = adopted.browserPid;
        state.process.debuggingPort = adopted.debuggingPort;
        state.process.ownership = 'adopted';
        debuggingPort = adopted.debuggingPort;
      }

      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`, {
        timeout: state.process.launchTimeoutMs,
        ...(adopted === null ? {} : { noDefaults: true }),
      });
      state.process.browser = browser;
      state.downloads.downloadControl = null;
      const context = browser.contexts()[0];
      if (context === undefined) {
        throw new BrowserOwnerError(
          'browser.unavailable',
          'The host browser did not expose its persistent default BrowserContext over CDP',
        );
      }
      await verifyExpectedAutomationSurface(context, state.process.headless);
      state.process.context = context;
      if (state.groups.resolveTeam) context.on('serviceworker', worker => {
        if (worker.url() === `chrome-extension://${TEAM_GROUPS_EXTENSION_ID}/groups.js`) {
          state.groups.groupsFingerprint = ''; scheduleTeamGroups(state);
        }
      });
      state.pages.pageRegistry.attach(context);
      for (const page of context.pages()) {
        try {
          await identifyOwnedPage(state, page);
        } catch (error) {
          if (!page.isClosed()) throw error;
        }
      }
      context.once('close', () => handleOwnedBrowserDisconnect(state, 'BrowserContext closed'));
      browser.once('disconnected', () => handleOwnedBrowserDisconnect(state, 'Browser disconnected'));
      state.process.state = 'ready';
      scheduleTeamGroups(state);
    } catch (error) {
      if (adopting) {
        // A failed successor must not destroy the predecessor's live browser.
        // For connectOverCDP, close disconnects this controller only.
        state.pages.pageRegistry.detach();
        await state.process.browser?.close().catch(() => undefined);
        state.process.context = null;
        state.process.browser = null;
        state.process.browserPid = null;
        state.process.debuggingPort = null;
        state.process.ownership = null;
        // Retain the browser identity in the lock for adoption after this core exits.
        state.profile.lockToken = null;
      } else {
        await shutdownOwnedBrowser(state).catch(() => undefined);
      }
      const details = state.process.browserStderrTail.trim();
      state.process.lastError = [error instanceof Error ? error.message : String(error), details]
        .filter(Boolean)
        .join('\n');
      state.process.state = 'error';
      releaseProfileLease(state);
      if (error instanceof BrowserOwnerError) throw error;
      if (error instanceof BrowserProfileError) {
        throw new BrowserOwnerError(error.errorCode, error.message, { cause: error });
      }
      throw new BrowserOwnerError(
        'browser.unavailable',
        `Failed to launch and attach to the selected host browser: ${state.process.lastError}`,
        { cause: error },
      );
    }
  }

export async function stopBrowserOwner(state: BrowserOwnerState): Promise<void> {
    if (state.process.state === 'stopped' || state.process.state === 'not_started') {
      releaseProfileLease(state);
      state.process.state = 'stopped';
      return;
    }
    if (state.process.closing) return;

    state.process.closing = true;
    state.process.state = 'stopping';
    try {
      state.pages.pageRegistry.detach();
      await shutdownOwnedBrowser(state);
      pruneBrowserMetrics(state.profile.profileDir, state.process.persistentMetrics, true, state.process.now().getTime());
    } finally {
      releaseProfileLease(state);
      state.process.closing = false;
      state.process.state = 'stopped';
    }
  }

export async function restartOwnedBrowserProcess(state: BrowserOwnerState): Promise<BrowserStatusSource> {
    await stopBrowserOwner(state);
    await startOrAdoptBrowserProcess(state);
    return browserOwnerStatus(state);
  }

export async function resetOwnedBrowserProfile(state: BrowserOwnerState): Promise<BrowserStatusSource> {
    await stopBrowserOwner(state);
    resolveOwnedBrowserProfile(state);
    rmSync(state.profile.profileDir, { recursive: true, force: true });
    await startOrAdoptBrowserProcess(state);
    return browserOwnerStatus(state);
  }

export function requireOwnedBrowserContext(state: BrowserOwnerState): BrowserContext {
    if (state.process.state !== 'ready' || state.process.context === null) {
      throw new BrowserOwnerError('browser.unavailable', 'Browser context is not ready');
    }
    return state.process.context;
  }

export function resolveOwnedBrowserProfile(state: BrowserOwnerState): ChromeInstallation {
    const selected = findHostBrowser({
      preference: state.profile.browserPreference,
      ...(state.profile.browserExecutable === null
        ? {}
        : { executablePath: state.profile.browserExecutable }),
    });
    if (selected === null) {
      throw new BrowserOwnerError(
        'browser.unavailable',
        state.profile.browserExecutable === null
          ? `No supported host browser was found for ${state.profile.browserPreference}; ` +
            'install Chrome, Chromium, Edge, or Brave, or set ' +
            'SESSIONPLANE_BROWSER_EXECUTABLE'
          : `The selected host browser is unavailable or unsupported: ${state.profile.browserExecutable}`,
      );
    }
    const profileDir = resolveBrowserProfileDir({
      profileRoot: state.profile.profileRoot,
      browser: selected,
      scopeByBrowser: state.profile.scopeProfileByBrowser,
    });
    try {
      assertDedicatedBrowserProfile(profileDir);
    } catch (error) {
      if (error instanceof BrowserProfileError) {
        throw new BrowserOwnerError(error.errorCode, error.message, { cause: error });
      }
      throw error;
    }
    state.process.chrome = selected;
    state.profile.profileDir = profileDir;
    state.profile.lockPath = path.join(profileDir, '.sessionplane-profile.lock');
    return selected;
  }

export async function launchOwnedBrowser(state: BrowserOwnerState, browser: ChromeInstallation): Promise<number> {
    prepareBrowserMetrics(state.profile.profileDir, state.process.persistentMetrics, state.process.now().getTime());
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt += 1) {
      const debuggingPort = await reserveLoopbackPort();
      const child = spawn(
        browser.executable,
        buildHostBrowserArguments({
          profileDir: state.profile.profileDir,
          debuggingPort,
          headless: state.process.headless,
          persistentMetrics: state.process.persistentMetrics,
        }),
        {
          env: process.env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      state.process.browserProcess = child;
      state.process.browserPid = child.pid ?? null;
      state.process.debuggingPort = debuggingPort;
      state.process.ownership = 'spawned';
      state.process.browserStderrTail = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        state.process.browserStderrTail = `${state.process.browserStderrTail}${chunk}`.slice(-8_000);
      });
      child.once('exit', (code, signal) => {
        if (state.process.browserProcess !== child) return;
        handleOwnedBrowserDisconnect(state,
          `Host browser exited${code === null ? '' : ` with code ${code}`}${
            signal === null ? '' : ` from ${signal}`
          }`,
        );
      });
      child.unref();
      (child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();

      try {
        if (child.pid === undefined) {
          throw new BrowserOwnerError('browser.unavailable', 'Host browser process did not expose a PID');
        }
        recordOwnedBrowserProcess(state, child.pid, debuggingPort, 'cdp');
        await waitForCdpEndpoint(
          debuggingPort,
          child,
          state.process.launchTimeoutMs,
          () => state.process.browserStderrTail,
        );
        return debuggingPort;
      } catch (error) {
        lastError = error;
        await stopOwnedBrowserProcess(state, child.pid ?? null, debuggingPort).catch(() => undefined);
        state.process.browserProcess = null;
        state.process.browserPid = null;
        state.process.debuggingPort = null;
        state.process.ownership = null;
        if (
          attempt >= MAX_LAUNCH_ATTEMPTS ||
          !isRetryableBrowserLaunchError(error, state.process.browserStderrTail)
        ) {
          throw error;
        }
        await delay(100);
      }
    }
    throw lastError;
  }

export function handleOwnedBrowserDisconnect(state: BrowserOwnerState, reason: string): void {
    if (state.process.closing || state.process.state === 'stopped') return;
    state.process.lastError = reason;
    state.process.state = 'disconnected';
  }

export async function shutdownOwnedBrowser(state: BrowserOwnerState): Promise<void> {
    await Promise.all([...state.pages.recoveryControllers.values()].map(controller => controller.close().catch(() => undefined)));
    state.pages.recoveryControllers.clear();
    const browser = state.process.browser;
    const child = state.process.browserProcess;
    const browserPid = state.process.browserPid;
    const debuggingPort = state.process.debuggingPort;
    const ownership = state.process.ownership;
    state.process.context = null;
    state.process.browser = null;

    if (ownership === 'manual') {
      if (browserPid !== null && isProcessAlive(browserPid)) {
        await stopOwnedBrowserProcess(state, browserPid, null);
      }
      if (child !== null) await waitForChildExit(child, 2_000);
    } else {
      if (browser !== null && browser.isConnected()) {
        try {
          const session = await settleWithin(browser.newBrowserCDPSession(), 1_000);
          if (session !== undefined) {
            await settleWithin(session.send('Browser.close'), 1_000);
            void session.detach().catch(() => undefined);
          }
        } catch (error) {
          // The exact owned process is terminated below if graceful CDP close
          // fails; retain a bounded diagnostic but never adopt a different PID.
          state.process.lastError = error instanceof Error ? error.message : String(error);
        }
      }

      if (child !== null && !(await waitForChildExit(child, 3_000))) {
        await stopOwnedBrowserProcess(state, child.pid ?? browserPid, debuggingPort);
      } else if (
        child === null &&
        browserPid !== null &&
        isProcessAlive(browserPid)
      ) {
        await stopOwnedBrowserProcess(state, browserPid, debuggingPort);
      }
      if (browser !== null && browser.isConnected()) {
        await settleWithin(browser.close(), 1_000);
      }
    }

    state.process.browserProcess = null;
    state.process.browserPid = null;
    state.process.debuggingPort = null;
    state.process.ownership = null;
    state.login.manualLoginUrl = null;
  }

export async function stopOwnedBrowserProcess(state: BrowserOwnerState, pid: number | null, debuggingPort: number | null): Promise<void> {
    if (pid === null || !isProcessAlive(pid)) return;
    if (!processOwnsProfile(pid, state.profile.profileDir)) {
      throw new BrowserOwnerError(
        'browser.unavailable',
        `Refusing to terminate process ${pid}; exact profile ownership is not proven`,
      );
    }
    if (debuggingPort !== null && !processOwnsDebuggingPort(pid, debuggingPort)) {
      throw new BrowserOwnerError(
        'browser.unavailable',
        `Refusing to terminate process ${pid}; exact CDP port ownership is not proven`,
      );
    }
    await terminateProcessGroup(pid);
  }

export function recordOwnedBrowserProcess(state: BrowserOwnerState,
    browserPid: number,
    debuggingPort: number | null,
    mode: BrowserLockMode,
  ): void {
    const token = state.profile.lockToken;
    if (token === null) {
      throw new BrowserOwnerError(
        'internal.invariant-violation',
        'Cannot record host browser ownership without a profile lock',
      );
    }
    const current = readProfileLock(state.profile.lockPath);
    if (current.token !== token || current.pid !== state.process.pid) {
      throw new BrowserOwnerError(
        'browser.unavailable',
        'Persistent profile lock changed while the host browser was starting',
      );
    }
    writeFileSync(
      state.profile.lockPath,
      JSON.stringify({
        pid: current.pid,
        token: current.token,
        createdAt: current.createdAt,
        mode,
        browserPid,
        ...(debuggingPort === null ? {} : { debuggingPort }),
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(state.profile.lockPath, 0o600);
  }
