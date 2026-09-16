import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { resolveConfig, SESSIONPLANE_VERSION, type SessionPlaneConfig } from '../config.ts';
import { serveForever } from '../main.ts';
import { runMcpServer } from '../mcp/server.ts';
import { callRpc, RpcClientError } from './client.ts';
import { runDoctor } from './commands/doctor.ts';
import { runLogin } from './commands/login.ts';
import { writeCliError, writeCliResult, type CliIo } from './format.ts';

interface ParsedArgs {
  readonly words: readonly string[];
  readonly options: Readonly<Record<string, string>>;
  readonly json: boolean;
}

const FLAG_OPTIONS = new Set(['json']);
const VALUE_OPTIONS = new Set([
  'state-dir',
  'socket',
  'url',
  'client-id',
  'request-id',
  'name',
  'objective',
  'primary-role',
  'external-ref',
  'type',
  'display-name',
  'reports-to',
  'provider',
  'brief',
  'prompt',
  'model',
  'deadline',
  'session',
  'generation',
  'after-event-sequence',
  'wait-ms',
  'roles',
  'until',
  'after-sequence',
  'limit',
]);

export async function runCli(
  argv: readonly string[],
  io: CliIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    writeCliError(io, argv.includes('--json'), error);
    return 2;
  }

  const config = resolveConfig({
    ...(parsed.options['state-dir'] === undefined
      ? {}
      : { stateDir: parsed.options['state-dir'] }),
    ...(parsed.options.socket === undefined ? {} : { socketPath: parsed.options.socket }),
  });

  try {
    const command = parsed.words[0] ?? 'help';
    switch (command) {
      case 'serve':
        await serveForever(config);
        return 0;
      case 'health':
        return await printRpc(io, parsed, config, 'system.health', {});
      case 'doctor': {
        const report = await runDoctor(config);
        writeCliResult(io, parsed.json, report);
        return report.requestOk ? 0 : 1;
      }
      case 'login': {
        const result = await runLogin(config, parsed.options.url);
        writeCliResult(io, parsed.json, result);
        return 0;
      }
      case 'team':
        return await runTeamCommand(io, parsed, config);
      case 'role':
        return await runRoleCommand(io, parsed, config);
      case 'session':
        return await runSessionCommand(io, parsed, config);
      case 'send':
        return await runSendCommand(io, parsed, config);
      case 'wait':
        return await runWaitCommand(io, parsed, config);
      case 'stop':
        return await runStopCommand(io, parsed, config);
      case 'status':
        return await runStatusCommand(io, parsed, config);
      case 'events':
        return await runEventsCommand(io, parsed, config, parsed.words.slice(1));
      case 'mcp':
        await runMcpServer({ input: io.stdin, output: io.stdout, error: io.stderr, config });
        return 0;
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
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    writeCliError(io, parsed.json, error);
    return error instanceof RpcClientError ? 1 : 2;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(argv);
}

async function runTeamCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const action = parsed.words[1];
  const rest = parsed.words.slice(2);
  switch (action) {
    case 'create':
      return await printRpc(io, parsed, config, 'team.create', {
        ...mutationIdentity(parsed),
        ...optionalParam('name', parsed.options.name),
        ...optionalParam('objective', parsed.options.objective),
        ...optionalParam('primaryRoleKey', parsed.options['primary-role']),
        ...optionalParam('externalRef', parsed.options['external-ref']),
      });
    case 'show':
    case 'get':
      return await printRpc(io, parsed, config, 'team.get', {
        clientId: clientId(parsed),
        teamId: requirePositional(rest, 0, 'teamId'),
      });
    case 'list':
      return await printRpc(io, parsed, config, 'team.list', {
        clientId: clientId(parsed),
      });
    case 'wait': {
      const waitMs = integerOption(parsed, 'wait-ms', 30_000, 0, 120_000);
      const roleKeys = parsed.options.roles
        ?.split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      return await printRpc(
        io,
        parsed,
        config,
        'team.wait',
        {
          clientId: clientId(parsed),
          teamId: requirePositional(rest, 0, 'teamId'),
          ...(roleKeys === undefined || roleKeys.length === 0 ? {} : { roleKeys }),
          until: normalizeUntil(parsed.options.until ?? 'all_selected_terminal'),
          ...optionalIntegerParam(parsed, 'after-event-sequence', 'afterEventSequence', 0),
          waitMs,
        },
        waitMs + 5_000,
      );
    }
    case 'brief': {
      const offset = rest[0] === 'update' ? 1 : 0;
      return await printRpc(io, parsed, config, 'team.brief.update', {
        ...mutationIdentity(parsed),
        teamId: requirePositional(rest, offset, 'teamId'),
        briefText: requireOption(parsed, 'brief'),
        ...optionalParam('objective', parsed.options.objective),
      });
    }
    default:
      throw new Error(`Unknown team command: ${action ?? ''}`);
  }
}

