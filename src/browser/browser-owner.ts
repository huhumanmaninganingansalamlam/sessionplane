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

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import {
  findHostBrowser,
  type BrowserPreference,
  type BrowserRuntimeState,
  type BrowserStatusSource,
  type ChromeInstallation,
} from './browser-health.ts';
import { isChatGptUrl, type PageBindingSnapshot } from './page-binding.ts';
import { PageRegistry } from './page-registry.ts';
import {
  assertDedicatedBrowserProfile,
  BrowserProfileError,
  ensureProfileBrowserIdentity,
  resolveBrowserProfileDir,
} from './browser-profile.ts';

const MAX_LAUNCH_ATTEMPTS = 3;

type BrowserLockMode = 'cdp' | 'manual';

interface ProfileLockPayload {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
  readonly mode?: BrowserLockMode;
  readonly browserPid?: number;
  readonly debuggingPort?: number;
}

type AdoptedBrowser =
  | {
      readonly mode: 'cdp';
      readonly browserPid: number;
      readonly debuggingPort: number;
    }
  | {
      readonly mode: 'manual';
      readonly browserPid: number;
    };

export interface ManualLoginSnapshot {
  readonly requestOk: true;
  readonly mode: 'manual';
  readonly url: string;
  readonly browser: BrowserStatusSource;
  readonly instruction: string;
}

export interface ManualLoginResumeSnapshot {
  readonly requestOk: true;
  readonly mode: 'automated';
  readonly browser: BrowserStatusSource;
}

export interface BrowserOwnerOptions {
  readonly profileDir: string;
  readonly scopeProfileByBrowser?: boolean;
  readonly pageRegistry: PageRegistry;
  readonly headless?: boolean;
  readonly browserPreference?: BrowserPreference;
  readonly browserExecutable?: string | null;
  readonly launchTimeoutMs?: number;
  readonly now?: () => Date;
  readonly pid?: number;
}

export class BrowserOwnerError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BrowserOwnerError';
    this.errorCode = errorCode;
  }
}

export class BrowserOwner {
  readonly #profileRoot: string;
  readonly #scopeProfileByBrowser: boolean;
  #profileDir: string;
  readonly #pageRegistry: PageRegistry;
  readonly #headless: boolean;
  readonly #browserPreference: BrowserPreference;
  readonly #browserExecutable: string | null;
  readonly #launchTimeoutMs: number;
  readonly #now: () => Date;
  readonly #pid: number;
  #lockPath: string;
  #lockToken: string | null = null;
  #context: BrowserContext | null = null;
  #browser: Browser | null = null;
  #browserProcess: ChildProcess | null = null;
  #browserPid: number | null = null;
  #debuggingPort: number | null = null;
  #ownership: 'spawned' | 'adopted' | 'manual' | null = null;
  #manualLoginUrl: string | null = null;
  #browserStderrTail = '';
  #state: BrowserRuntimeState = 'not_started';
  #chrome: ChromeInstallation | null = null;
  #lastError: string | null = null;
  #closing = false;

  constructor(options: BrowserOwnerOptions) {
    this.#profileRoot = path.resolve(options.profileDir);
    this.#scopeProfileByBrowser = options.scopeProfileByBrowser ?? false;
    this.#profileDir = this.#profileRoot;
    this.#pageRegistry = options.pageRegistry;
    this.#headless = options.headless ?? false;
    this.#browserPreference = options.browserPreference ?? 'chrome';
    this.#browserExecutable = options.browserExecutable ?? null;
    this.#launchTimeoutMs = options.launchTimeoutMs ?? 30_000;
    this.#now = options.now ?? (() => new Date());
    this.#pid = options.pid ?? process.pid;
    this.#lockPath = path.join(this.#profileDir, '.sessionplane-profile.lock');
  }

  get status(): BrowserStatusSource {
    return Object.freeze({
      state: this.#state,
      profileDir: this.#profileDir,
      headless: this.#headless,
      chrome: this.#chrome,
      transport: this.#ownership === 'manual' ? null : 'cdp',
      ownership: this.#ownership,
      browserPid: this.#browserPid,
      debuggingPort: this.#debuggingPort,
      lastError: this.#lastError,
    });
  }

