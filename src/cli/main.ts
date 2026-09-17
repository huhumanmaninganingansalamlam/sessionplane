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

const FLAG_OPTIONS = new Set([
  'json',
  'interactive',
  'full-page',
  'append',
  'clear',
  'boxes',
  'include-disabled',
  'screenshot',
  'all-nodes',
]);
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
  'text',
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
  'page',
  'snapshot-id',
  'max-nodes',
  'out',
  'width',
  'height',
  'key',
  'value',
  'x',
  'y',
  'delta-x',
  'delta-y',
  'timeout-ms',
  'selector',
  'script',
  'max-chars',
  'top-n',
  'button',
  'click-count',
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
        return parsed.words.length === 1 && parsed.options.session === undefined
          ? await printRpc(io, parsed, config, 'system.health', {})
          : await runStatusCommand(io, parsed, config);
      case 'events':
        return await runEventsCommand(io, parsed, config, parsed.words.slice(1));
      case 'mcp':
        await runMcpServer({ input: io.stdin, output: io.stdout, error: io.stderr, config });
        return 0;
      case 'tabs':
      case 'active-tab':
      case 'select-tab':
      case 'tab-switch':
      case 'new-tab':
      case 'tab-close':
      case 'tab-cleanup':
      case 'navigate':
      case 'reload':
      case 'back':
      case 'forward':
      case 'resize':
      case 'snapshot':
      case 'screenshot':
      case 'text':
      case 'get-dom':
      case 'click':
      case 'type':
      case 'press':
      case 'hover':
      case 'select':
      case 'check':
      case 'uncheck':
      case 'upload':
      case 'drag':
      case 'mouse-click':
      case 'move-mouse':
      case 'mouse-down':
      case 'mouse-up':
      case 'scroll':
      case 'wait-for-selector':
      case 'wait-for-text':
      case 'wait-for':
      case 'console':
      case 'network':
      case 'evaluate':
      case 'observe-bundle':
      case 'observe-actions':
        return await runBrowserCommand(io, parsed, config);
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

