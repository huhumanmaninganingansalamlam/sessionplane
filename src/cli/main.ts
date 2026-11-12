import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { findHostBrowser, listHostBrowsers, type BrowserPreference } from '../browser/browser-health.ts';
import { resolveConfig, SESSIONPLANE_VERSION, type SessionPlaneConfig } from '../config.ts';
import { serveForever } from '../main.ts';
import { runMcpServer } from '../mcp/server.ts';
import { runRpcRelay } from './remote.ts';
import { projectOpenSchema, taskSchemas } from '../rpc/methods/task.ts';
import { SkillDistributionService } from '../skills/skill-distribution.ts';
import { callRpc, RpcClientError } from './client.ts';
import { runDoctor } from './commands/doctor.ts';
import { runLogin } from './commands/login.ts';
import { writeCliError, writeCliResult, type CliIo } from './format.ts';

interface ParsedArgs {
  readonly words: readonly string[];
  readonly options: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly json: boolean;
}

const FLAG_OPTIONS = new Set([
  'json', 'prompt-stdin', 'continuation-approved', 'until-change',
  'manual', 'resume', 'full', 'link', 'force',
]);
const VALUE_OPTIONS = new Set([
  'view', 'remote', 'remote-executable', 'remote-socket', 'remote-control-path',
  'state-dir', 'browser', 'browser-executable', 'providers', 'socket',
  'client-id', 'request-id', 'expected-conversation-revision', 'conversation-slot',
  'after-revision', 'approval-ref', 'input', 'name', 'provider', 'prompt',
  'prompt-file', 'model', 'surface', 'wait-ms', 'key', 'url', 'skill', 'target',
]);

export async function runCli(
  argv: readonly string[],
  io: CliIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0 ||
      argv[0] === 'help') {
    io.stdout.write(helpText());
    return 0;
  }
  let parsed: ParsedArgs;
  try { parsed = parseArgs(argv); }
  catch (error) { writeCliError(io, argv.includes('--json'), error); return 2; }

  const command = parsed.words[0] ?? 'help';
  const requestedState = parsed.options['state-dir'] ?? process.env.SESSIONPLANE_STATE_DIR;
  let stateDir = parsed.options['state-dir'];
  if (command === 'serve') {
    const canonical = path.join(homedir(), '.local', 'state', 'sessionplane');
    if (requestedState && path.resolve(requestedState) !== canonical) {
      writeCliError(io, parsed.json, new Error(
        'Installed Core uses the canonical state directory; isolated stateDir is test-only.',
      ));
      return 2;
    }
    stateDir = canonical;
  }
  const remoteHost = parsed.options.remote ?? process.env.SESSIONPLANE_REMOTE_HOST;
  const remoteSocket = parsed.options['remote-socket'] ?? process.env.SESSIONPLANE_REMOTE_SOCKET;
  const controlPath = parsed.options['remote-control-path'] ?? process.env.SESSIONPLANE_REMOTE_CONTROL_PATH;
  const config = resolveConfig({
    ...(remoteHost ? { remote: {
      host: remoteHost,
      executable: parsed.options['remote-executable'] ??
        process.env.SESSIONPLANE_REMOTE_EXECUTABLE ?? 'sessplane',
      ...(controlPath ? { controlPath } : {}),
      ...(remoteSocket ? { socketPath: remoteSocket } : {}),
    } } : {}),
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(parsed.options.socket === undefined ? {} : { socketPath: parsed.options.socket }),
    ...(parsed.options.browser === undefined
      ? {} : { browserPreference: parsed.options.browser as BrowserPreference }),
    ...(parsed.options['browser-executable'] === undefined
      ? {} : { browserExecutable: parsed.options['browser-executable'] }),
    ...(parsed.options.providers === undefined
      ? {} : { enabledProviders: parsed.options.providers.split(',') }),
  });

  try {
    switch (command) {
      case 'serve':
        if (config.remote) throw new Error('Run serve on the remote Core host, not through SSH');
        await serveForever(config);
        return 0;
      case 'rpc-stdio':
        return await runRpcRelay(config.socketPath, io);
      case 'health':
        return await printRpc(io, parsed, config, 'system.health', {});
      case 'project':
        return await runPublicProjectCommand(io, parsed, config);
      case 'task':
        return await runPublicTaskCommand(io, parsed, config);
      case 'mcp':
        if (parsed.words.length !== 1) throw new Error('Usage: sessplane mcp');
        await runMcpServer({ input: io.stdin, output: io.stdout, error: io.stderr, config });
        return 0;
      case 'doctor': {
        const report = await runDoctor(config);
        writeCliResult(io, parsed.json, report);
        return report.requestOk ? 0 : 1;
      }
      case 'browser-list': {
        const available = listHostBrowsers();
        const selected = findHostBrowser({
          preference: config.browserPreference,
          ...(config.browserExecutable === null ? {} : { executablePath: config.browserExecutable }),
        });
        writeCliResult(io, parsed.json, {
          requestOk: selected !== null, requested: config.browserPreference,
          selected, available,
        });
        return selected ? 0 : 1;
      }
      case 'login': {
        if (parsed.options.manual === 'true' && parsed.options.resume === 'true') {
          throw new Error('--manual and --resume are mutually exclusive');
        }
        if (parsed.options.resume === 'true' && parsed.options.url !== undefined) {
          throw new Error('--resume does not accept --url');
        }
        const mode = parsed.options.manual === 'true' ? 'manual' :
          parsed.options.resume === 'true' ? 'resume' : 'automated';
        const result = await runLogin(config, {
          mode, ...(parsed.options.url ? { url: parsed.options.url } : {}),
        });
        writeCliResult(io, parsed.json, result);
        return 0;
      }
      case 'skills':
        return await runOperatorSkills(io, parsed);
      case 'version':
      case '--version':
      case '-v':
        io.stdout.write(SESSIONPLANE_VERSION + '\n');
        return 0;
      default:
        throw new Error('Unknown public command: ' + command);
    }
  } catch (error) {
    writeCliError(io, parsed.json, error);
    return error instanceof RpcClientError ? 1 : 2;
  }
}

