import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const SESSIONPLANE_VERSION = '0.1.0';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface SessionPlaneConfig {
  readonly cwd: string;
  readonly stateDir: string;
  readonly socketPath: string;
  readonly databasePath: string;
  readonly profileDir: string;
  readonly logLevel: LogLevel;
  readonly rpcMaxLineBytes: number;
  readonly rpcRequestTimeoutMs: number;
  readonly browserLaunchTimeoutMs: number;
  readonly chatgptUrl: string;
}

export interface ConfigOverrides {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stateDir?: string;
  readonly socketPath?: string;
  readonly databasePath?: string;
  readonly profileDir?: string;
  readonly logLevel?: LogLevel;
  readonly rpcMaxLineBytes?: number;
  readonly rpcRequestTimeoutMs?: number;
  readonly browserLaunchTimeoutMs?: number;
  readonly chatgptUrl?: string;
}

const LOG_LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error']);

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
  const profileDir = resolvePath(
    stateDir,
    overrides.profileDir ?? env.SESSIONPLANE_PROFILE_DIR ?? 'chrome-profile',
  );
  const chatgptUrl = validateChatGptUrl(
    overrides.chatgptUrl ?? env.SESSIONPLANE_CHATGPT_URL ?? 'https://chatgpt.com/',
  );

  return Object.freeze({
    cwd,
    stateDir,
    socketPath,
    databasePath,
    profileDir,
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
    chatgptUrl,
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

export function prepareRuntimeDirectories(config: SessionPlaneConfig): void {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(config.socketPath), { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
  mkdirSync(config.profileDir, { recursive: true, mode: 0o700 });

  for (const directory of new Set([
    config.stateDir,
    path.dirname(config.socketPath),
    path.dirname(config.databasePath),
    config.profileDir,
  ])) {
    chmodSync(directory, 0o700);
  }
}