async function runBrowserCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const command = parsed.words[0] as string;
  const rest = parsed.words.slice(1);
  const pageKey = parsed.options.page;
  const page = pageKey === undefined ? {} : { pageKey };
  const snapshotId = parsed.options['snapshot-id'];
  const snapshot = snapshotId === undefined ? {} : { snapshotId };

  switch (command) {
    case 'tabs':
    case 'active-tab':
      return await printRpc(io, parsed, config, 'browser.tabs', {});
    case 'select-tab':
    case 'tab-switch':
      return await printRpc(io, parsed, config, 'browser.select', {
        pageKey: requirePositional(rest, 0, 'pageKey'),
      });
    case 'new-tab':
      return await printRpc(io, parsed, config, 'browser.new', {
        ...optionalParam('url', rest[0] ?? parsed.options.url),
      });
    case 'tab-close':
      return await printRpc(io, parsed, config, 'browser.close', {
        ...optionalParam('pageKey', rest[0] ?? pageKey),
      });
    case 'tab-cleanup':
      return await printRpc(io, parsed, config, 'browser.cleanup', {
        ...optionalParam('keepPageKey', pageKey),
      });
    case 'navigate':
      return await printRpc(io, parsed, config, 'browser.navigate', {
        ...page,
        url: requirePositional(rest, 0, 'url'),
      });
    case 'reload':
    case 'back':
    case 'forward':
      return await printRpc(io, parsed, config, `browser.${command}`, page);
    case 'resize':
      return await printRpc(io, parsed, config, 'browser.resize', {
        ...page,
        width: numberFromOptionOrPosition(parsed, 'width', rest, 0, 200, 10_000),
        height: numberFromOptionOrPosition(parsed, 'height', rest, 1, 200, 10_000),
      });
    case 'snapshot':
      return await printRpc(io, parsed, config, 'browser.snapshot', {
        ...page,
        interactive: !parsed.options['all-nodes'],
        maxNodes: integerOption(parsed, 'max-nodes', 250, 1, 5_000),
      });
    case 'screenshot':
      return await printRpc(io, parsed, config, 'browser.screenshot', {
        ...page,
        outputPath: parsed.options.out ?? rest[0] ?? 'sessionplane-screenshot.png',
        fullPage: parsed.options['full-page'] === 'true',
      });
    case 'text':
      return await printRpc(io, parsed, config, 'browser.text', {
        ...page,
        ...optionalParam('selector', parsed.options.selector),
        maxChars: integerOption(parsed, 'max-chars', 200_000, 1, 2_000_000),
      });
    case 'get-dom':
      return await printRpc(io, parsed, config, 'browser.dom', {
        ...page,
        maxChars: integerOption(parsed, 'max-chars', 500_000, 1, 4_000_000),
      });
    case 'click':
      return await printRpc(io, parsed, config, 'browser.click', {
        ...page,
        ...snapshot,
        ref: requirePositional(rest, 0, 'ref'),
        button: parsed.options.button ?? 'left',
        clickCount: integerOption(parsed, 'click-count', 1, 1, 3),
      });
    case 'type':
      return await printRpc(io, parsed, config, 'browser.type', {
        ...page,
        ...snapshot,
        ref: requirePositional(rest, 0, 'ref'),
        text: requireOption(parsed, 'text'),
        append: parsed.options.append === 'true',
      });
    case 'press': {
      const ref = rest[0]?.startsWith('@e') ? rest[0] : undefined;
      const key = parsed.options.key ?? (ref === undefined ? rest[0] : rest[1]);
      if (key === undefined) throw new Error('key is required');
      return await printRpc(io, parsed, config, 'browser.press', {
        ...page,
        ...snapshot,
        ...optionalParam('ref', ref),
        key,
      });
    }
    case 'hover':
      return await printRpc(io, parsed, config, 'browser.hover', {
        ...page,
        ...snapshot,
        ref: requirePositional(rest, 0, 'ref'),
      });
    case 'select':
      return await printRpc(io, parsed, config, 'browser.selectOption', {
        ...page,
        ...snapshot,
        ref: requirePositional(rest, 0, 'ref'),
        values: requireOption(parsed, 'value').split(',').map((value) => value.trim()),
      });
    case 'check':
    case 'uncheck':
      return await printRpc(io, parsed, config, `browser.${command}`, {
        ...page,
        ...snapshot,
        ref: requirePositional(rest, 0, 'ref'),
      });
    case 'upload':
      return await printRpc(io, parsed, config, 'browser.upload', {
        ...page,
        ...snapshot,
        ref: requirePositional(rest, 0, 'ref'),
        files: rest.slice(1),
      });
    case 'drag':
      return await printRpc(io, parsed, config, 'browser.drag', {
        ...page,
        ...snapshot,
        sourceRef: requirePositional(rest, 0, 'sourceRef'),
        targetRef: requirePositional(rest, 1, 'targetRef'),
      });
    case 'mouse-click':
    case 'move-mouse':
    case 'mouse-down':
    case 'mouse-up': {
      const action = command === 'mouse-click'
        ? 'click'
        : command === 'move-mouse'
          ? 'move'
          : command === 'mouse-down'
            ? 'down'
            : 'up';
      return await printRpc(io, parsed, config, 'browser.mouse', {
        ...page,
        action,
        ...(action === 'click' || action === 'move'
          ? {
              x: numberFromOptionOrPosition(parsed, 'x', rest, 0, -100_000, 100_000),
              y: numberFromOptionOrPosition(parsed, 'y', rest, 1, -100_000, 100_000),
            }
          : {}),
        button: parsed.options.button ?? 'left',
      });
    }
    case 'scroll':
      return await printRpc(io, parsed, config, 'browser.scroll', {
        ...page,
        deltaX: numberFromOptionOrPosition(parsed, 'delta-x', rest, 0, -1_000_000, 1_000_000, 0),
        deltaY: numberFromOptionOrPosition(parsed, 'delta-y', rest, 1, -1_000_000, 1_000_000, 700),
      });
    case 'wait-for-selector': {
      const timeoutMs = integerOption(parsed, 'timeout-ms', 30_000, 0, 600_000);
      return await printRpc(io, parsed, config, 'browser.wait', {
        ...page,
        selector: parsed.options.selector ?? requirePositional(rest, 0, 'selector'),
        timeoutMs,
      }, timeoutMs + 5_000);
    }
    case 'wait-for-text': {
      const timeoutMs = integerOption(parsed, 'timeout-ms', 30_000, 0, 600_000);
      return await printRpc(io, parsed, config, 'browser.wait', {
        ...page,
        text: parsed.options.text ?? requirePositional(rest, 0, 'text'),
        timeoutMs,
      }, timeoutMs + 5_000);
    }
    case 'wait-for': {
      const condition = requirePositional(rest, 0, 'ref-or-text');
      const timeoutMs = integerOption(parsed, 'timeout-ms', 30_000, 0, 600_000);
      return await printRpc(io, parsed, config, 'browser.wait', {
        ...page,
        ...snapshot,
        ...(condition.startsWith('@e') ? { ref: condition } : { text: condition }),
        timeoutMs,
      }, timeoutMs + 5_000);
    }
    case 'console':
    case 'network':
      return await printRpc(io, parsed, config, `browser.${command}`, {
        ...page,
        clear: parsed.options.clear === 'true',
      });
    case 'evaluate':
      return await printRpc(io, parsed, config, 'browser.evaluate', {
        ...page,
        script: parsed.options.script ?? rest.join(' '),
      });
    case 'observe-bundle':
      return await printRpc(io, parsed, config, 'browser.observeBundle', {
        ...page,
        ...(parsed.options.screenshot === 'true'
          ? { screenshotPath: parsed.options.out ?? 'sessionplane-observation.png' }
          : {}),
        includeBoxes: parsed.options.boxes === 'true',
        maxTextChars: integerOption(parsed, 'max-chars', 2_000, 1, 2_000_000),
      });
    case 'observe-actions':
      return await printRpc(io, parsed, config, 'browser.observeActions', {
        ...page,
        instruction: rest.join(' ') || requireOption(parsed, 'text'),
        topN: integerOption(parsed, 'top-n', 10, 1, 100),
        includeDisabled: parsed.options['include-disabled'] === 'true',
      });
    default:
      throw new Error(`Unknown browser command: ${command}`);
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
      } else {
        options[name] = 'true';
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

function numberFromOptionOrPosition(
  parsed: ParsedArgs,
  optionName: string,
  positionals: readonly string[],
  positionalIndex: number,
  minimum: number,
  maximum: number,
  fallback?: number,
): number {
  const raw = parsed.options[optionName] ?? positionals[positionalIndex];
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`--${optionName} or positional value is required`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`--${optionName} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
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
  return `SessionPlane ${SESSIONPLANE_VERSION}\n\nUsage:\n  sessplane serve [--state-dir PATH]\n  sessplane health [--json] [--socket PATH]\n  sessplane doctor [--json] [--state-dir PATH]\n  sessplane login [--json] [--url HTTPS_URL]\n\nBrowser compatibility:\n  sessplane tabs | active-tab\n  sessplane new-tab [URL]\n  sessplane select-tab PAGE_KEY\n  sessplane tab-close [PAGE_KEY]\n  sessplane navigate URL [--page PAGE_KEY]\n  sessplane snapshot [--page PAGE_KEY] [--max-nodes N]\n  sessplane click REF [--snapshot-id ID]\n  sessplane type REF --text TEXT\n  sessplane press [REF] KEY\n  sessplane hover|check|uncheck REF\n  sessplane select REF --value VALUE[,VALUE]\n  sessplane upload REF FILE...\n  sessplane drag SOURCE_REF TARGET_REF\n  sessplane screenshot --out PATH [--full-page]\n  sessplane text [--selector CSS] | get-dom\n  sessplane console | network | evaluate --script JS\n  sessplane wait-for-selector CSS | wait-for-text TEXT | wait-for REF_OR_TEXT\n  sessplane observe-bundle [--screenshot --out PATH --boxes]\n  sessplane observe-actions INSTRUCTION [--top-n N]\n\nTeam and role sessions:\n  sessplane team create --name NAME [--objective TEXT] [--request-id ID]\n  sessplane team show TEAM_ID [--json]\n  sessplane team list [--json]\n  sessplane team wait TEAM_ID [--roles KEY,KEY] [--until CONDITION]\n  sessplane team brief [update] TEAM_ID --brief TEXT\n  sessplane role add TEAM_ID ROLE_KEY --type expert|reviewer|custom\n  sessplane role retire TEAM_ID ROLE_KEY\n  sessplane session create TEAM_ID ROLE_KEY [--provider chatgpt]\n  sessplane session show SESSION_ID\n  sessplane session events TEAM_ID [--after-sequence N]\n  sessplane send TEAM_ID ROLE_KEY --prompt TEXT [--model MODEL]\n  sessplane send --session SESSION_ID --prompt TEXT\n  sessplane status TEAM_ID ROLE_KEY | --session SESSION_ID\n  sessplane wait TEAM_ID ROLE_KEY [--generation N] [--wait-ms N]\n  sessplane stop TEAM_ID ROLE_KEY [--request-id ID]\n  sessplane mcp\n\nGlobal options:\n  --client-id ID       Stable caller identity\n  --request-id ID      Stable mutation identity for exact retries\n  --page PAGE_KEY      Explicit browser Page identity\n  --json               Emit one compact JSON object\n  --state-dir PATH     Override runtime state directory\n  --socket PATH        Override core Unix socket\n`;
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