/** Only the provider-neutral project/task RPC is accepted from the public CLI. */
const PUBLIC_GLOBAL_OPTIONS = [
  'client-id', 'socket', 'state-dir', 'remote', 'remote-executable',
  'remote-socket', 'remote-control-path',
] as const;

function publicCommandOptions(
  parsed: ParsedArgs, name: string, words: number, allowed: readonly string[],
): void {
  if (parsed.words.length !== words) {
    throw new Error('Usage: ' + name + ' (unexpected or missing positional arguments)');
  }
  const names = new Set<string>([...PUBLIC_GLOBAL_OPTIONS, ...allowed]);
  for (const flag of Object.keys(parsed.options)) {
    if (!names.has(flag)) throw new Error('Unsupported ' + name + ' option: --' + flag);
  }
  if (parsed.files.length > 0) throw new Error(name + ' does not accept legacy --file attachments');
}

async function runPublicProjectCommand(
  io: CliIo, parsed: ParsedArgs, config: SessionPlaneConfig,
): Promise<number> {
  if (parsed.words[1] !== 'open') throw new Error('Usage: sessplane project open --key KEY --name NAME --request-id ID');
  publicCommandOptions(parsed, 'project open', 2, [
    'key', 'name', 'request-id', 'provider', 'surface', 'model',
  ]);
  const params = projectOpenSchema.parse({
    clientId: clientId(parsed),
    requestId: requireOption(parsed, 'request-id'),
    projectKey: requireOption(parsed, 'key'),
    displayName: requireOption(parsed, 'name'),
    ...(parsed.options.provider ? { provider: parsed.options.provider } : {}),
    ...(parsed.options.surface ? { surfaceIntent: parsed.options.surface } : {}),
    ...(parsed.options.model ? { modelIntent: parsed.options.model } : {}),
  });
  return await printRpc(io, parsed, config, 'project.open', params);
}

