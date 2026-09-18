import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { ChromeInstallation } from './browser-health.ts';

interface BrowserProfileIdentity {
  readonly schemaVersion?: number;
  readonly product: ChromeInstallation['product'];
  readonly executable: string;
  readonly recordedAt: string;
}

export interface BrowserProfileSafetyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
}

export class BrowserProfileError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BrowserProfileError';
    this.errorCode = errorCode;
  }
}

export function resolveBrowserProfileDir(input: {
  readonly profileRoot: string;
  readonly browser: ChromeInstallation;
  readonly scopeByBrowser: boolean;
}): string {
  const root = path.resolve(input.profileRoot);
  return input.scopeByBrowser ? path.join(root, input.browser.product) : root;
}

export function assertDedicatedBrowserProfile(
  profileDir: string,
  options: BrowserProfileSafetyOptions = {},
): void {
  const platform = options.platform ?? process.platform;
  const candidate = normalizedForComparison(resolveCanonicalPath(profileDir), platform);
  for (const personalRoot of personalBrowserProfileRoots(options)) {
    const root = normalizedForComparison(resolveCanonicalPath(personalRoot), platform);
    if (
      candidate === root ||
      candidate.startsWith(`${root}${path.sep}`) ||
      root.startsWith(`${candidate}${path.sep}`)
    ) {
      throw new BrowserProfileError(
        'browser.profile-personal',
        `Refusing to use personal/default browser profile path: ${profileDir}`,
      );
    }
  }
}

export function ensureProfileBrowserIdentity(
  profileDir: string,
  browser: ChromeInstallation,
  now: () => Date = () => new Date(),
): void {
  const identityPath = path.join(profileDir, '.sessionplane-browser.json');
  if (existsSync(identityPath)) {
    const existing = readBrowserProfileIdentity(identityPath);
    if (existing.product !== browser.product) {
      throw new BrowserProfileError(
        'browser.profile-incompatible',
        `Profile ${profileDir} belongs to ${existing.product} ` +
          `(${existing.executable}), not ${browser.product} (${browser.executable}); ` +
          'use the browser-scoped default profile or an explicit separate SESSIONPLANE_PROFILE_DIR',
      );
    }
    return;
  }

  writeFileSync(
    identityPath,
    JSON.stringify({
      schemaVersion: 1,
      product: browser.product,
      executable: browser.executable,
      recordedAt: now().toISOString(),
    } satisfies BrowserProfileIdentity),
    { encoding: 'utf8', mode: 0o600 },
  );
  chmodSync(identityPath, 0o600);
}

export function personalBrowserProfileRoots(
  options: BrowserProfileSafetyOptions = {},
): readonly string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = path.resolve(options.homeDir ?? homedir());

  if (platform === 'win32') {
    const localAppData = path.resolve(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'));
    return Object.freeze([
      path.join(localAppData, 'Google', 'Chrome', 'User Data'),
      path.join(localAppData, 'Chromium', 'User Data'),
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data'),
    ]);
  }

  if (platform === 'darwin') {
    const applicationSupport = path.join(home, 'Library', 'Application Support');
    return Object.freeze([
      path.join(applicationSupport, 'Google', 'Chrome'),
      path.join(applicationSupport, 'Chromium'),
      path.join(applicationSupport, 'Microsoft Edge'),
      path.join(applicationSupport, 'BraveSoftware', 'Brave-Browser'),
    ]);
  }

  return Object.freeze([
    path.join(home, '.config', 'google-chrome'),
    path.join(home, '.config', 'chromium'),
    path.join(home, '.config', 'microsoft-edge'),
    path.join(home, '.config', 'BraveSoftware', 'Brave-Browser'),
    path.join(home, 'snap', 'chromium', 'common', 'chromium'),
    path.join(home, '.var', 'app', 'com.google.Chrome', 'config', 'google-chrome'),
    path.join(home, '.var', 'app', 'org.chromium.Chromium', 'config', 'chromium'),
    path.join(
      home,
      '.var',
      'app',
      'com.microsoft.Edge',
      'config',
      'microsoft-edge',
    ),
    path.join(
      home,
      '.var',
      'app',
      'com.brave.Browser',
      'config',
      'BraveSoftware',
      'Brave-Browser',
    ),
  ]);
}

function readBrowserProfileIdentity(identityPath: string): BrowserProfileIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(identityPath, 'utf8')) as unknown;
  } catch (error) {
    throw new BrowserProfileError(
      'browser.profile-invalid',
      `Browser profile identity is unreadable: ${identityPath}`,
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new BrowserProfileError(
      'browser.profile-invalid',
      `Browser profile identity is malformed: ${identityPath}`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.product !== 'string' ||
    !['chrome', 'chromium', 'edge', 'brave'].includes(record.product) ||
    typeof record.executable !== 'string' ||
    record.executable.trim() === '' ||
    typeof record.recordedAt !== 'string' ||
    Number.isNaN(Date.parse(record.recordedAt)) ||
    (record.schemaVersion !== undefined && record.schemaVersion !== 1)
  ) {
    throw new BrowserProfileError(
      'browser.profile-invalid',
      `Browser profile identity is malformed: ${identityPath}`,
    );
  }
  return record as unknown as BrowserProfileIdentity;
}

function normalizedForComparison(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLowerCase() : value;
}

function resolveCanonicalPath(value: string): string {
  const absolute = path.resolve(value);
  const missingSegments: string[] = [];
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return absolute;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(realpathSync(existing), ...missingSegments);
  } catch {
    return absolute;
  }
}
