import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { BrowserPreference } from './browser/browser-health.ts';
import { PROVIDERS, type ProviderName } from './providers/provider-adapter.ts';

export const SESSIONPLANE_VERSION = readSessionPlaneVersion();

function readSessionPlaneVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { readonly version?: unknown };
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error('package.json must define a nonempty version');
  }
  return packageJson.version;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SessionPlaneConfig {
  readonly cwd: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly databasePath: string;
  readonly profileDir: string;
  readonly browserScopedProfile: boolean;
  readonly artifactDir: string;
  readonly logLevel: LogLevel;
  readonly rpcMaxLineBytes: number;
  readonly rpcRequestTimeoutMs: number;
  readonly browserLaunchTimeoutMs: number;
  readonly browserHeadless: boolean;
  readonly browserPreference: BrowserPreference;
  readonly browserExecutable: string | null;
  readonly enabledProviders: readonly ProviderName[];
  readonly submissionAckTimeoutMs: number;
  readonly observationActiveSweepMs: number;
  readonly observationQuietSweepMs: number;
  readonly observationQuietWindowMs: number;
  readonly backendRecoveryAfterMs: number;
  readonly backendRequestTimeoutMs: number;
  readonly probeSuccessIntervalMs: number;
  readonly probeMin429BackoffMs: number;
  readonly probeMax429BackoffMs: number;
  readonly tokenCacheTtlMs: number;
  readonly maxUploadFileBytes: number;
  readonly maxArtifactFileBytes: number;
  readonly fetchTimeoutMs: number;
  readonly fetchMaxBytes: number;
  readonly fetchMaxRedirects: number;
  readonly fetchAllowPrivateNetworks: boolean;
  readonly searchMaxCandidates: number;
  readonly chatgptUrl: string;
  readonly geminiUrl: string;
  readonly grokUrl: string;
}

export interface ConfigOverrides {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDir?: string;
  readonly socketPath?: string;
  readonly databasePath?: string;
  readonly profileDir?: string;
  readonly artifactDir?: string;
  readonly logLevel?: LogLevel;
  readonly rpcMaxLineBytes?: number;
  readonly rpcRequestTimeoutMs?: number;
  readonly browserLaunchTimeoutMs?: number;
  readonly browserHeadless?: boolean;
  readonly browserPreference?: BrowserPreference;
  readonly browserExecutable?: string;
  readonly enabledProviders?: readonly string[];
  readonly submissionAckTimeoutMs?: number;
  readonly observationActiveSweepMs?: number;
  readonly observationQuietSweepMs?: number;
  readonly observationQuietWindowMs?: number;
  readonly backendRecoveryAfterMs?: number;
  readonly backendRequestTimeoutMs?: number;
  readonly probeSuccessIntervalMs?: number;
  readonly probeMin429BackoffMs?: number;
  readonly probeMax429BackoffMs?: number;
  readonly tokenCacheTtlMs?: number;
  readonly maxUploadFileBytes?: number;
  readonly maxArtifactFileBytes?: number;
  readonly fetchTimeoutMs?: number;
  readonly fetchMaxBytes?: number;
  readonly fetchMaxRedirects?: number;
  readonly fetchAllowPrivateNetworks?: boolean;
  readonly searchMaxCandidates?: number;
  readonly chatgptUrl?: string;
  readonly geminiUrl?: string;
  readonly grokUrl?: string;
}

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);
const BROWSER_PREFERENCES = new Set<BrowserPreference>([
  'auto',
  'chrome',
  'chromium',
  'edge',
  'brave',
  'custom',
]);

function resolvePath(base: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(base, value);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!LOG_LEVELS.has(value as LogLevel)) {
    throw new Error(`SESSIONPLANE_LOG_LEVEL must be one of ${[...LOG_LEVELS].join(', ')}`);
  }
  return value as LogLevel;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`${name} must be a boolean`);
}

function parseBrowserPreference(
  value: string | undefined,
  fallback: BrowserPreference,
): BrowserPreference {
  if (value === undefined || value === '') return fallback;
  const normalized = value.toLowerCase() as BrowserPreference;
  if (!BROWSER_PREFERENCES.has(normalized)) {
    throw new Error(
      `SESSIONPLANE_BROWSER must be one of ${[...BROWSER_PREFERENCES].join(', ')}`,
    );
  }
  return normalized;
}