  async start(): Promise<void> {
    if (this.#state === 'ready' || this.#state === 'manual') return;
    if (this.#state === 'starting' || this.#state === 'stopping') {
      throw new BrowserOwnerError('browser.unavailable', `Browser owner is ${this.#state}`);
    }
    if (this.#state === 'disconnected' || this.#state === 'error') {
      await this.close();
    }

    this.#state = 'starting';
    this.#lastError = null;
    try {
      const selectedBrowser = this.#resolveBrowserProfile();
      const adopted = await this.#acquireProfileLock();
      ensureProfileBrowserIdentity(this.#profileDir, selectedBrowser, this.#now);

      if (adopted?.mode === 'manual') {
        this.#browserPid = adopted.browserPid;
        this.#debuggingPort = null;
        this.#ownership = 'manual';
        this.#state = 'manual';
        return;
      }

      let debuggingPort: number;
      if (adopted === null) {
        debuggingPort = await this.#launchOwnedBrowser(selectedBrowser);
      } else {
        this.#browserPid = adopted.browserPid;
        this.#debuggingPort = adopted.debuggingPort;
        this.#ownership = 'adopted';
        debuggingPort = adopted.debuggingPort;
      }

      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`, {
        timeout: this.#launchTimeoutMs,
      });
      const context = browser.contexts()[0];
      if (context === undefined) {
        throw new BrowserOwnerError(
          'browser.unavailable',
          'The host browser did not expose its persistent default BrowserContext over CDP',
        );
      }
      await verifyExpectedAutomationSurface(context, this.#headless);
      this.#context = context;
      this.#browser = browser;
      this.#pageRegistry.attach(context);
      context.once('close', () => this.#handleDisconnect('BrowserContext closed'));
      browser.once('disconnected', () => this.#handleDisconnect('Browser disconnected'));
      this.#state = 'ready';
    } catch (error) {
      await this.#shutdownBrowser().catch(() => undefined);
      const details = this.#browserStderrTail.trim();
      this.#lastError = [error instanceof Error ? error.message : String(error), details]
        .filter(Boolean)
        .join('\n');
      this.#state = 'error';
      this.#releaseProfileLock();
      if (error instanceof BrowserOwnerError) throw error;
      if (error instanceof BrowserProfileError) {
        throw new BrowserOwnerError(error.errorCode, error.message, { cause: error });
      }
      throw new BrowserOwnerError(
        'browser.unavailable',
        'Failed to launch and attach to the selected host browser',
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'not_started') {
      this.#releaseProfileLock();
      this.#state = 'stopped';
      return;
    }
    if (this.#closing) return;

    this.#closing = true;
    this.#state = 'stopping';
    try {
      this.#pageRegistry.detach();
      await this.#shutdownBrowser();
    } finally {
      this.#releaseProfileLock();
      this.#closing = false;
      this.#state = 'stopped';
    }
  }

  async restart(): Promise<BrowserStatusSource> {
    await this.close();
    await this.start();
    return this.status;
  }

  async resetProfile(): Promise<BrowserStatusSource> {
    await this.close();
    this.#resolveBrowserProfile();
    rmSync(this.#profileDir, { recursive: true, force: true });
    await this.start();
    return this.status;
  }

  async createPage(): Promise<{ readonly page: Page; readonly binding: PageBindingSnapshot }> {
    const context = this.#requireContext();
    const page = await context.newPage();
    return { page, binding: this.#pageRegistry.registerPage(page) };
  }

  async openLoginPage(loginUrl: string): Promise<PageBindingSnapshot> {
    const existing = this.#pageRegistry
      .listBindings({ includeClosed: false })
      .find((binding) => isChatGptUrl(binding.url));
    if (existing !== undefined) return existing;

    const { page, binding } = await this.createPage();
    try {
      await page.goto(loginUrl, { waitUntil: 'commit', timeout: this.#launchTimeoutMs });
      return this.#pageRegistry.refreshPage(binding.pageKey);
    } catch (error) {
      await page.close().catch(() => undefined);
      throw new BrowserOwnerError('browser.unavailable', 'Failed to open the ChatGPT login page', {
        cause: error,
      });
    }
  }

  async beginManualLogin(loginUrl: string): Promise<ManualLoginSnapshot> {
    if (this.#headless) {
      throw new BrowserOwnerError(
        'browser.manual-login-unavailable',
        'Manual login requires a headed host browser',
      );
    }
    if (this.#state === 'starting' || this.#state === 'stopping') {
      throw new BrowserOwnerError(
        'browser.unavailable',
        `Browser owner is ${this.#state}`,
      );
    }
    if (this.#state === 'manual') {
      return this.#manualLoginSnapshot(this.#manualLoginUrl ?? loginUrl);
    }
    if (this.#state === 'disconnected' || this.#state === 'error') {
      await this.close();
    }

    const activeBindings = this.#pageRegistry
      .listBindings({ includeClosed: false })
      .filter((binding) => binding.sessionId !== null || binding.generation !== null);
    if (activeBindings.length > 0) {
      throw new BrowserOwnerError(
        'browser.manual-login-blocked',
        `Manual login cannot interrupt ${activeBindings.length} bound browser Page(s)`,
      );
    }

    const selectedBrowser = this.#resolveBrowserProfile();
    if (this.#lockToken === null) {
      const adopted = await this.#acquireProfileLock();
      if (adopted?.mode === 'manual') {
        this.#browserPid = adopted.browserPid;
        this.#debuggingPort = null;
        this.#ownership = 'manual';
        this.#manualLoginUrl = loginUrl;
        this.#state = 'manual';
        return this.#manualLoginSnapshot(loginUrl);
      }
      if (adopted?.mode === 'cdp') {
        this.#browserPid = adopted.browserPid;
        this.#debuggingPort = adopted.debuggingPort;
        this.#ownership = 'adopted';
        await this.#stopOwnedProcess(adopted.browserPid, adopted.debuggingPort);
        this.#browserPid = null;
        this.#debuggingPort = null;
        this.#ownership = null;
      }
      ensureProfileBrowserIdentity(this.#profileDir, selectedBrowser, this.#now);
    }

    this.#closing = true;
    this.#state = 'stopping';
    try {
      this.#pageRegistry.detach();
      await this.#shutdownBrowser();
    } catch (error) {
      this.#state = 'error';
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.#closing = false;
    }

    this.#state = 'starting';
    try {
      await this.#launchManualBrowser(selectedBrowser, loginUrl);
      this.#state = 'manual';
      return this.#manualLoginSnapshot(loginUrl);
    } catch (error) {
      await this.#shutdownBrowser().catch(() => undefined);
      this.#state = 'error';
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#releaseProfileLock();
      if (error instanceof BrowserOwnerError) throw error;
      throw new BrowserOwnerError(
        'browser.manual-login-unavailable',
        'Failed to launch the dedicated host browser for manual login',
        { cause: error },
      );
    }
  }

  async resumeManualLogin(): Promise<ManualLoginResumeSnapshot> {
    if (this.#state !== 'manual' || this.#ownership !== 'manual') {
      throw new BrowserOwnerError(
        'browser.manual-login-not-active',
        'No SessionPlane manual login browser is active',
      );
    }

    this.#closing = true;
    this.#state = 'stopping';
    try {
      const lockedPid = existsSync(this.#lockPath)
        ? readProfileLock(this.#lockPath).browserPid ?? null
        : null;
      const pid = this.#browserPid ?? lockedPid;
      if (pid !== null && isProcessAlive(pid)) {
        await this.#stopOwnedProcess(pid, null);
      }
      const child = this.#browserProcess;
      if (child !== null) await waitForChildExit(child, 2_000);
      this.#browserProcess = null;
      this.#browserPid = null;
      this.#debuggingPort = null;
      this.#ownership = null;
      this.#manualLoginUrl = null;
      this.#releaseProfileLock();
      this.#state = 'stopped';
    } catch (error) {
      this.#state = 'manual';
      throw error;
    } finally {
      this.#closing = false;
    }

    await this.start();
    return Object.freeze({
      requestOk: true,
      mode: 'automated',
      browser: this.status,
    });
  }

  #manualLoginSnapshot(loginUrl: string): ManualLoginSnapshot {
    return Object.freeze({
      requestOk: true,
      mode: 'manual',
      url: loginUrl,
      browser: this.status,
      instruction:
        'Complete sign-in in the dedicated browser window, then run `sessplane login --resume`.',
    });
  }

  async #launchManualBrowser(
    browser: ChromeInstallation,
    loginUrl: string,
  ): Promise<void> {
    const child = spawn(
      browser.executable,
      buildManualLoginArguments({ profileDir: this.#profileDir, loginUrl }),
      {
        env: process.env,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    this.#browserProcess = child;
    this.#browserPid = child.pid ?? null;
    this.#debuggingPort = null;
    this.#ownership = 'manual';
    this.#manualLoginUrl = loginUrl;
    this.#browserStderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#browserStderrTail = `${this.#browserStderrTail}${chunk}`.slice(-8_000);
    });
    child.once('exit', (code, signal) => {
      if (this.#browserProcess !== child || this.#closing) return;
      this.#browserProcess = null;
      this.#browserPid = null;
      if (code !== 0 && code !== null) {
        this.#lastError = `Manual login browser exited with code ${code}${
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
    this.#recordBrowserProcess(child.pid, null, 'manual');
    await waitForManualBrowserStartup(
      child,
      Math.min(this.#launchTimeoutMs, 2_000),
      () => this.#browserStderrTail,
    );
  }

  #requireContext(): BrowserContext {
    if (this.#state !== 'ready' || this.#context === null) {
      throw new BrowserOwnerError('browser.unavailable', 'Browser context is not ready');
    }
    return this.#context;
  }

  #resolveBrowserProfile(): ChromeInstallation {
    const selected = findHostBrowser({
      preference: this.#browserPreference,
      ...(this.#browserExecutable === null
        ? {}
        : { executablePath: this.#browserExecutable }),
    });
    if (selected === null) {
      throw new BrowserOwnerError(
        'browser.unavailable',
        this.#browserExecutable === null
          ? `No supported host browser was found for ${this.#browserPreference}; ` +
            'install Chrome, Chromium, Edge, or Brave, or set ' +
            'SESSIONPLANE_BROWSER_EXECUTABLE'
          : `The selected host browser is unavailable or unsupported: ${this.#browserExecutable}`,
      );
    }
    const profileDir = resolveBrowserProfileDir({
      profileRoot: this.#profileRoot,
      browser: selected,
      scopeByBrowser: this.#scopeProfileByBrowser,
    });
    try {
      assertDedicatedBrowserProfile(profileDir);
    } catch (error) {
      if (error instanceof BrowserProfileError) {
        throw new BrowserOwnerError(error.errorCode, error.message, { cause: error });
      }
      throw error;
    }
    this.#chrome = selected;
    this.#profileDir = profileDir;
    this.#lockPath = path.join(profileDir, '.sessionplane-profile.lock');
    return selected;
  }

  async #launchOwnedBrowser(browser: ChromeInstallation): Promise<number> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_LAUNCH_ATTEMPTS; attempt += 1) {
      const debuggingPort = await reserveLoopbackPort();
      const child = spawn(
        browser.executable,
        buildHostBrowserArguments({
          profileDir: this.#profileDir,
          debuggingPort,
          headless: this.#headless,
        }),
        {
          env: process.env,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      this.#browserProcess = child;
      this.#browserPid = child.pid ?? null;
      this.#debuggingPort = debuggingPort;
      this.#ownership = 'spawned';
      this.#browserStderrTail = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        this.#browserStderrTail = `${this.#browserStderrTail}${chunk}`.slice(-8_000);
      });
      child.once('exit', (code, signal) => {
        if (this.#browserProcess !== child) return;
        this.#handleDisconnect(
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
        this.#recordBrowserProcess(child.pid, debuggingPort, 'cdp');
        await waitForCdpEndpoint(
          debuggingPort,
          child,
          this.#launchTimeoutMs,
          () => this.#browserStderrTail,
        );
        return debuggingPort;
      } catch (error) {
        lastError = error;
        await this.#stopOwnedProcess(child.pid ?? null, debuggingPort).catch(() => undefined);
        this.#browserProcess = null;
        this.#browserPid = null;
        this.#debuggingPort = null;
        this.#ownership = null;
        if (
          attempt >= MAX_LAUNCH_ATTEMPTS ||
          !isRetryableBrowserLaunchError(error, this.#browserStderrTail)
        ) {
          throw error;
        }
        await delay(100);
      }
    }
    throw lastError;
  }

  #handleDisconnect(reason: string): void {
    if (this.#closing || this.#state === 'stopped') return;
    this.#lastError = reason;
    this.#state = 'disconnected';
  }

  async #shutdownBrowser(): Promise<void> {
    const browser = this.#browser;
    const child = this.#browserProcess;
    const browserPid = this.#browserPid;
    const debuggingPort = this.#debuggingPort;
    const ownership = this.#ownership;
    this.#context = null;
    this.#browser = null;

    if (ownership === 'manual') {
      if (browserPid !== null && isProcessAlive(browserPid)) {
        await this.#stopOwnedProcess(browserPid, null);
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
        } catch {
          // The exact owned process is terminated below if graceful CDP close fails.
        }
      }

      if (child !== null && !(await waitForChildExit(child, 3_000))) {
        await this.#stopOwnedProcess(child.pid ?? browserPid, debuggingPort);
      } else if (
        child === null &&
        browserPid !== null &&
        isProcessAlive(browserPid)
      ) {
        await this.#stopOwnedProcess(browserPid, debuggingPort);
      }
      if (browser !== null && browser.isConnected()) {
        await settleWithin(browser.close(), 1_000);
      }
    }

    this.#browserProcess = null;
    this.#browserPid = null;
    this.#debuggingPort = null;
    this.#ownership = null;
    this.#manualLoginUrl = null;
  }

  async #stopOwnedProcess(pid: number | null, debuggingPort: number | null): Promise<void> {
    if (pid === null || !isProcessAlive(pid)) return;
    if (!processOwnsProfile(pid, this.#profileDir)) {
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

  #recordBrowserProcess(
    browserPid: number,
    debuggingPort: number | null,
    mode: BrowserLockMode,
  ): void {
    const token = this.#lockToken;
    if (token === null) {
      throw new BrowserOwnerError(
        'internal.invariant-violation',
        'Cannot record host browser ownership without a profile lock',
      );
    }
    const current = readProfileLock(this.#lockPath);
    if (current.token !== token || current.pid !== this.#pid) {
      throw new BrowserOwnerError(
        'browser.unavailable',
        'Persistent profile lock changed while the host browser was starting',
      );
    }
    writeFileSync(
      this.#lockPath,
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
    chmodSync(this.#lockPath, 0o600);
  }

  async #acquireProfileLock(): Promise<AdoptedBrowser | null> {
    mkdirSync(this.#profileDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#profileDir, 0o700);
    const token = crypto.randomUUID();
    const payload: ProfileLockPayload = {
      pid: this.#pid,
      token,
      createdAt: this.#now().toISOString(),
    };
    let adopted: AdoptedBrowser | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let descriptor: number | null = null;
      try {
        descriptor = openSync(this.#lockPath, 'wx', 0o600);
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
        chmodSync(this.#lockPath, 0o600);
        this.#lockToken = token;
        return adopted;
      } catch (error) {
        if (descriptor !== null) closeSync(descriptor);
        if (!isErrno(error, 'EEXIST')) throw error;

        const existing = readProfileLock(this.#lockPath);
        if (isProcessAlive(existing.pid)) {
          throw new BrowserOwnerError(
            'browser.unavailable',
            `Persistent profile is already owned by process ${existing.pid}`,
          );
        }
        if (existing.browserPid !== undefined && isProcessAlive(existing.browserPid)) {
          if (!processOwnsProfile(existing.browserPid, this.#profileDir)) {
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
            await terminateProcessGroup(existing.browserPid);
            adopted = null;
          }
        }
        unlinkSync(this.#lockPath);
      }
    }
    throw new BrowserOwnerError('browser.unavailable', 'Could not acquire persistent profile lock');
  }

  #releaseProfileLock(): void {
    const token = this.#lockToken;
    this.#lockToken = null;
    if (token === null || !existsSync(this.#lockPath)) return;
    try {
      const payload = readProfileLock(this.#lockPath);
      if (payload.token === token) unlinkSync(this.#lockPath);
    } catch {
      // Fail closed: never remove a lock whose ownership can no longer be proven.
    }
  }
}

export function buildHostBrowserArguments(input: {
  readonly profileDir: string;
  readonly debuggingPort: number;
  readonly headless: boolean;
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
    ...(input.headless ? ['--headless=new'] : []),
    'about:blank',
  ]);
}

export function buildManualLoginArguments(input: {
  readonly profileDir: string;
  readonly loginUrl: string;
}): readonly string[] {
  return Object.freeze([
    `--user-data-dir=${path.resolve(input.profileDir)}`,
    '--window-size=1440,900',
    '--no-first-run',
    '--no-default-browser-check',
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

async function verifyExpectedAutomationSurface(
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

async function reserveLoopbackPort(): Promise<number> {
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

async function waitForCdpEndpoint(
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

async function waitForManualBrowserStartup(
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

function formatStderrSuffix(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? '' : `: ${trimmed.slice(-2_000)}`;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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

async function settleWithin<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
): Promise<Result | undefined> {
  return await Promise.race([
    operation.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

async function terminateProcessGroup(pid: number): Promise<void> {
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

function processOwnsProfile(pid: number, profileDir: string): boolean {
  const expected = `--user-data-dir=${path.resolve(profileDir)}`;
  const commandLine = readProcessCommandLine(pid);
  return commandLine !== null && commandLineContainsArgument(commandLine, expected);
}

function processOwnsDebuggingPort(pid: number, debuggingPort: number): boolean {
  const expected = `--remote-debugging-port=${debuggingPort}`;
  const commandLine = readProcessCommandLine(pid);
  return commandLine !== null && commandLineContainsArgument(commandLine, expected);
}

function readProcessCommandLine(pid: number): string | null {
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

function commandLineContainsArgument(commandLine: string, expected: string): boolean {
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

async function isCdpEndpointReady(port: number): Promise<boolean> {
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

function readProfileLock(lockPath: string): ProfileLockPayload {
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
