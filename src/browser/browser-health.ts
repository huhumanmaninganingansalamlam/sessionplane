import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import type { PageBindingSnapshot } from './page-binding.ts';

export type BrowserRuntimeState =
  | 'not_started'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'disconnected'
  | 'error';

export type BrowserPreference =
  | 'auto'
  | 'chrome'
  | 'chromium'
  | 'edge'
  | 'brave'
  | 'custom';

export type HostBrowserProduct = Exclude<BrowserPreference, 'auto' | 'custom'>;

export interface ChromeInstallation {
  readonly executable: string;
  readonly version: string;
  readonly source: 'host';
  readonly product: HostBrowserProduct;
}

export interface HostBrowserDiscoveryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly preference?: BrowserPreference;
  readonly executablePath?: string;
  readonly includePlatformDefaults?: boolean;
}

export interface BrowserStatusSource {
  readonly state: BrowserRuntimeState;
  readonly profileDir: string;
  readonly headless: boolean;
  readonly chrome: ChromeInstallation | null;
  readonly transport: 'cdp' | null;
  readonly ownership: 'spawned' | 'adopted' | null;
  readonly browserPid: number | null;
  readonly debuggingPort: number | null;
  readonly lastError: string | null;
}

interface BrowserCandidate {
  readonly product: HostBrowserProduct;
  readonly executable: string;
}

const AUTO_PREFERENCE_ORDER = ['chromium', 'chrome', 'edge', 'brave'] as const;

export function findHostBrowser(
  options: HostBrowserDiscoveryOptions = {},
): ChromeInstallation | null {
  const preference = options.preference ?? 'auto';
  if (options.executablePath !== undefined) {
    return inspectBrowserExecutable(null, options.executablePath);
  }
  if (preference === 'custom') return null;

  const browsers = listHostBrowsers(options);
  if (preference === 'auto') {
    return browsers[0] ?? null;
  }
  return browsers.find((browser) => browser.product === preference) ?? null;
}

export function listHostBrowsers(
  options: HostBrowserDiscoveryOptions = {},
): readonly ChromeInstallation[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const preference = options.preference ?? 'auto';
  const candidates = browserCandidates(
    env,
    platform,
    options.includePlatformDefaults ?? true,
  );
  const seen = new Set<string>();
  const discovered: ChromeInstallation[] = [];

  for (const candidate of candidates) {
    if (preference !== 'auto' && preference !== candidate.product) continue;
    const browser = inspectBrowserExecutable(candidate.product, candidate.executable);
    if (browser === null || seen.has(browser.executable)) continue;
    seen.add(browser.executable);
    discovered.push(browser);
  }

  discovered.sort((left, right) => {
    const leftRank = AUTO_PREFERENCE_ORDER.indexOf(
      left.product as (typeof AUTO_PREFERENCE_ORDER)[number],
    );
    const rightRank = AUTO_PREFERENCE_ORDER.indexOf(
      right.product as (typeof AUTO_PREFERENCE_ORDER)[number],
    );
    return leftRank - rightRank || left.executable.localeCompare(right.executable);
  });
  return Object.freeze(discovered);
}