async function runRoleCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const action = parsed.words[1];
  const rest = parsed.words.slice(2);
  if (action === 'add' || action === 'create') {
    return await printRpc(io, parsed, config, 'team.role.create', {
      ...mutationIdentity(parsed),
      teamId: requirePositional(rest, 0, 'teamId'),
      roleKey: requirePositional(rest, 1, 'roleKey'),
      roleType: parsed.options.type ?? 'expert',
      ...optionalParam('displayName', parsed.options['display-name']),
      ...optionalParam('reportsToRoleKey', parsed.options['reports-to']),
      ...optionalParam('provider', parsed.options.provider),
    });
  }
  if (action === 'retire') {
    return await printRpc(io, parsed, config, 'team.role.retire', {
      ...mutationIdentity(parsed),
      teamId: requirePositional(rest, 0, 'teamId'),
      roleKey: requirePositional(rest, 1, 'roleKey'),
    });
  }
  throw new Error(`Unknown role command: ${action ?? ''}`);
}

async function runSessionCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const action = parsed.words[1];
  const rest = parsed.words.slice(2);
  switch (action) {
    case 'create':
      return await printRpc(io, parsed, config, 'session.create', {
        ...mutationIdentity(parsed),
        teamId: requirePositional(rest, 0, 'teamId'),
        roleKey: requirePositional(rest, 1, 'roleKey'),
        provider: parsed.options.provider ?? 'chatgpt',
      });
    case 'show':
    case 'get':
      return await runStatusCommand(io, { ...parsed, words: ['status', ...rest] }, config);
    case 'events':
      return await runEventsCommand(io, parsed, config, rest);
    default:
      throw new Error(`Unknown session command: ${action ?? ''}`);
  }
}

async function runSendCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  return await printRpc(io, parsed, config, 'session.send', {
    ...mutationIdentity(parsed),
    ...sessionSelector(parsed, parsed.words.slice(1)),
    prompt: requireOption(parsed, 'prompt'),
    ...optionalParam('model', parsed.options.model),
    ...optionalIntegerParam(parsed, 'deadline', 'sessionDeadlineSec', 1, 86_400),
  });
}

async function runWaitCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const waitMs = integerOption(parsed, 'wait-ms', 30_000, 0, 120_000);
  return await printRpc(
    io,
    parsed,
    config,
    'session.wait',
    {
      clientId: clientId(parsed),
      ...sessionSelector(parsed, parsed.words.slice(1)),
      ...optionalIntegerParam(parsed, 'generation', 'generation', 0),
      ...optionalIntegerParam(parsed, 'after-event-sequence', 'afterEventSequence', 0),
      waitMs,
    },
    waitMs + 5_000,
  );
}

async function runStopCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  return await printRpc(io, parsed, config, 'session.stop', {
    ...mutationIdentity(parsed),
    ...sessionSelector(parsed, parsed.words.slice(1)),
  });
}

async function runStatusCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  return await printRpc(io, parsed, config, 'session.get', {
    clientId: clientId(parsed),
    ...sessionSelector(parsed, parsed.words.slice(1)),
  });
}

async function runEventsCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
  rest: readonly string[],
): Promise<number> {
  return await printRpc(io, parsed, config, 'session.events', {
    clientId: clientId(parsed),
    teamId: requirePositional(rest, 0, 'teamId'),
    ...optionalIntegerParam(parsed, 'after-sequence', 'afterSequence', 0),
    ...optionalIntegerParam(parsed, 'limit', 'limit', 1, 1_000),
  });
}

