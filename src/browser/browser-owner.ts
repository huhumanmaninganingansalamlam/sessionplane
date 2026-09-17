import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

type LaunchPersistentContext = (
  userDataDir: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1],
) => ReturnType<typeof chromium.launchPersistentContext>;

interface ProfileLockPayload {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

export interface BrowserOwnerOptions {
  readonly profileDir: string;
  readonly pageRegistry: PageRegistry;
  readonly headless?: boolean;
  readonly channel?: string;
  readonly launchTimeoutMs?: number;
  readonly launchPersistentContext?: LaunchPersistentContext;
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
  readonly #channel: string;
  readonly #launchTimeoutMs: number;
  readonly #launchPersistentContext: LaunchPersistentContext;
  readonly #now: () => Date;
  readonly #pid: number;
  readonly #lockPath: string;
  #lockToken: string | null = null;
  #context: BrowserContext | null = null;
  #browser: Browser | null = null;
  #state: BrowserRuntimeState = 'not_started';
  #chrome: ChromeInstallation | null = null;
  #lastError: string | null = null;
  #closing = false;

  constructor(options: BrowserOwnerOptions) {
    this.#profileDir = path.resolve(options.profileDir);
    this.#pageRegistry = options.pageRegistry;
    this.#headless = options.headless ?? false;
    this.#channel = options.channel ?? 'chrome';
    this.#launchTimeoutMs = options.launchTimeoutMs ?? 30_000;
    this.#launchPersistentContext =
      options.launchPersistentContext ??
      ((userDataDir, launchOptions) => chromium.launchPersistentContext(userDataDir, launchOptions));
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
      this.#acquireProfileLock();

      const context = await this.#launchPersistentContext(this.#profileDir, {
        channel: this.#channel,
        headless: this.#headless,
        acceptDownloads: true,
        timeout: this.#launchTimeoutMs,
      });
      this.#context = context;
      this.#browser = context.browser();
      this.#pageRegistry.attach(context);
      context.once('close', () => this.#handleDisconnect('BrowserContext closed'));
      this.#browser?.once('disconnected', () => this.#handleDisconnect('Browser disconnected'));
      this.#state = 'ready';
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.#state = 'error';
      this.#releaseProfileLock();
      if (error instanceof BrowserOwnerError) {
        throw error;
      }
      throw new BrowserOwnerError('browser.unavailable', 'Failed to launch persistent Chrome context', {
        cause: error,
      });
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
    const context = this.#context;
    this.#context = null;
    this.#browser = null;
    try {
      this.#pageRegistry.detach();
      if (context !== null) {
        await context.close();
      }
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
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: this.#launchTimeoutMs });
      return this.#pageRegistry.refreshPage(binding.pageKey);
    } catch (error) {
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

  #acquireProfileLock(): void {
    mkdirSync(this.#profileDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#profileDir, 0o700);
    const token = crypto.randomUUID();
    const payload: ProfileLockPayload = {
      pid: this.#pid,
      token,
      createdAt: this.#now().toISOString(),
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let descriptor: number | null = null;
      try {
        descriptor = openSync(this.#lockPath, 'wx', 0o600);
        writeFileSync(descriptor, JSON.stringify(payload), { encoding: 'utf8' });
        closeSync(descriptor);
        descriptor = null;
        chmodSync(this.#lockPath, 0o600);
        this.#lockToken = token;
        return;
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
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).pid !== 'number' ||
    typeof (parsed as Record<string, unknown>).token !== 'string' ||
    typeof (parsed as Record<string, unknown>).createdAt !== 'string'
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

