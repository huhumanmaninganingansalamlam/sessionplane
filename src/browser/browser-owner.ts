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

type LaunchPersistentContext = (
  userDataDir: string,
  options: Parameters<typeof chromium.launchPersistentContext>[1],
) => ReturnType<typeof chromium.launchPersistentContext>;

const HOST_BROWSER_IGNORED_DEFAULT_ARGS = [
  '--password-store=basic',
  '--use-mock-keychain',
  // Host browsers must retain their real process sandbox. Playwright normally
  // adds --no-sandbox unless chromiumSandbox is explicitly enabled below; keep
  // these entries as a second fail-closed guard against launcher changes.
  '--no-sandbox',
  '--disable-setuid-sandbox',
  // These switches are not needed for SessionPlane and either suppress browser
  // safety UI or disable a DevTools self-XSS warning in an interactive browser.
  '--disable-infobars',
  '--unsafely-disable-devtools-self-xss-warnings',
] as const;

interface ProfileLockPayload {
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

export interface BrowserOwnerOptions {
  readonly profileDir: string;
  readonly scopeProfileByBrowser?: boolean;
  readonly pageRegistry: PageRegistry;
  readonly headless?: boolean;
  readonly browserPreference?: BrowserPreference;
  readonly browserExecutable?: string | null;
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
  readonly #profileRoot: string;
  readonly #scopeProfileByBrowser: boolean;
  #profileDir: string;
  readonly #pageRegistry: PageRegistry;
  readonly #headless: boolean;
  readonly #browserPreference: BrowserPreference;
  readonly #browserExecutable: string | null;
  readonly #launchTimeoutMs: number;
  readonly #launchPersistentContext: LaunchPersistentContext;
  readonly #now: () => Date;
  readonly #pid: number;
  #lockPath: string;
  #lockToken: string | null = null;
  #context: BrowserContext | null = null;
  #browser: Browser | null = null;
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
    this.#browserPreference = options.browserPreference ?? 'chromium';
    this.#browserExecutable = options.browserExecutable ?? null;
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
      transport: 'playwright',
      ownership: 'playwright',
      browserPid: null,
      debuggingPort: null,
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
      const selectedBrowser = this.#resolveBrowserProfile();
      this.#acquireProfileLock();
      ensureProfileBrowserIdentity(this.#profileDir, selectedBrowser, this.#now);

      const context = await this.#launchPersistentContext(this.#profileDir, {
        executablePath: selectedBrowser.executable,
        headless: this.#headless,
        // Playwright defaults to --no-sandbox. A user-installed host browser is
        // interactive and long-lived, so SessionPlane always keeps Chromium's
        // native process sandbox enabled and never silently falls back.
        chromiumSandbox: true,
        acceptDownloads: true,
        timeout: this.#launchTimeoutMs,
        // Preserve same-user Chromium profile authentication when importing a
        // dedicated profile created outside Playwright. These Playwright
        // defaults switch Chrome away from the user's normal OS keyring.
        ignoreDefaultArgs: [...HOST_BROWSER_IGNORED_DEFAULT_ARGS],
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
      if (error instanceof BrowserProfileError) {
        throw new BrowserOwnerError(error.errorCode, error.message, { cause: error });
      }
      throw new BrowserOwnerError(
        'browser.unavailable',
        'Failed to launch the selected host browser persistent context',
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