async function printRpc(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
  method: string,
  params: Readonly<Record<string, unknown>>,
  minimumTimeoutMs = 0,
): Promise<number> {
  const result = await callRpc<unknown>({
    socketPath: config.socketPath,
    method,
    params,
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, minimumTimeoutMs),
    maxLineBytes: config.rpcMaxLineBytes,
  });
  writeCliResult(io, parsed.json, result);
  return 0;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const words: string[] = [];
  const options: Record<string, string> = {};
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '-h' || arg === '-v') {
      words.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) {
      words.push(arg);
      continue;
    }

    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    if (FLAG_OPTIONS.has(name)) {
      if (equals >= 0) {
        throw new Error(`--${name} does not accept a value`);
      }
      if (name === 'json') {
        json = true;
      }
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      if (name === 'help' || name === 'version') {
        words.push(`--${name}`);
        continue;
      }
      throw new Error(`Unknown option: --${name}`);
    }
    const value = equals >= 0 ? arg.slice(equals + 1) : argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value`);
    }
    if (equals < 0) {
      index += 1;
    }
    options[name] = value;
  }

  return { words, options, json };
}

function sessionSelector(
  parsed: ParsedArgs,
  positionals: readonly string[],
): Readonly<Record<string, string>> {
  const exactSession = parsed.options.session;
  if (exactSession !== undefined) {
    if (positionals.length > 0) {
      throw new Error('Use either --session or teamId + roleKey, not both');
    }
    return { sessionId: exactSession };
  }
  if (positionals.length === 1) {
    return { sessionId: positionals[0] as string };
  }
  return {
    teamId: requirePositional(positionals, 0, 'teamId'),
    roleKey: requirePositional(positionals, 1, 'roleKey'),
  };
}

function mutationIdentity(parsed: ParsedArgs): Readonly<Record<string, string>> {
  return {
    clientId: clientId(parsed),
    requestId: parsed.options['request-id'] ?? randomUUID(),
  };
}

function clientId(parsed: ParsedArgs): string {
  return parsed.options['client-id'] ?? process.env.SESSIONPLANE_CLIENT_ID ?? 'sessplane-cli';
}

function requireOption(parsed: ParsedArgs, name: string): string {
  const value = parsed.options[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function requirePositional(
  values: readonly string[],
  index: number,
  name: string,
): string {
  const value = values[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function integerOption(
  parsed: ParsedArgs,
  optionName: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = parsed.options[optionName];
  if (value === undefined) {
    return fallback;
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue < minimum || parsedValue > maximum) {
    throw new Error(`--${optionName} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsedValue;
}

function optionalIntegerParam(
  parsed: ParsedArgs,
  optionName: string,
  paramName: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): Readonly<Record<string, number>> {
  if (parsed.options[optionName] === undefined) {
    return {};
  }
  return {
    [paramName]: integerOption(parsed, optionName, minimum, minimum, maximum),
  };
}

function optionalParam(
  name: string,
  value: string | undefined,
): Readonly<Record<string, string>> {
  return value === undefined ? {} : { [name]: value };
}

function normalizeUntil(value: string): string {
  const normalized = value.replaceAll('-', '_');
  if (!['any_change', 'primary_terminal', 'all_selected_terminal'].includes(normalized)) {
    throw new Error(`Unknown team wait condition: ${value}`);
  }
  return normalized;
}

function helpText(): string {
  return `SessionPlane ${SESSIONPLANE_VERSION}\n\nUsage:\n  sessplane serve [--state-dir PATH]\n  sessplane health [--json] [--socket PATH]\n  sessplane doctor [--json] [--state-dir PATH]\n  sessplane login [--json] [--url HTTPS_URL]\n\n  sessplane team create --name NAME [--objective TEXT] [--request-id ID]\n  sessplane team show TEAM_ID [--json]\n  sessplane team list [--json]\n  sessplane team wait TEAM_ID [--roles KEY,KEY] [--until CONDITION]\n  sessplane team brief [update] TEAM_ID --brief TEXT\n\n  sessplane role add TEAM_ID ROLE_KEY --type expert|reviewer|custom\n  sessplane role retire TEAM_ID ROLE_KEY\n  sessplane session create TEAM_ID ROLE_KEY [--provider chatgpt]\n  sessplane session show SESSION_ID\n  sessplane session events TEAM_ID [--after-sequence N]\n\n  sessplane send TEAM_ID ROLE_KEY --prompt TEXT [--model MODEL]\n  sessplane send --session SESSION_ID --prompt TEXT\n  sessplane status TEAM_ID ROLE_KEY | --session SESSION_ID\n  sessplane wait TEAM_ID ROLE_KEY [--generation N] [--wait-ms N]\n  sessplane stop TEAM_ID ROLE_KEY [--request-id ID]\n  sessplane mcp\n\nGlobal identity options:\n  --client-id ID       Stable caller identity\n  --request-id ID      Stable mutation identity for exact retries\n  --json               Emit one compact JSON object\n  --state-dir PATH     Override runtime state directory\n  --socket PATH        Override core Unix socket\n`;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
