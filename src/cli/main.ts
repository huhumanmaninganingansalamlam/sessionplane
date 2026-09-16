import { pathToFileURL } from 'node:url';

import { resolveConfig, SESSIONPLANE_VERSION } from '../config.ts';
import { serveForever } from '../main.ts';
import { callRpc, RpcClientError } from './client.ts';
import { runDoctor } from './commands/doctor.ts';
import { runLogin } from './commands/login.ts';

interface CliIo {
  readonly stdout: NodeJS.WriteStream;
  readonly stderr: NodeJS.WriteStream;
}

interface ParsedArgs {
  readonly command: string;
  readonly json: boolean;
  readonly stateDir?: string;
  readonly socketPath?: string;
  readonly url?: string;
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
        const report = await runDoctor(config);
        writeResult(io, parsed.json, report);
        return report.requestOk ? 0 : 1;
      }
      case 'login': {
        const result = await runLogin(config, parsed.url);
        writeResult(io, parsed.json, result);
        return 0;
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
  let url: string | undefined;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--state-dir' || arg === '--socket' || arg === '--url') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === '--state-dir') {
        stateDir = value;
      } else if (arg === '--socket') {
        socketPath = value;
      } else {
        url = value;
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
    ...(url === undefined ? {} : { url }),
  };
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
  return `SessionPlane ${SESSIONPLANE_VERSION}\n\nUsage:\n  sessplane serve [--state-dir PATH]\n  sessplane health [--json] [--socket PATH]\n  sessplane doctor [--json] [--state-dir PATH]\n  sessplane login [--json] [--url HTTPS_URL]\n  sessplane version\n`;
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

