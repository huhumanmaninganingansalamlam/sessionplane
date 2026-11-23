import { browserOwnerStatus } from './browser-owner-status.ts';
import { prepareBrowserMetrics } from './browser-metrics.ts';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';


import { type Browser, type Page } from 'playwright-core';
import { type ChromeInstallation } from './browser-health.ts';
import { isChatGptUrl, type PageBindingSnapshot } from './page-binding.ts';


import { ensureProfileBrowserIdentity } from './browser-profile.ts';
import type { BrowserOwnerState } from "./browser-owner-state.ts";
import { BrowserOwnerError } from "./browser-owner-types.ts";
import type { ManualLoginSnapshot, ManualLoginResumeSnapshot } from "./browser-owner-types.ts";
import { startOrAdoptBrowserProcess, stopBrowserOwner, resolveOwnedBrowserProfile, shutdownOwnedBrowser, stopOwnedBrowserProcess, recordOwnedBrowserProcess } from "./browser-process-owner.ts";
import { acquireProfileLease, releaseProfileLease, readProfileLock, isProcessAlive } from "./profile-lease.ts";
import { createOwnedPage } from "./owned-page-recovery.ts";
import { buildManualLoginArguments, waitForManualBrowserStartup, waitForChildExit } from "./browser-process-helpers.ts";

export async function openManualLoginPage(state: BrowserOwnerState, loginUrl: string): Promise<PageBindingSnapshot> {
    const existing = state.pages.pageRegistry
      .listBindings({ includeClosed: false })
      .find(
        (binding) =>
          binding.state === 'unbound' &&
          binding.sessionId === null &&
          binding.generation === null &&
          binding.expectedConversationId === null &&
          isChatGptUrl(binding.url),
      );
    if (existing !== undefined) return existing;

    const { page, binding } = await createOwnedPage(state);
    try {
      await page.goto(loginUrl, { waitUntil: 'commit', timeout: state.process.launchTimeoutMs });
      return state.pages.pageRegistry.refreshPage(binding.pageKey);
    } catch (error) {
      await page.close().catch(() => undefined);
      throw new BrowserOwnerError('browser.unavailable', 'Failed to open the ChatGPT login page', {
        cause: error,
      });
    }
  }

export async function beginManualLogin(state: BrowserOwnerState, loginUrl: string): Promise<ManualLoginSnapshot> {
    if (state.process.headless) {
      throw new BrowserOwnerError(
        'browser.manual-login-unavailable',
        'Manual login requires a headed host browser',
      );
    }
    if (state.process.state === 'starting' || state.process.state === 'stopping') {
      throw new BrowserOwnerError(
        'browser.unavailable',
        `Browser owner is ${state.process.state}`,
      );
    }
    if (state.process.state === 'manual') {
      return manualLoginSnapshot(state, state.login.manualLoginUrl ?? loginUrl);
    }
    if (state.process.state === 'disconnected' || state.process.state === 'error') {
      await stopBrowserOwner(state);
    }

    const activeBindings = state.pages.pageRegistry
      .listBindings({ includeClosed: false })
      .filter((binding) => binding.sessionId !== null || binding.generation !== null);
    if (activeBindings.length > 0) {
      throw new BrowserOwnerError(
        'browser.manual-login-blocked',
        `Manual login cannot interrupt ${activeBindings.length} bound browser Page(s)`,
      );
    }

    const selectedBrowser = resolveOwnedBrowserProfile(state);
    if (state.profile.lockToken === null) {
      const adopted = await acquireProfileLease(state);
      if (adopted?.mode === 'manual') {
        state.process.browserPid = adopted.browserPid;
        state.process.debuggingPort = null;
        state.process.ownership = 'manual';
        state.login.manualLoginUrl = loginUrl;
        state.process.state = 'manual';
        return manualLoginSnapshot(state, loginUrl);
      }
      if (adopted?.mode === 'cdp') {
        state.process.browserPid = adopted.browserPid;
        state.process.debuggingPort = adopted.debuggingPort;
        state.process.ownership = 'adopted';
        await stopOwnedBrowserProcess(state, adopted.browserPid, adopted.debuggingPort);
        state.process.browserPid = null;
        state.process.debuggingPort = null;
        state.process.ownership = null;
      }
      ensureProfileBrowserIdentity(state.profile.profileDir, selectedBrowser, state.process.now);
    }

    state.process.closing = true;
    state.process.state = 'stopping';
    try {
      state.pages.pageRegistry.detach();
      await shutdownOwnedBrowser(state);
    } catch (error) {
      state.process.state = 'error';
      state.process.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      state.process.closing = false;
    }

    state.process.state = 'starting';
    try {
      await launchManualBrowser(state, selectedBrowser, loginUrl);
      state.process.state = 'manual';
      return manualLoginSnapshot(state, loginUrl);
    } catch (error) {
      await shutdownOwnedBrowser(state).catch(() => undefined);
      state.process.state = 'error';
      state.process.lastError = error instanceof Error ? error.message : String(error);
      releaseProfileLease(state);
      if (error instanceof BrowserOwnerError) throw error;
      throw new BrowserOwnerError(
        'browser.manual-login-unavailable',
        'Failed to launch the dedicated host browser for manual login',
        { cause: error },
      );
    }
  }

