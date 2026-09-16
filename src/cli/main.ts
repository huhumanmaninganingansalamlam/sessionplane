import { accessSync, constants, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  prepareRuntimeDirectories,
  resolveConfig,
  SESSIONPLANE_VERSION,
  type SessionPlaneConfig,
} from '../config.ts';
import { serveForever } from '../main.ts';
import { SessionPlaneDatabase } from '../storage/database.ts';
import { callRpc, RpcClientError } from './client.ts';

interface CliIo {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
}

interface ParsedArgs {
  readonly command: string;
  readonly json: boolean;
  readonly stateDir?: string;
  readonly socketPath?: string;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    writeError(io, false, error);
    return 2;
  }

  const config = resolveConfig({
    ...(parsed.stateDir === undefined ? {} : { stateDir: parsed.stateDir }),
    ...(parsed.socketPath === undefined ? {} : { socketPath: parsed.socketPath }),
  });

  try {
    switch (parsed.command) {
      case 'serve':
        await serveForever(config);
        return 0;
      case 'health': {
        const health = await callRpc<Readonly<Record<string, unknown>>>({
          socketPath: config.socketPath,
          method: 'system.health',
          timeoutMs: config.rpcRequestTimeoutMs,
          maxLineBytes: config.rpcMaxLineBytes,
        });
        writeResult(io, parsed.json, health);
        return 0;
      }
      case 'doctor': {
        const report = runDoctor(config);
        writeResult(io, parsed.json, report);
        return report.requestOk ? 0 : 1;
      }
      case 'version':
      case '--version':
      case '-v':
        io.stdout.write(`${SESSIONPLANE_VERSION}\n`);
        return 0;
      case 'help':
      case '--help':
      case '-h':
        io.stdout.write(helpText());
        return 0;
      default:
        throw new Error(`Unknown command: ${parsed.command}`);
    }
  } catch (error) {
    writeError(io, parsed.json, error);
    return error instanceof RpcClientError ? 1 : 2;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(argv);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? 'help';
  let json = false;
  let stateDir: string | undefined;
  let socketPath: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--state-dir' || arg === '--socket') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === '--state-dir') {
        stateDir = value;
      } else {
        socketPath = value;
      }
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return {
    command,
    json,
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(socketPath === undefined ? {} : { socketPath }),
  };
}

function runDoctor(config: SessionPlaneConfig): {
  readonly requestOk: boolean;
  readonly service: string;
  readonly version: string;
  readonly checks: readonly Readonly<Record<string, unknown>>[];
} {
  const checks: Array<Readonly<Record<string, unknown>>> = [];

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'node',
    ok: major === 24 && minor >= 15,
    version: process.version,
    required: '>=24.15 <25',
  });

  const chrome = findChrome();
  checks.push({ name: 'chrome', ...chrome });

  try {
    prepareRuntimeDirectories(config);
    const mode = statSync(config.stateDir).mode & 0o777;
    checks.push({
      name: 'state-directory',
      ok: mode === 0o700,
      path: config.stateDir,
      mode: mode.toString(8).padStart(3, '0'),
    });
  } catch (error) {
    checks.push({
      name: 'state-directory',
      ok: false,
      path: config.stateDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const database = SessionPlaneDatabase.open(config.databasePath);
    const health = database.health();
    database.close();
    checks.push({
      name: 'database',
      ok: health.integrity === 'ok' && health.foreignKeys && health.journalMode === 'wal',
      ...health,
    });
  } catch (error) {
    checks.push({
      name: 'database',
      ok: false,
      path: config.databasePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    requestOk: checks.every((check) => check.ok === true),
    service: 'sessionplane',
    version: SESSIONPLANE_VERSION,
    checks,
  };
}

function findChrome(): Readonly<Record<string, unknown>> {
  const candidates = [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
  ];
  for (const candidate of candidates) {
    const executable = findExecutable(candidate);
    if (executable === null) {
      continue;
    }
    const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
    return {
      ok: result.status === 0,
      executable,
      version: result.stdout.trim() || result.stderr.trim(),
    };
  }
  return { ok: false, reason: 'Google Chrome executable not found on PATH' };
}

function findExecutable(command: string): string | null {
  if (isAbsolute(command)) {
    return canExecute(command) ? command : null;
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(directory, command);
    if (canExecute(candidate)) {
      return candidate;
    }
  }
  return null;
}

function canExecute(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function writeResult(io: CliIo, json: boolean, result: unknown): void {
  if (json) {
    io.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function writeError(io: CliIo, json: boolean, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const errorCode =
    error instanceof RpcClientError && isRecord(error.data) && typeof error.data.errorCode === 'string'
      ? error.data.errorCode
      : 'input.invalid';
  const result = { requestOk: false, errorCode, message };
  io.stderr.write(json ? `${JSON.stringify(result)}\n` : `${message}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function helpText(): string {
  return `SessionPlane ${SESSIONPLANE_VERSION}\n\nUsage:\n  sessplane serve [--state-dir PATH]\n  sessplane health [--json] [--socket PATH]\n  sessplane doctor [--json] [--state-dir PATH]\n  sessplane version\n`;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