function inspectBrowserExecutable(
  productHint: HostBrowserProduct | null,
  executablePath: string,
): ChromeInstallation | null {
  let candidate = resolve(executablePath);
  try {
    accessSync(candidate, constants.X_OK);
    candidate = realpathSync(candidate);
  } catch {
    return null;
  }
  if (isPlaywrightManagedBrowserPath(candidate)) return null;

  const result = spawnSync(candidate, ['--version'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0) return null;
  const version = (result.stdout.trim() || result.stderr.trim()).trim();
  if (version === '' || /chrome for testing/i.test(version)) return null;
  const product = browserProductFromVersion(version) ?? productHint;
  if (product === null) return null;

  return Object.freeze({
    executable: candidate,
    version,
    source: 'host',
    product,
  });
}

function browserProductFromVersion(version: string): HostBrowserProduct | null {
  if (/brave/i.test(version)) return 'brave';
  if (/microsoft edge|msedge/i.test(version)) return 'edge';
  if (/google chrome/i.test(version)) return 'chrome';
  if (/chromium/i.test(version)) return 'chromium';
  return null;
}

function isPlaywrightManagedBrowserPath(candidate: string): boolean {
  return /(?:^|[\\/])ms-playwright(?:[\\/]|$)/i.test(candidate);
}

function browserCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  includePlatformDefaults: boolean,
): readonly BrowserCandidate[] {
  const pathDirectories = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const candidates: BrowserCandidate[] = [];
  const addPathNames = (
    product: BrowserCandidate['product'],
    names: readonly string[],
  ): void => {
    for (const directory of pathDirectories) {
      for (const name of names) candidates.push({ product, executable: join(directory, name) });
    }
  };

  if (platform === 'win32') {
    addPathNames('chrome', ['chrome.exe']);
    addPathNames('chromium', ['chromium.exe']);
    addPathNames('edge', ['msedge.exe']);
    addPathNames('brave', ['brave.exe']);
    if (!includePlatformDefaults) return candidates;
    const programFiles = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
      .filter((value): value is string => value !== undefined && value !== '');
    for (const root of programFiles) {
      candidates.push(
        { product: 'chrome', executable: join(root, 'Google/Chrome/Application/chrome.exe') },
        { product: 'edge', executable: join(root, 'Microsoft/Edge/Application/msedge.exe') },
        { product: 'brave', executable: join(root, 'BraveSoftware/Brave-Browser/Application/brave.exe') },
        { product: 'chromium', executable: join(root, 'Chromium/Application/chrome.exe') },
      );
    }
    return candidates;
  }

  if (platform === 'darwin') {
    addPathNames('chrome', ['google-chrome', 'google-chrome-stable']);
    addPathNames('chromium', ['chromium']);
    addPathNames('edge', ['microsoft-edge']);
    addPathNames('brave', ['brave-browser']);
    if (!includePlatformDefaults) return candidates;
    const home = env.HOME ?? '';
    for (const applicationsRoot of ['/Applications', join(home, 'Applications')]) {
      candidates.push(
        {
          product: 'chrome',
          executable: join(
            applicationsRoot,
            'Google Chrome.app/Contents/MacOS/Google Chrome',
          ),
        },
        {
          product: 'chromium',
          executable: join(applicationsRoot, 'Chromium.app/Contents/MacOS/Chromium'),
        },
        {
          product: 'edge',
          executable: join(
            applicationsRoot,
            'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ),
        },
        {
          product: 'brave',
          executable: join(
            applicationsRoot,
            'Brave Browser.app/Contents/MacOS/Brave Browser',
          ),
        },
      );
    }
    return candidates;
  }

  addPathNames('chrome', ['google-chrome', 'google-chrome-stable']);
  addPathNames('chromium', ['chromium', 'chromium-browser', 'org.chromium.Chromium']);
  addPathNames('edge', ['microsoft-edge', 'microsoft-edge-stable']);
  addPathNames('brave', ['brave-browser', 'brave-browser-stable']);
  if (!includePlatformDefaults) return candidates;
  const home = env.HOME ?? '';
  candidates.push(
    { product: 'chrome', executable: '/usr/bin/google-chrome' },
    { product: 'chrome', executable: '/usr/bin/google-chrome-stable' },
    { product: 'chrome', executable: '/opt/google/chrome/google-chrome' },
    { product: 'chromium', executable: '/usr/bin/chromium' },
    { product: 'chromium', executable: '/usr/bin/chromium-browser' },
    { product: 'chromium', executable: '/snap/bin/chromium' },
    {
      product: 'chromium',
      executable: '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    },
    ...(home === ''
      ? []
      : [
          {
            product: 'chromium' as const,
            executable: join(
              home,
              '.local/share/flatpak/exports/bin/org.chromium.Chromium',
            ),
          },
        ]),
    { product: 'edge', executable: '/usr/bin/microsoft-edge' },
    { product: 'edge', executable: '/usr/bin/microsoft-edge-stable' },
    { product: 'edge', executable: '/opt/microsoft/msedge/msedge' },
    { product: 'brave', executable: '/usr/bin/brave-browser' },
    { product: 'brave', executable: '/usr/bin/brave-browser-stable' },
    { product: 'brave', executable: '/opt/brave.com/brave/brave-browser' },
  );
  return candidates;
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