async function runPublicTaskCommand(
  io: CliIo, parsed: ParsedArgs, config: SessionPlaneConfig,
): Promise<number> {
  const action = parsed.words[1];
  const owner = clientId(parsed);
  const viewOption = parsed.options.view === undefined ? {} : { view: parsed.options.view };
  switch (action) {
    case 'start': {
      publicCommandOptions(parsed, 'task start', 3, [
        'request-id', 'expected-conversation-revision', 'conversation-slot',
        'prompt', 'prompt-file', 'prompt-stdin', 'continuation-approved', 'approval-ref',
      ]);
      const sources = [
        parsed.options.prompt !== undefined,
        parsed.options['prompt-file'] !== undefined,
        parsed.options['prompt-stdin'] === 'true',
      ].filter(Boolean).length;
      if (sources !== 1) throw new Error('Specify exactly one of --prompt, --prompt-file or --prompt-stdin');
      const prompt = parsed.options.prompt ??
        (parsed.options['prompt-file'] !== undefined
          ? readFileSync(parsed.options['prompt-file'], 'utf8')
          : await readInput(io.stdin));
      const approved = parsed.options['continuation-approved'] === 'true';
      if (!approved && parsed.options['approval-ref'] !== undefined) {
        throw new Error('--approval-ref requires --continuation-approved');
      }
      requireOption(parsed, 'expected-conversation-revision');
      const params = taskSchemas.start.parse({
        clientId: owner, requestId: requireOption(parsed, 'request-id'),
        projectId: requirePositional(parsed.words, 2, 'projectId'),
        expectedConversationRevision: integerOption(
          parsed, 'expected-conversation-revision', 0, 1,
        ),
        ...(parsed.options['conversation-slot'] === undefined
          ? {} : { conversationSlotId: parsed.options['conversation-slot'] }),
        prompt,
        ...(approved ? { continuationPolicy: {
          enabled: true, intervalMs: 1_200_000, message: '계속',
          approvalRef: requireOption(parsed, 'approval-ref'),
        } } : {}),
      });
      return await printRpc(io, parsed, config, 'task.start', params);
    }
    case 'get': {
      publicCommandOptions(parsed, 'task get', 3, ['view']);
      return await printRpc(io, parsed, config, 'task.get', taskSchemas.get.parse({
        clientId: owner, taskId: requirePositional(parsed.words, 2, 'taskId'), ...viewOption,
      }));
    }
    case 'wait': {
      publicCommandOptions(parsed, 'task wait', 3, [
        'after-revision', 'wait-ms', 'view', 'until-change',
      ]);
      requireOption(parsed, 'after-revision');
      const waitMs = integerOption(parsed, 'wait-ms', 30_000, 0, 120_000);
      return await printRpc(io, parsed, config, 'task.wait', taskSchemas.wait.parse({
        clientId: owner, taskId: requirePositional(parsed.words, 2, 'taskId'),
        afterRevision: integerOption(parsed, 'after-revision', 0, 0),
        waitMs, ...viewOption,
      }), waitMs + 5_000);
    }
    case 'decide': {
      publicCommandOptions(parsed, 'task decide', 5, ['request-id', 'input']);
      return await printRpc(io, parsed, config, 'task.decide', taskSchemas.decide.parse({
        clientId: owner, taskId: requirePositional(parsed.words, 2, 'taskId'),
        decisionId: requirePositional(parsed.words, 3, 'decisionId'),
        actionRef: requirePositional(parsed.words, 4, 'actionRef'),
        requestId: requireOption(parsed, 'request-id'),
        ...(parsed.options.input === undefined ? {} : { input: parsed.options.input }),
      }));
    }
    case 'cancel': {
      publicCommandOptions(parsed, 'task cancel', 3, ['request-id']);
      return await printRpc(io, parsed, config, 'task.cancel', taskSchemas.cancel.parse({
        clientId: owner, taskId: requirePositional(parsed.words, 2, 'taskId'),
        requestId: requireOption(parsed, 'request-id'),
      }));
    }
    default:
      throw new Error('Usage: sessplane task start|get|wait|decide|cancel ...');
  }
}


async function printRpc(
  io: CliIo, parsed: ParsedArgs, config: SessionPlaneConfig,
  method: string, params: Readonly<Record<string, unknown>>,
  minimumTimeoutMs = 0,
): Promise<number> {
  const result = await callRpc<unknown>({
    socketPath: config.socketPath, remote: config.remote,
    method, params,
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, minimumTimeoutMs),
    maxLineBytes: config.rpcMaxLineBytes,
  });
  writeCliResult(io, parsed.json, result);
  return result && typeof result === 'object' && 'requestOk' in result &&
    result.requestOk === false ? 1 : 0;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const words: string[] = [];
  const options: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-v') { words.push(arg); continue; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const equals = arg.indexOf('=');
    const name = arg.slice(2, equals < 0 ? undefined : equals);
    if (name === 'version') { words.push('--version'); continue; }
    if (FLAG_OPTIONS.has(name)) {
      if (equals !== -1) throw new Error('--' + name + ' does not accept a value');
      if (name === 'json') json = true;
      else options[name] = 'true';
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error('Unknown option: --' + name);
    if (options[name] !== undefined) throw new Error('Duplicate option: --' + name);
    const value = equals < 0 ? argv[++index] : arg.slice(equals + 1);
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new Error('--' + name + ' requires a value');
    }
    options[name] = value;
  }
  return { words, options, files: [], json };
}