export async function resumeManualLogin(state: BrowserOwnerState): Promise<ManualLoginResumeSnapshot> {
    if (state.process.state !== 'manual' || state.process.ownership !== 'manual') {
      throw new BrowserOwnerError(
        'browser.manual-login-not-active',
        'No SessionPlane manual login browser is active',
      );
    }

    state.process.closing = true;
    state.process.state = 'stopping';
    try {
      const lockedPid = existsSync(state.profile.lockPath)
        ? readProfileLock(state.profile.lockPath).browserPid ?? null
        : null;
      const pid = state.process.browserPid ?? lockedPid;
      if (pid !== null && isProcessAlive(pid)) {
        await stopOwnedBrowserProcess(state, pid, null);
      }
      const child = state.process.browserProcess;
      if (child !== null) await waitForChildExit(child, 2_000);
      state.process.browserProcess = null;
      state.process.browserPid = null;
      state.process.debuggingPort = null;
      state.process.ownership = null;
      state.login.manualLoginUrl = null;
      releaseProfileLease(state);
      state.process.state = 'stopped';
    } catch (error) {
      state.process.state = 'manual';
      throw error;
    } finally {
      state.process.closing = false;
    }

    await startOrAdoptBrowserProcess(state);
    return Object.freeze({
      requestOk: true,
      mode: 'automated',
      browser: browserOwnerStatus(state),
    });
  }

export function manualLoginSnapshot(state: BrowserOwnerState, loginUrl: string): ManualLoginSnapshot {
    return Object.freeze({
      requestOk: true,
      mode: 'manual',
      url: loginUrl,
      browser: browserOwnerStatus(state),
      instruction:
        'Complete sign-in in the dedicated browser window, then run `sessplane login --resume`.',
    });
  }

export async function launchManualBrowser(state: BrowserOwnerState,
    browser: ChromeInstallation,
    loginUrl: string,
  ): Promise<void> {
    prepareBrowserMetrics(state.profile.profileDir, state.process.persistentMetrics, state.process.now().getTime());
    const child = spawn(
      browser.executable,
      buildManualLoginArguments({ profileDir: state.profile.profileDir, loginUrl, persistentMetrics: state.process.persistentMetrics }),
      {
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    state.process.browserProcess = child;
    state.process.browserPid = child.pid ?? null;
    state.process.debuggingPort = null;
    state.process.ownership = 'manual';
    state.login.manualLoginUrl = loginUrl;
    state.process.browserStderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      state.process.browserStderrTail = `${state.process.browserStderrTail}${chunk}`.slice(-8_000);
    });
    child.once('exit', (code, signal) => {
      if (state.process.browserProcess !== child || state.process.closing) return;
      state.process.browserProcess = null;
      state.process.browserPid = null;
      if (code !== 0 && code !== null) {
        state.process.lastError = `Manual login browser exited with code ${code}${
          signal === null ? '' : ` from ${signal}`
        }`;
      }
    });
    child.unref();
    (child.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null)?.unref?.();

    if (child.pid === undefined) {
      throw new BrowserOwnerError(
        'browser.manual-login-unavailable',
        'Manual login browser process did not expose a PID',
      );
    }
    recordOwnedBrowserProcess(state, child.pid, null, 'manual');
    await waitForManualBrowserStartup(
      child,
      Math.min(state.process.launchTimeoutMs, 2_000),
      () => state.process.browserStderrTail,
    );
  }
