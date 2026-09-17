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
import { homedir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import {
  findInstalledChrome,
  type BrowserRuntimeState,
  type BrowserStatusSource,
  type ChromeInstallation,
} from './browser-health.ts';
import { isChatGptUrl, type PageBindingSnapshot } from './page-binding.ts';
import { PageRegistry } from './page-registry.ts';

interface ProfileLockPayload {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
  readonly browserPid?: number;
  readonly debuggingPort?: number;
}

interface AdoptedChrome {
  readonly browserPid: number;
  readonly debuggingPort: number;
}

export interface BrowserOwnerOptions {
  readonly profileDir: string;
  readonly pageRegistry: PageRegistry;
  readonly headless?: boolean;
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
  readonly #profileDir: string;
  readonly #pageRegistry: PageRegistry;
  readonly #headless: boolean;
  readonly #launchTimeoutMs: number;
  readonly #now: () => Date;
  readonly #pid: number;
  readonly #lockPath: string;
  #lockToken: string | null = null;
  #context: BrowserContext | null = null;
  #browser: Browser | null = null;
  #chromeProcess: ChildProcess | null = null;
  #browserPid: number | null = null;
  #debuggingPort: number | null = null;
  #ownership: 'spawned' | 'adopted' | null = null;
  #chromeStderrTail = '';
  #state: BrowserRuntimeState = 'not_started';
  #chrome: ChromeInstallation | null = null;
  #lastError: string | null = null;
  #closing = false;

  constructor(options: BrowserOwnerOptions) {
    this.#profileDir = path.resolve(options.profileDir);
    this.#pageRegistry = options.pageRegistry;
    this.#headless = options.headless ?? false;
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
      transport: 'cdp',
      ownership: this.#ownership,
      browserPid: this.#browserPid,
      debuggingPort: this.#debuggingPort,
      lastError: this.#lastError,
    });
  }

  async start(): Promise<void> {
    if (this.#state === 'ready') {
      return;
    }
    if (this.#state === 'starting' || this.#state === 'stopping') {
      throw new BrowserOwnerError('browser.unavailable', `Browser owner is ${this.#state}`);
    }

    this.#state = 'starting';
    this.#lastError = null;
    try {
      assertDedicatedProfile(this.#profileDir);
      this.#chrome = findInstalledChrome();
      if (this.#chrome === null) {
        throw new BrowserOwnerError('browser.unavailable', 'Installed Google Chrome was not found');
      }
      const adopted = await this.#acquireProfileLock();
      let debuggingPort: number;
      if (adopted !== null) {
        debuggingPort = adopted.debuggingPort;
        this.#browserPid = adopted.browserPid;
        this.#debuggingPort = adopted.debuggingPort;
        this.#ownership = 'adopted';
      } else {
        debuggingPort = await reserveLoopbackPort();
        const chromeProcess = spawn(
          this.#chrome.executable,
          buildChromeArguments({
            profileDir: this.#profileDir,
            debuggingPort,
            headless: this.#headless,
          }),
          {
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        this.#chromeProcess = chromeProcess;
        this.#debuggingPort = debuggingPort;
        this.#ownership = 'spawned';
        this.#chromeStderrTail = '';
        chromeProcess.stderr?.setEncoding('utf8');
        chromeProcess.stderr?.on('data', (chunk: string) => {
          this.#chromeStderrTail = `${this.#chromeStderrTail}${chunk}`.slice(-8_000);
        });
        chromeProcess.once('exit', (code, signal) => {
          this.#handleDisconnect(
            `Chrome exited${code === null ? '' : ` with code ${code}`}${
              signal === null ? '' : ` from ${signal}`
            }`,
          );
        });
        if (chromeProcess.pid === undefined) {
          throw new BrowserOwnerError('browser.unavailable', 'Chrome process did not expose a PID');
        }
        this.#browserPid = chromeProcess.pid;
        this.#recordBrowserProcess(chromeProcess.pid, debuggingPort);
        await waitForCdpEndpoint(
          debuggingPort,
          chromeProcess,
          this.#launchTimeoutMs,
          () => this.#chromeStderrTail,
        );
      }

      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debuggingPort}`, {
        timeout: this.#launchTimeoutMs,
      });
      const context = browser.contexts()[0];
      if (context === undefined) {
        throw new BrowserOwnerError(
          'browser.unavailable',
          'Chrome did not expose its persistent default BrowserContext over CDP',
        );
      }
      this.#context = context;
      this.#browser = browser;
      this.#pageRegistry.attach(context);
      context.once('close', () => this.#handleDisconnect('BrowserContext closed'));
      browser.once('disconnected', () => this.#handleDisconnect('Browser disconnected'));
      this.#state = 'ready';
    } catch (error) {
      await this.#shutdownChrome();
      const details = this.#chromeStderrTail.trim();
      this.#lastError = [error instanceof Error ? error.message : String(error), details]
        .filter(Boolean)
        .join('\n');
      this.#state = 'error';
      this.#releaseProfileLock();
      if (error instanceof BrowserOwnerError) {
        throw error;
      }
      throw new BrowserOwnerError(
        'browser.unavailable',
        'Failed to launch and attach to the SessionPlane Chrome process',
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
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    this.#state = 'stopping';
    try {
      this.#pageRegistry.detach();
      await this.#shutdownChrome();
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
    if (existing !== undefined) {
      return existing;
    }

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

  #requireContext(): BrowserContext {
    if (this.#state !== 'ready' || this.#context === null) {
      throw new BrowserOwnerError('browser.unavailable', 'Browser context is not ready');
    }
    return this.#context;
  }

  #handleDisconnect(reason: string): void {
    if (this.#closing || this.#state === 'stopped') {
      return;
    }
    this.#lastError = reason;
    this.#state = 'disconnected';
  }

  async #shutdownChrome(): Promise<void> {
    const browser = this.#browser;
    const chromeProcess = this.#chromeProcess;
    const browserPid = this.#browserPid;
    this.#context = null;
    this.#browser = null;
    this.#chromeProcess = null;
    this.#browserPid = null;
    this.#debuggingPort = null;
    this.#ownership = null;

    if (browser !== null && browser.isConnected()) {
      try {
        const session = await settleWithin(browser.newBrowserCDPSession(), 1_000);
        if (session !== undefined) {
          await settleWithin(session.send('Browser.close'), 1_000);
          void session.detach().catch(() => undefined);
        }
      } catch {
        // The owned Chrome process is terminated below even if CDP disappears.
      }
    }

    if (chromeProcess !== null) {
      if (!(await waitForChildExit(chromeProcess, 3_000))) {
        chromeProcess.kill('SIGTERM');
      }
      if (!(await waitForChildExit(chromeProcess, 2_000))) {
        chromeProcess.kill('SIGKILL');
        await waitForChildExit(chromeProcess, 1_000);
      }
    } else if (
      browserPid !== null &&
      isProcessAlive(browserPid) &&
      processOwnsProfile(browserPid, this.#profileDir)
    ) {
      await terminateProcess(browserPid);
    }
    if (browser !== null && browser.isConnected()) {
      await settleWithin(browser.close(), 1_000);
    }
  }

  #recordBrowserProcess(browserPid: number, debuggingPort: number): void {
    const token = this.#lockToken;
    if (token === null) {
      throw new BrowserOwnerError(
        'internal.invariant-violation',
        'Cannot record Chrome ownership without a profile lock',
      );
    }
    const current = readProfileLock(this.#lockPath);
    if (current.token !== token || current.pid !== this.#pid) {
      throw new BrowserOwnerError(
        'browser.unavailable',
        'Persistent profile lock changed while Chrome was starting',
      );
    }
    writeFileSync(
      this.#lockPath,
      JSON.stringify({ ...current, browserPid, debuggingPort }),
      { encoding: 'utf8', mode: 0o600 },
    );
    chmodSync(this.#lockPath, 0o600);
  }

  async #acquireProfileLock(): Promise<AdoptedChrome | null> {
    mkdirSync(this.#profileDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#profileDir, 0o700);
    const token = crypto.randomUUID();
    const payload: ProfileLockPayload = {
      pid: this.#pid,
      token,
      createdAt: this.#now().toISOString(),
    };
    let adopted: AdoptedChrome | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let descriptor: number | null = null;
      try {
        descriptor = openSync(this.#lockPath, 'wx', 0o600);
        writeFileSync(
          descriptor,
          JSON.stringify(
            adopted === null
              ? payload
              : {
                  ...payload,
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
        if (descriptor !== null) {
          closeSync(descriptor);
        }
        if (!isErrno(error, 'EEXIST')) {
          throw error;
        }
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
              `Stale profile lock references live process ${existing.browserPid}, but its Chrome profile ownership cannot be proven`,
            );
          }
          if (
            existing.debuggingPort !== undefined &&
            processOwnsDebuggingPort(existing.browserPid, existing.debuggingPort) &&
            (await isCdpEndpointReady(existing.debuggingPort))
          ) {
            adopted = {
              browserPid: existing.browserPid,
              debuggingPort: existing.debuggingPort,
            };
          } else {
            await terminateProcess(existing.browserPid);
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
    if (token === null || !existsSync(this.#lockPath)) {
      return;
    }
    try {
      const payload = readProfileLock(this.#lockPath);
      if (payload.token === token) {
        unlinkSync(this.#lockPath);
      }
    } catch {
      // Fail closed: never remove a lock whose ownership can no longer be proven.
    }
  }
}

export function buildChromeArguments(input: {
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
    '--disable-dev-shm-usage',
    ...(input.headless ? ['--headless=new'] : []),
    'about:blank',
  ]);
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
  chromeProcess: ChildProcess,
  timeoutMs: number,
  stderrTail: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let spawnError: Error | null = null;
  const onError = (error: Error): void => {
    spawnError = error;
  };
  chromeProcess.once('error', onError);
  try {
    while (Date.now() < deadline) {
      if (spawnError !== null) {
        throw spawnError;
      }
      if (chromeProcess.exitCode !== null || chromeProcess.signalCode !== null) {
        throw new Error(
          `Chrome exited before CDP became ready${formatStderrSuffix(stderrTail())}`,
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
        });
        if (response.ok) {
          await response.body?.cancel().catch(() => undefined);
          return;
        }
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        if (error instanceof Error && error.name !== 'TimeoutError') {
          // Chrome commonly refuses the loopback connection until DevTools is ready.
        }
      }
      await delay(100);
    }
  } finally {
    chromeProcess.off('error', onError);
  }
  throw new Error(`Chrome CDP endpoint did not become ready${formatStderrSuffix(stderrTail())}`);
}

function formatStderrSuffix(value: string): string {
  const trimmed = value.trim();
  return trimmed === '' ? '' : `: ${trimmed.slice(-2_000)}`;
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
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

async function terminateProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (!isErrno(error, 'ESRCH')) throw error;
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await delay(50);
  }
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!isErrno(error, 'ESRCH')) throw error;
  }
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
    if ((before === '' || /\s/.test(before)) && (after === '' || /\s/.test(after))) {
      return true;
    }
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function assertDedicatedProfile(profileDir: string): void {
  const home = path.resolve(homedir());
  const personalRoots = [
    path.join(home, '.config', 'google-chrome'),
    path.join(home, '.config', 'chromium'),
    path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
  ].map((candidate) => path.resolve(candidate));
  if (personalRoots.some((candidate) => profileDir === candidate || profileDir.startsWith(`${candidate}${path.sep}`))) {
    throw new BrowserOwnerError(
      'browser.unavailable',
      'Refusing to use a personal/default Chrome profile; configure a SessionPlane-dedicated profile',
    );
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
    (record.browserPid !== undefined &&
      (typeof record.browserPid !== 'number' ||
        !Number.isSafeInteger(record.browserPid) ||
        record.browserPid <= 0)) ||
    (record.debuggingPort !== undefined &&
      (typeof record.debuggingPort !== 'number' ||
        !Number.isSafeInteger(record.debuggingPort) ||
        record.debuggingPort <= 0 ||
        record.debuggingPort > 65_535))
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