function normalizeEnabledProviders(
  values: readonly string[],
  name: string,
): readonly ProviderName[] {
  const normalized = [
    ...new Set(
      values
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
  ];
  if (normalized.length === 0) {
    throw new Error(name + ' must enable at least one provider');
  }
  if (normalized.length === 1 && normalized[0] === 'all') {
    return Object.freeze([...PROVIDERS]);
  }
  for (const provider of normalized) {
    if (!PROVIDERS.includes(provider as ProviderName)) {
      throw new Error(name + ' must contain only ' + PROVIDERS.join(', '));
    }
  }
  return Object.freeze(normalized as ProviderName[]);
}

function parseEnabledProviders(value: string | undefined): readonly ProviderName[] {
  if (value === undefined || value.trim() === '') {
    return Object.freeze(['chatgpt']);
  }
  if (value.trim().toLowerCase() === 'all') {
    return Object.freeze([...PROVIDERS]);
  }
  return normalizeEnabledProviders(value.split(','), 'SESSIONPLANE_ENABLED_PROVIDERS');
}

export function resolveConfig(overrides: ConfigOverrides = {}): SessionPlaneConfig {
  const env = overrides.env ?? process.env;
  const cwd = path.resolve(overrides.cwd ?? process.cwd());
  const stateDir = resolvePath(cwd, overrides.stateDir ?? env.SESSIONPLANE_STATE_DIR ?? '.state');
  const socketPath = resolvePath(
    stateDir,
    overrides.socketPath ?? env.SESSIONPLANE_SOCKET_PATH ?? 'sessionplane.sock',
  );
  const databasePath = resolvePath(
    stateDir,
    overrides.databasePath ?? env.SESSIONPLANE_DATABASE_PATH ?? 'sessionplane.sqlite',
  );
  const configuredProfileDir = overrides.profileDir ?? env.SESSIONPLANE_PROFILE_DIR;
  const browserScopedProfile =
    configuredProfileDir === undefined || configuredProfileDir.trim() === '';
  const profileDir = resolvePath(
    stateDir,
    browserScopedProfile ? 'profiles' : configuredProfileDir,
  );
  const artifactDir = resolvePath(
    stateDir,
    overrides.artifactDir ?? env.SESSIONPLANE_ARTIFACT_DIR ?? 'artifacts',
  );
  const browserPreference =
    overrides.browserPreference ?? parseBrowserPreference(env.SESSIONPLANE_BROWSER, 'chrome');
  const browserExecutableValue =
    overrides.browserExecutable ?? env.SESSIONPLANE_BROWSER_EXECUTABLE;
  const browserExecutable =
    browserExecutableValue === undefined || browserExecutableValue === ''
      ? null
      : resolvePath(cwd, browserExecutableValue);
  if (browserPreference === 'custom' && browserExecutable === null) {
    throw new Error(
      'SESSIONPLANE_BROWSER=custom requires SESSIONPLANE_BROWSER_EXECUTABLE',
    );
  }
  if (
    browserExecutable !== null &&
    browserPreference !== 'auto' &&
    browserPreference !== 'custom'
  ) {
    throw new Error(
      'SESSIONPLANE_BROWSER_EXECUTABLE can be combined only with SESSIONPLANE_BROWSER=auto or custom',
    );
  }
  const enabledProviders =
    overrides.enabledProviders === undefined
      ? parseEnabledProviders(env.SESSIONPLANE_ENABLED_PROVIDERS)
      : normalizeEnabledProviders(overrides.enabledProviders, 'enabledProviders');
  const chatgptUrl = validateChatGptUrl(
    overrides.chatgptUrl ?? env.SESSIONPLANE_CHATGPT_URL ?? 'https://chatgpt.com/',
  );
  const geminiUrl = validateProviderUrl(
    overrides.geminiUrl ?? env.SESSIONPLANE_GEMINI_URL ?? 'https://gemini.google.com/app',
    'SESSIONPLANE_GEMINI_URL',
    new Set(['gemini.google.com']),
  );
  const grokUrl = validateProviderUrl(
    overrides.grokUrl ?? env.SESSIONPLANE_GROK_URL ?? 'https://grok.com/',
    'SESSIONPLANE_GROK_URL',
    new Set(['grok.com', 'x.com']),
  );

  return Object.freeze({
    cwd,
    stateDir,
    socketPath,
    databasePath,
    profileDir,
    browserScopedProfile,
    artifactDir,
    logLevel: overrides.logLevel ?? parseLogLevel(env.SESSIONPLANE_LOG_LEVEL, 'info'),
    rpcMaxLineBytes:
      overrides.rpcMaxLineBytes ??
      parsePositiveInteger(env.SESSIONPLANE_RPC_MAX_LINE_BYTES, 2 * 1024 * 1024, 'RPC max line bytes'),
    rpcRequestTimeoutMs:
      overrides.rpcRequestTimeoutMs ??
      parsePositiveInteger(env.SESSIONPLANE_RPC_TIMEOUT_MS, 10_000, 'RPC timeout'),
    browserLaunchTimeoutMs:
      overrides.browserLaunchTimeoutMs ??
      parsePositiveInteger(
        env.SESSIONPLANE_BROWSER_LAUNCH_TIMEOUT_MS,
        30_000,
        'Browser launch timeout',
      ),
    browserHeadless:
      overrides.browserHeadless ??
      parseBoolean(env.SESSIONPLANE_BROWSER_HEADLESS, false, 'SESSIONPLANE_BROWSER_HEADLESS'),
    browserPreference,
    browserExecutable,
    enabledProviders,
    submissionAckTimeoutMs:
      overrides.submissionAckTimeoutMs ??
      parsePositiveInteger(
        env.SESSIONPLANE_SUBMISSION_ACK_TIMEOUT_MS,
        12_000,
        'Submission acknowledgement timeout',
      ),
    observationActiveSweepMs:
      overrides.observationActiveSweepMs ??
      parsePositiveInteger(env.SESSIONPLANE_OBSERVATION_ACTIVE_SWEEP_MS, 5_000, 'Observation active sweep'),
    observationQuietSweepMs:
      overrides.observationQuietSweepMs ??
      parsePositiveInteger(env.SESSIONPLANE_OBSERVATION_QUIET_SWEEP_MS, 15_000, 'Observation quiet sweep'),
    observationQuietWindowMs:
      overrides.observationQuietWindowMs ??
      parsePositiveInteger(env.SESSIONPLANE_OBSERVATION_QUIET_WINDOW_MS, 1_500, 'Observation quiet window'),
    backendRecoveryAfterMs:
      overrides.backendRecoveryAfterMs ??
      parsePositiveInteger(env.SESSIONPLANE_BACKEND_RECOVERY_AFTER_MS, 30_000, 'Backend recovery delay'),
    backendRequestTimeoutMs:
      overrides.backendRequestTimeoutMs ??
      parsePositiveInteger(env.SESSIONPLANE_BACKEND_REQUEST_TIMEOUT_MS, 15_000, 'Backend request timeout'),
    probeSuccessIntervalMs:
      overrides.probeSuccessIntervalMs ??
      parsePositiveInteger(env.SESSIONPLANE_PROBE_SUCCESS_INTERVAL_MS, 30_000, 'Probe success interval'),
    probeMin429BackoffMs:
      overrides.probeMin429BackoffMs ??
      parsePositiveInteger(env.SESSIONPLANE_PROBE_MIN_429_BACKOFF_MS, 60_000, 'Probe minimum 429 backoff'),
    probeMax429BackoffMs:
      overrides.probeMax429BackoffMs ??
      parsePositiveInteger(env.SESSIONPLANE_PROBE_MAX_429_BACKOFF_MS, 15 * 60_000, 'Probe maximum 429 backoff'),
    tokenCacheTtlMs:
      overrides.tokenCacheTtlMs ??
      parsePositiveInteger(env.SESSIONPLANE_TOKEN_CACHE_TTL_MS, 60_000, 'Token cache TTL'),
    maxUploadFileBytes:
      overrides.maxUploadFileBytes ??
      parsePositiveInteger(
        env.SESSIONPLANE_MAX_UPLOAD_FILE_BYTES,
        100 * 1024 * 1024,
        'Maximum upload file bytes',
      ),
    maxArtifactFileBytes:
      overrides.maxArtifactFileBytes ??
      parsePositiveInteger(
        env.SESSIONPLANE_MAX_ARTIFACT_FILE_BYTES,
        512 * 1024 * 1024,
        'Maximum artifact file bytes',
      ),
    fetchTimeoutMs:
      overrides.fetchTimeoutMs ??
      parsePositiveInteger(env.SESSIONPLANE_FETCH_TIMEOUT_MS, 15_000, 'Fetch timeout'),
    fetchMaxBytes:
      overrides.fetchMaxBytes ??
      parsePositiveInteger(env.SESSIONPLANE_FETCH_MAX_BYTES, 5 * 1024 * 1024, 'Fetch max bytes'),
    fetchMaxRedirects:
      overrides.fetchMaxRedirects ??
      parsePositiveInteger(env.SESSIONPLANE_FETCH_MAX_REDIRECTS, 5, 'Fetch max redirects'),
    fetchAllowPrivateNetworks:
      overrides.fetchAllowPrivateNetworks ??
      parseBoolean(
        env.SESSIONPLANE_FETCH_ALLOW_PRIVATE,
        false,
        'SESSIONPLANE_FETCH_ALLOW_PRIVATE',
      ),
    searchMaxCandidates:
      overrides.searchMaxCandidates ??
      parsePositiveInteger(env.SESSIONPLANE_SEARCH_MAX_CANDIDATES, 10, 'Search max candidates'),
    chatgptUrl,
    geminiUrl,
    grokUrl,
  });
}

function validateChatGptUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (hostname !== 'chatgpt.com' && hostname !== 'chat.openai.com')) {
    throw new Error('SESSIONPLANE_CHATGPT_URL must be an HTTPS ChatGPT URL');
  }
  return url.href;
}

function validateProviderUrl(value: string, name: string, hosts: ReadonlySet<string>): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname.toLowerCase())) {
    throw new Error(`${name} must be an HTTPS provider URL`);
  }
  return url.href;
}

export function prepareRuntimeDirectories(config: SessionPlaneConfig): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
  mkdirSync(config.profileDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.artifactDir, { recursive: true, mode: 0o700 });

  for (const directory of new Set([
    config.stateDir,
    path.dirname(config.socketPath),
    path.dirname(config.databasePath),
    config.profileDir,
    config.artifactDir,
  ])) {
    chmodSync(directory, 0o700);
  }
}