function clientId(parsed: ParsedArgs): string {
  return parsed.options['client-id'] ?? process.env.SESSIONPLANE_CLIENT_ID ?? 'sessplane-cli';
}
function requireOption(parsed: ParsedArgs, name: string): string {
  const value = parsed.options[name];
  if (!value) throw new Error('--' + name + ' is required');
  return value;
}
function requirePositional(words: readonly string[], index: number, name: string): string {
  const value = words[index];
  if (!value) throw new Error(name + ' is required');
  return value;
}
function integerOption(
  parsed: ParsedArgs, name: string, fallback: number,
  minimum: number, maximum = Number.MAX_SAFE_INTEGER,
): number {
  const text = parsed.options[name];
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('--' + name + ' must be an integer from ' + minimum + ' to ' + maximum);
  }
  return value;
}
async function readInput(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding('utf8');
  let value = '';
  for await (const chunk of stream) {
    value += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    if (value.length > 200_000) throw new Error('Prompt exceeds public 200000-character limit');
  }
  return value;
}

async function runOperatorSkills(io: CliIo, parsed: ParsedArgs): Promise<number> {
  const service = new SkillDistributionService();
  const action = parsed.words[1] ?? 'list';
  if (action === 'list') writeCliResult(io, parsed.json, service.list());
  else if (action === 'get') {
    writeCliResult(io, parsed.json, service.get(requirePositional(parsed.words, 2, 'skill'),
      parsed.options.full === 'true'));
  } else if (action === 'path') {
    writeCliResult(io, parsed.json, service.path(parsed.words[2]));
  } else if (action === 'install') {
    writeCliResult(io, parsed.json, service.install({
      target: requireOption(parsed, 'target'),
      ...(parsed.options.skill ? { names: [parsed.options.skill] } : {}),
      link: parsed.options.link === 'true',
      force: parsed.options.force === 'true',
    }));
  } else throw new Error('Unknown skills operation: ' + action);
  return 0;
}

function helpText(): string {
  return [
    'SessionPlane ' + SESSIONPLANE_VERSION,
    '',
    'Usage:',
    '  sessplane serve [--providers chatgpt,gemini,grok]',
    '  sessplane health [--json]',
    '  sessplane project open --key KEY --name NAME --request-id ID [--model Pro] --json',
    '  sessplane task start PROJECT_ID --expected-conversation-revision N --request-id ID',
    '    (--prompt TEXT | --prompt-file PATH | --prompt-stdin) [--conversation-slot ID]',
    '    [--continuation-approved --approval-ref EXISTING_USER_DELEGATION] --json',
    '  sessplane task get TASK_ID [--view summary|result|evidence] --json',
    '  sessplane task wait TASK_ID --after-revision N [--wait-ms 30000] --json',
    '  sessplane task decide TASK_ID DECISION_ID ACTION_REF --request-id ID [--input TEXT] --json',
    '  sessplane task cancel TASK_ID --request-id ID --json',
    '  sessplane mcp',
    '',
    'Operator utilities:',
    '  sessplane login [--manual|--resume] [--url HTTPS_URL]',
    '  sessplane doctor --json',
    '  sessplane browser-list',
    '  sessplane skills list|get|path|install',
    '  sessplane version',
    '',
    'Transport:',
    '  --client-id ID    Stable owner identity',
    '  --request-id ID   Exact idempotency identity (required for mutations)',
    '  --socket PATH     Core Unix socket',
    '  --remote SSH_HOST  Existing remote Core transport (same RPC)',
    '  --json           Return structured results without truncating answers',
    '',
  ].join('\n');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runCli(argv);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}
