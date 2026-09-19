import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  findHostBrowser,
  listHostBrowsers,
  type BrowserPreference,
} from '../browser/browser-health.ts';
import { resolveConfig, SESSIONPLANE_VERSION, type SessionPlaneConfig } from '../config.ts';
import {
  ContextPackageService,
  type ContextPackageInput,
} from '../context/context-package.ts';
import { serveForever } from '../main.ts';
import { runMcpServer } from '../mcp/server.ts';
import { SkillDistributionService } from '../skills/skill-distribution.ts';
import { callRpc, RpcClientError } from './client.ts';
import { runDoctor } from './commands/doctor.ts';
import { runLogin } from './commands/login.ts';
import { writeCliError, writeCliResult, type CliIo } from './format.ts';

interface ParsedArgs {
  readonly words: readonly string[];
  readonly options: Readonly<Record<string, string>>;
  readonly multiOptions: Readonly<Record<string, readonly string[]>>;
  readonly files: readonly string[];
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
  'force',
  'deep',
  'include-html',
  'include-binary',
  'stdin-results',
  'overwrite',
  'full',
  'link',
  'files-report',
  'inline-only',
  'allow-grok-context-pack',
  'multi-zip',
  'require-plan',
  'dry-run',
  'manual',
  'resume',
  'no-activate',
]);
const MULTI_VALUE_OPTIONS = new Set(['file', 'context-from-files', 'context-exclude', 'skill']);
const VALUE_OPTIONS = new Set([
  'state-dir',
  'browser',
  'browser-executable',
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
  'effort',
  'surface',
  'file',
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
  'max-bytes',
  'max-redirects',
  'max-results',
  'max-queries',
  'max-actions',
  'schema',
  'from-file',
  'source',
  'backend',
  'verify',
  'results',
  'plan',
  'enrichment',
  'query',
  'timeout',
  'artifact-id',
  'root',
  'context-from-files',
  'context-exclude',
  'context-file',
  'context-transport',
  'context-transform',
  'max-input',
  'max-file-size',
  'max-total-size',
  'target',
  'skill',
  'vendor',
  'max-context-file-size',
  'max-upload-file-size',
  'conversation',
  'output-zip',
  'output-dir',
  'chatgpt-url',
  'project-url',
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
    ...(parsed.options.browser === undefined
      ? {}
      : { browserPreference: parsed.options.browser as BrowserPreference }),
    ...(parsed.options['browser-executable'] === undefined
      ? {}
      : { browserExecutable: parsed.options['browser-executable'] }),
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
      case 'browser-list': {
        const available = listHostBrowsers();
        const selected = findHostBrowser({
          preference: config.browserPreference,
          ...(config.browserExecutable === null
            ? {}
            : { executablePath: config.browserExecutable }),
        });
        writeCliResult(io, parsed.json, {
          requestOk: selected !== null,
          requested: config.browserPreference,
          executableOverride: config.browserExecutable,
          selected,
          available,
        });
        return selected === null ? 1 : 0;
      }
      case 'login': {
        if (parsed.options.manual !== undefined && parsed.options.resume !== undefined) {
          throw new Error('--manual and --resume are mutually exclusive');
        }
        if (parsed.options.resume !== undefined && parsed.options.url !== undefined) {
          throw new Error('--resume does not accept --url');
        }
        const mode = parsed.options.manual !== undefined
          ? 'manual'
          : parsed.options.resume !== undefined
            ? 'resume'
            : 'automated';
        const result = await runLogin(config, {
          mode,
          ...(parsed.options.url === undefined ? {} : { url: parsed.options.url }),
        });
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
      case 'fetch':
        return await runFetchCommand(io, parsed, config);
      case 'extract':
        return await runExtractCommand(io, parsed, config);
      case 'search':
        return await runSearchCommand(io, parsed, config);
      case 'research':
        return await runResearchCommand(io, parsed, config);
      case 'artifact':
        return await runArtifactCommand(io, parsed, config);
      case 'code':
        return await runCodeCommand(io, parsed, config);
      case 'chatgpt':
        return await runChatGptCommand(io, parsed, config);
      case 'context':
        return await runContextCommand(io, parsed, config);
      case 'skills':
        return await runSkillsCommand(io, parsed);
      case 'mcp':
        await runMcpServer({ input: io.stdin, output: io.stdout, error: io.stderr, config });
        return 0;
      case 'tabs':
      case 'browser-status':
      case 'browser-start':
      case 'browser-stop':
      case 'browser-reset':
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

async function assertCoreBrowserSelection(config: SessionPlaneConfig): Promise<void> {
  if (config.browserPreference === 'auto' && config.browserExecutable === null) return;

  const expected = findHostBrowser({
    preference: config.browserPreference,
    ...(config.browserExecutable === null
      ? {}
      : { executablePath: config.browserExecutable }),
  });
  if (expected === null) {
    throw new Error('The requested host browser is unavailable');
  }

  const health = await callRpc<{
    readonly browser?: {
      readonly chrome?: {
        readonly executable?: string;
        readonly product?: string;
      } | null;
    };
  }>({
    socketPath: config.socketPath,
    method: 'system.health',
    params: {},
    timeoutMs: config.rpcRequestTimeoutMs,
    maxLineBytes: config.rpcMaxLineBytes,
  });
  const current = health.browser?.chrome;
  const matches =
    current !== null &&
    current !== undefined &&
    (config.browserExecutable !== null
      ? current.executable === expected.executable
      : current.product === expected.product);
  if (!matches) {
    throw new Error(
      `The running core owns ${current?.product ?? 'an unknown browser'}; ` +
        `restart the core with --browser ${config.browserPreference}`,
    );
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
    case 'browser-status':
      return await printRpc(io, parsed, config, 'browser.runtime.status', {});
    case 'browser-start':
      await assertCoreBrowserSelection(config);
      return await printRpc(
        io,
        parsed,
        config,
        'browser.runtime.start',
        {},
        browserRuntimeRpcTimeoutMs(config),
      );
    case 'browser-stop':
      return await printRpc(
        io,
        parsed,
        config,
        'browser.runtime.stop',
        {},
        browserRuntimeRpcTimeoutMs(config),
      );
    case 'browser-reset':
      return await printRpc(
        io,
        parsed,
        config,
        'browser.runtime.reset',
        {
          force: parsed.options.force === 'true',
        },
        browserRuntimeRpcTimeoutMs(config),
      );
    case 'tabs':
    case 'active-tab':
      return await printRpc(io, parsed, config, 'browser.tabs', {});
    case 'select-tab':
    case 'tab-switch':
      return await printRpc(io, parsed, config, 'browser.select', {
        pageKey: requirePositional(rest, 0, 'pageKey'),
      });
    case 'new-tab':
      return await printRpc(
        io,
        parsed,
        config,
        'browser.new',
        {
          ...optionalParam('url', rest[0] ?? parsed.options.url),
          activate: parsed.options['no-activate'] !== 'true',
        },
        browserNavigationRpcTimeoutMs(config),
      );
    case 'tab-close':
      return await printRpc(io, parsed, config, 'browser.close', {
        ...optionalParam('pageKey', rest[0] ?? pageKey),
      });
    case 'tab-cleanup':
      return await printRpc(io, parsed, config, 'browser.cleanup', {
        ...optionalParam('keepPageKey', pageKey),
      });
    case 'navigate':
      return await printRpc(
        io,
        parsed,
        config,
        'browser.navigate',
        {
          ...page,
          url: requirePositional(rest, 0, 'url'),
        },
        browserNavigationRpcTimeoutMs(config),
      );
    case 'reload':
    case 'back':
    case 'forward':
      return await printRpc(
        io,
        parsed,
        config,
        `browser.${command}`,
        page,
        browserNavigationRpcTimeoutMs(config),
      );
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
        ...optionalParam('selector', parsed.options.selector),
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
      return await printRpc(io, parsed, config, 'browser.console', {
        ...page,
        clear: parsed.options.clear === 'true',
        ...optionalIntegerParam(parsed, 'limit', 'limit', 1, 10_000),
      });
    case 'network':
      return await printRpc(io, parsed, config, 'browser.network', {
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
        maxNodes: integerOption(parsed, 'max-nodes', 250, 1, 5_000),
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
    case 'list':
      return await printRpc(io, parsed, config, 'session.list', { clientId: clientId(parsed) });
    case 'events':
      return await runEventsCommand(io, parsed, config, rest);
    default:
      throw new Error(`Unknown session command: ${action ?? ''}`);
  }
}

export function sessionSendRpcTimeoutMs(
  config: Pick<
    SessionPlaneConfig,
    'rpcRequestTimeoutMs' | 'browserLaunchTimeoutMs' | 'submissionAckTimeoutMs'
  >,
): number {
  return Math.max(
    config.rpcRequestTimeoutMs,
    config.browserLaunchTimeoutMs + config.submissionAckTimeoutMs + 30_000,
  );
}

export function browserNavigationRpcTimeoutMs(
  config: Pick<SessionPlaneConfig, 'rpcRequestTimeoutMs'>,
): number {
  return Math.max(config.rpcRequestTimeoutMs, 35_000);
}

export function browserRuntimeRpcTimeoutMs(
  config: Pick<SessionPlaneConfig, 'rpcRequestTimeoutMs' | 'browserLaunchTimeoutMs'>,
): number {
  return Math.max(
    config.rpcRequestTimeoutMs,
    config.browserLaunchTimeoutMs + 5_000,
    300_000,
  );
}

async function runSendCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  let prompt = requireOption(parsed, 'prompt');
  const files = [...parsed.files];
  if (hasContextInput(parsed)) {
    const contextPackages = new ContextPackageService({ stateDir: config.stateDir });
    const context = contextPackages.render(contextInput(parsed, prompt));
    if (context.transport === 'inline') {
      prompt = context.composerText;
    } else if (context.artifactPath !== null) {
      files.push(context.artifactPath);
    }
  }
  return await printRpc(io, parsed, config, 'session.send', {
    ...mutationIdentity(parsed),
    ...sessionSelector(parsed, parsed.words.slice(1)),
    prompt,
    ...optionalParam('model', parsed.options.model),
    ...optionalParam('effort', parsed.options.effort),
    ...optionalParam('surface', parsed.options.surface),
    ...(files.length === 0 ? {} : { files }),
    ...optionalIntegerParam(parsed, 'deadline', 'sessionDeadlineSec', 1, 86_400),
  }, sessionSendRpcTimeoutMs(config));
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

async function runFetchCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const url = parsed.options.url ?? requirePositional(parsed.words.slice(1), 0, 'url');
  const timeoutMs = integerOption(parsed, 'timeout-ms', config.fetchTimeoutMs, 1, 120_000);
  return await printRpc(io, parsed, config, 'fetch.read', {
    url,
    timeoutMs,
    maxBytes: integerOption(parsed, 'max-bytes', config.fetchMaxBytes, 1, 25 * 1024 * 1024),
    maxRedirects: integerOption(parsed, 'max-redirects', config.fetchMaxRedirects, 0, 20),
    maxExtractChars: integerOption(parsed, 'max-chars', 500_000, 1, 2_000_000),
    includeHtml: parsed.options['include-html'] === 'true',
    includeBinary: parsed.options['include-binary'] === 'true',
  }, timeoutMs + 2_000);
}

async function runExtractCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const schema = readJsonFile(requireOption(parsed, 'schema'), 'schema');
  const sourceMode = parsed.options.source;
  const fromFile = parsed.options['from-file'];
  const url = parsed.words[1] ?? parsed.options.url;
  if (fromFile === undefined && url === undefined) {
    throw new Error('extract requires a URL or --from-file PATH');
  }
  const params: Record<string, unknown> = {
    schema,
    ...(sourceMode === undefined ? {} : { sourceMode }),
  };
  if (fromFile !== undefined) params.html = readFileSync(fromFile, 'utf8');
  else params.url = url;
  return await printRpc(io, parsed, config, 'extract.schema', params, config.fetchTimeoutMs + 2_000);
}

async function runSearchCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const verifyUrl = parsed.options.verify;
  const query = (parsed.options.query ?? parsed.words.slice(1).join(' ') ?? '').trim() || verifyUrl;
  if (query === undefined || query.trim() === '') throw new Error('search query is required');
  let results: unknown = undefined;
  if (parsed.options.results !== undefined) results = readJsonFile(parsed.options.results, 'results');
  else if (parsed.options['stdin-results'] === 'true') results = parseJsonText(await readInput(io.stdin), 'stdin results');
  return await printRpc(io, parsed, config, 'search.query', {
    query,
    ...(results === undefined ? {} : { results }),
    ...optionalParam('backend', parsed.options.backend),
    ...optionalParam('verifyUrl', verifyUrl),
    maxResults: integerOption(
      parsed,
      'max-results',
      config.searchMaxCandidates,
      1,
      50,
    ),
    deep: parsed.options.deep === 'true',
  }, Math.max(config.rpcRequestTimeoutMs, config.fetchTimeoutMs * config.searchMaxCandidates));
}

async function runResearchCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const action = parsed.words[1] ?? 'plan';
  switch (action) {
    case 'plan': {
      const query = parsed.options.query ?? parsed.words.slice(2).join(' ');
      if (query.trim() === '') throw new Error('research plan requires a query');
      return await printRpc(io, parsed, config, 'research.plan', {
        query,
        maxQueries: integerOption(parsed, 'max-queries', 6, 1, 20),
      });
    }
    case 'normalize-results': {
      const results = parsed.options.results !== undefined
        ? readJsonFile(parsed.options.results, 'results')
        : parsed.files[0] !== undefined
          ? readJsonFile(parsed.files[0], 'results')
          : parsed.options['stdin-results'] === 'true'
            ? parseJsonText(await readInput(io.stdin), 'stdin results')
            : undefined;
      if (results === undefined) throw new Error('research normalize-results requires --results FILE or --stdin-results');
      const query = parsed.options.query ?? parsed.words.slice(2).join(' ');
      if (query.trim() === '') throw new Error('research normalize-results requires --query');
      return await printRpc(io, parsed, config, 'research.normalize', {
        query,
        results,
        ...optionalParam('backend', parsed.options.backend),
        maxResults: integerOption(parsed, 'max-results', 100, 1, 500),
      });
    }
    case 'enrich-fetch': {
      const planPath = requireOption(parsed, 'plan');
      const resultsPath = requireOption(parsed, 'results');
      return await printRpc(io, parsed, config, 'research.enrich', {
        plan: readJsonFile(planPath, 'plan'),
        results: readJsonFile(resultsPath, 'results'),
        maxResults: integerOption(parsed, 'max-results', config.searchMaxCandidates, 1, 100),
      }, Math.max(config.rpcRequestTimeoutMs, config.fetchTimeoutMs * config.searchMaxCandidates));
    }
    case 'browse-plan': {
      const planPath = requireOption(parsed, 'plan');
      const enrichmentPath = requireOption(parsed, 'enrichment');
      return await printRpc(io, parsed, config, 'research.browsePlan', {
        plan: readJsonFile(planPath, 'plan'),
        enrichment: readJsonFile(enrichmentPath, 'enrichment'),
        maxActions: integerOption(parsed, 'max-actions', 10, 1, 50),
      });
    }
    default:
      throw new Error(`Unknown research command: ${action}`);
  }
}

async function runArtifactCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const action = parsed.words[1] ?? 'list';
  const rest = parsed.words.slice(2);
  switch (action) {
    case 'discover':
      return await printRpc(io, parsed, config, 'artifact.discover', {
        clientId: clientId(parsed),
        ...sessionSelector(parsed, rest),
        ...optionalIntegerParam(parsed, 'generation', 'generation', 1),
      }, 120_000);
    case 'capture':
      return await printRpc(io, parsed, config, 'artifact.capture', {
        clientId: clientId(parsed),
        ...sessionSelector(parsed, rest),
        ...optionalIntegerParam(parsed, 'generation', 'generation', 1),
        ...(parsed.options['artifact-id'] === undefined
          ? {}
          : { artifactIds: [parsed.options['artifact-id']] }),
      }, 120_000);
    case 'list':
      return await printRpc(io, parsed, config, 'artifact.list', {
        clientId: clientId(parsed),
        ...sessionSelector(parsed, rest),
        ...optionalIntegerParam(parsed, 'generation', 'generation', 1),
      });
    case 'get':
      return await printRpc(io, parsed, config, 'artifact.get', {
        clientId: clientId(parsed),
        artifactId: requirePositional(rest, 0, 'artifactId'),
      });
    case 'export':
      return await printRpc(io, parsed, config, 'artifact.export', {
        clientId: clientId(parsed),
        artifactId: requirePositional(rest, 0, 'artifactId'),
        outputPath: requireOption(parsed, 'out'),
        overwrite: parsed.options.overwrite === 'true',
      }, 120_000);
    default:
      throw new Error(`Unknown artifact command: ${action}`);
  }
}

async function runCodeCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const action = parsed.words[1] ?? 'generate';
  const rest = parsed.words.slice(2);
  if (action === 'generate' || action === 'run') {
    let prompt = requireOption(parsed, 'prompt');
    const files = [...parsed.files];
    if (hasContextInput(parsed)) {
      const contextPackages = new ContextPackageService({ stateDir: config.stateDir });
      const context = contextPackages.render(contextInput(parsed, prompt));
      if (context.transport === 'inline') prompt = context.composerText;
      else if (context.artifactPath !== null) files.push(context.artifactPath);
    }
    const deadline = integerOption(parsed, 'deadline', 5_400, 1, 86_400);
    return await printRpc(
      io,
      parsed,
      config,
      'code.generate',
      {
        ...mutationIdentity(parsed),
        ...sessionSelector(parsed, rest),
        prompt,
        ...optionalParam('model', parsed.options.model),
        ...optionalParam('effort', parsed.options.effort),
        ...(files.length === 0 ? {} : { files }),
        sessionDeadlineSec: deadline,
        ...optionalParam('outputPath', parsed.options['output-zip'] ?? parsed.options.out),
        ...optionalParam('outputDir', parsed.options['output-dir']),
        multiZip: parsed.options['multi-zip'] === 'true',
        overwrite: parsed.options.overwrite === 'true',
      },
      deadline * 1_000 + config.submissionAckTimeoutMs + 10_000,
    );
  }
  if (action === 'extract') {
    const selector = optionalSessionSelector(parsed, rest);
    const conversationId = parsed.options.conversation ?? parsed.options.url;
    const timeoutMs = Math.max(config.rpcRequestTimeoutMs, 120_000);
    return await printRpc(
      io,
      parsed,
      config,
      'code.extract',
      {
        clientId: clientId(parsed),
        ...selector,
        ...optionalParam('conversationId', conversationId),
        ...optionalIntegerParam(parsed, 'generation', 'generation', 1),
        ...optionalParam('outputPath', parsed.options['output-zip'] ?? parsed.options.out),
        ...optionalParam('outputDir', parsed.options['output-dir']),
        multiZip: parsed.options['multi-zip'] === 'true',
        requirePlan: parsed.options['require-plan'] === 'true',
        overwrite: parsed.options.overwrite === 'true',
      },
      timeoutMs,
    );
  }
  throw new Error(`Unknown code command: ${action}`);
}

async function runChatGptCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const family = parsed.words[1];
  const action = parsed.words[2];
  if (family === 'project-sources' && (action === 'list' || action === 'add')) {
    const projectUrl =
      parsed.options['project-url'] ?? parsed.options['chatgpt-url'] ?? parsed.options.url;
    if (projectUrl === undefined) throw new Error('--project-url or --chatgpt-url is required');
    if (action === 'list') {
      return await printRpc(io, parsed, config, 'chatgpt.projectSources.list', {
        clientId: clientId(parsed),
        projectUrl,
      }, 60_000);
    }
    return await printRpc(io, parsed, config, 'chatgpt.projectSources.add', {
      ...mutationIdentity(parsed),
      projectUrl,
      files: parsed.files,
      dryRun: parsed.options['dry-run'] !== undefined,
    }, 120_000);
  }
  throw new Error(`Unknown chatgpt command: ${[family, action].filter(Boolean).join(' ')}`);
}

async function runContextCommand(
  io: CliIo,
  parsed: ParsedArgs,
  config: SessionPlaneConfig,
): Promise<number> {
  const action = parsed.words[1] ?? 'dry-run';
  const service = new ContextPackageService({ stateDir: config.stateDir });
  const input = contextInput(parsed, parsed.options.prompt ?? '');
  if (action === 'dry-run') {
    const result = service.dryRun(input);
    writeCliResult(io, parsed.json, contextOutput(result, parsed.options.full === 'true'));
    return 0;
  }
  if (action === 'render') {
    const result = service.render(input);
    writeCliResult(io, parsed.json, result);
    return 0;
  }
  throw new Error(`Unknown context command: ${action}`);
}

async function runSkillsCommand(io: CliIo, parsed: ParsedArgs): Promise<number> {
  const action = parsed.words[1] ?? 'list';
  const service = new SkillDistributionService();
  switch (action) {
    case 'list':
      writeCliResult(io, parsed.json, { requestOk: true, skills: service.list() });
      return 0;
    case 'get':
      writeCliResult(
        io,
        parsed.json,
        service.get(requirePositional(parsed.words.slice(2), 0, 'skill'), parsed.options.full === 'true'),
      );
      return 0;
    case 'path':
      writeCliResult(io, parsed.json, service.path(parsed.words[2]));
      return 0;
    case 'install':
      writeCliResult(
        io,
        parsed.json,
        service.install({
          target: requireOption(parsed, 'target'),
          ...(optionValues(parsed, 'skill').length === 0
            ? {}
            : { names: optionValues(parsed, 'skill') }),
          link: parsed.options.link === 'true',
          force: parsed.options.force === 'true',
        }),
      );
      return 0;
    default:
      throw new Error(`Unknown skills command: ${action}`);
  }
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
  const multiOptions: Record<string, string[]> = {};
  const files: string[] = [];
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
    if (MULTI_VALUE_OPTIONS.has(name)) {
      const values = multiOptions[name] ?? [];
      values.push(value);
      multiOptions[name] = values;
    }
    if (name === 'file') files.push(value);
    else options[name] = value;
  }

  return { words, options, multiOptions, files, json };
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

function optionalSessionSelector(
  parsed: ParsedArgs,
  positionals: readonly string[],
): Readonly<Record<string, string>> {
  if (parsed.options.session !== undefined || positionals.length > 0) {
    return sessionSelector(parsed, positionals);
  }
  return {};
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

function optionValues(parsed: ParsedArgs, name: string): readonly string[] {
  return parsed.multiOptions[name] ?? (parsed.options[name] === undefined ? [] : [parsed.options[name]]);
}

function hasContextInput(parsed: ParsedArgs): boolean {
  return (
    optionValues(parsed, 'context-from-files').length > 0 ||
    optionValues(parsed, 'context-exclude').length > 0 ||
    parsed.options['context-file'] !== undefined
  );
}

function contextInput(parsed: ParsedArgs, prompt: string): ContextPackageInput {
  return {
    ...(parsed.options.root === undefined ? {} : { root: parsed.options.root }),
    ...(optionValues(parsed, 'context-from-files').length === 0
      ? {}
      : { includes: optionValues(parsed, 'context-from-files') }),
    ...(optionValues(parsed, 'context-exclude').length === 0
      ? {}
      : { excludes: optionValues(parsed, 'context-exclude') }),
    ...(parsed.options['context-file'] === undefined
      ? {}
      : { contextFile: parsed.options['context-file'] }),
    ...(prompt.length === 0 ? {} : { prompt }),
    transport: parseContextTransport(parsed.options['context-transport']),
    transform: parseContextTransform(parsed.options['context-transform']),
    maxInputTokens: integerOption(parsed, 'max-input', 120_000, 1, 10_000_000),
    maxFileBytes: integerOption(
      parsed,
      parsed.options['max-context-file-size'] === undefined
        ? 'max-file-size'
        : 'max-context-file-size',
      2 * 1024 * 1024,
      1,
      1024 * 1024 * 1024,
    ),
    maxTotalBytes: integerOption(
      parsed,
      'max-total-size',
      20 * 1024 * 1024,
      1,
      2 * 1024 * 1024 * 1024,
    ),
  };
}

function parseContextTransport(value: string | undefined): 'inline' | 'upload' {
  const resolved = value ?? 'upload';
  if (resolved !== 'inline' && resolved !== 'upload') {
    throw new Error('--context-transport must be inline or upload');
  }
  return resolved;
}

function parseContextTransform(value: string | undefined): 'raw' | 'repomix' {
  const resolved = value ?? 'raw';
  if (resolved !== 'raw' && resolved !== 'repomix') {
    throw new Error('--context-transform must be raw or repomix');
  }
  return resolved;
}

function contextOutput(
  result: ReturnType<ContextPackageService['dryRun']>,
  full: boolean,
): unknown {
  if (full) return result;
  return {
    ...result,
    files: result.files.map(({ content: _content, ...file }) => file),
    composerText: '',
  };
}

function readJsonFile(path: string, label: string): unknown {
  return parseJsonText(readFileSync(path, 'utf8'), label);
}

function parseJsonText(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function readInput(stream: NodeJS.ReadableStream): Promise<string> {
  let value = '';
  for await (const chunk of stream) {
    value += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
    if (value.length > 20 * 1024 * 1024) throw new Error('stdin exceeded 20 MiB');
  }
  return value;
}

function normalizeUntil(value: string): string {
  const normalized = value.replaceAll('-', '_');
  if (!['any_change', 'primary_terminal', 'all_selected_terminal'].includes(normalized)) {
    throw new Error(`Unknown team wait condition: ${value}`);
  }
  return normalized;
}

function helpText(): string {
  return `SessionPlane ${SESSIONPLANE_VERSION}

Usage:
  sessplane serve [--state-dir PATH]
  sessplane health [--json] [--socket PATH]
  sessplane doctor [--json] [--state-dir PATH]
  sessplane browser-list [--browser NAME] [--browser-executable PATH]
  sessplane login [--manual|--resume] [--json] [--url HTTPS_URL]

Browser compatibility:
  sessplane browser-status | browser-start | browser-stop
  sessplane browser-reset --force
  sessplane tabs | active-tab
  sessplane new-tab [URL] [--no-activate]
  sessplane select-tab PAGE_KEY
  sessplane tab-close [PAGE_KEY]
  sessplane navigate URL [--page PAGE_KEY]
  sessplane snapshot [--page PAGE_KEY] [--all-nodes] [--max-nodes N]
  sessplane click REF [--snapshot-id ID]
  sessplane type REF --text TEXT
  sessplane press [REF] KEY
  sessplane hover|check|uncheck REF
  sessplane select REF --value VALUE[,VALUE]
  sessplane upload REF FILE...
  sessplane drag SOURCE_REF TARGET_REF
  sessplane screenshot --out PATH [--full-page]
  sessplane text [--selector CSS] | get-dom [--selector CSS] [--max-chars N]
  sessplane console [--limit N] [--clear] | network [--clear] | evaluate --script JS
  sessplane wait-for-selector CSS | wait-for-text TEXT | wait-for REF_OR_TEXT
  sessplane observe-bundle [--screenshot --out PATH --boxes] [--max-chars N] [--max-nodes N]
  sessplane observe-actions INSTRUCTION [--top-n N]

Fetch, search, and research:
  sessplane fetch URL [--max-bytes N] [--max-redirects N] [--include-html]
  sessplane extract URL --schema FILE [--source auto|json|jsonld|table]
  sessplane extract --from-file HTML --schema FILE
  sessplane search QUERY [--max-results N] [--deep]
  sessplane search --verify URL
  sessplane search QUERY --results FILE [--backend NAME]
  sessplane research plan QUERY [--max-queries N]
  sessplane research normalize-results --query QUERY --results FILE --backend NAME
  sessplane research enrich-fetch --plan PLAN --results RESULTS
  sessplane research browse-plan --plan PLAN --enrichment ENRICHMENT

Context packages:
  sessplane context dry-run --context-from-files GLOB [--context-exclude GLOB]
  sessplane context render --context-file FILE --context-transport inline|upload
  sessplane send ... --context-from-files GLOB --context-transform raw|repomix

Team and role sessions:
  sessplane team create --name NAME [--objective TEXT] [--request-id ID]
  sessplane team show TEAM_ID [--json]
  sessplane team list [--json]
  sessplane team wait TEAM_ID [--roles KEY,KEY] [--until CONDITION]
  sessplane team brief [update] TEAM_ID --brief TEXT
  sessplane role add TEAM_ID ROLE_KEY --type expert|reviewer|custom
  sessplane role retire TEAM_ID ROLE_KEY
  sessplane session create TEAM_ID ROLE_KEY [--provider chatgpt|gemini|grok]
  sessplane session show SESSION_ID
  sessplane session events TEAM_ID [--after-sequence N]
  sessplane send TEAM_ID ROLE_KEY --prompt TEXT [--model MODEL] [--effort LEVEL] [--surface NAME] [--file PATH ...]
  sessplane send --session SESSION_ID --prompt TEXT
  sessplane status TEAM_ID ROLE_KEY | --session SESSION_ID
  sessplane wait TEAM_ID ROLE_KEY [--generation N] [--wait-ms N]
  sessplane stop TEAM_ID ROLE_KEY [--request-id ID]

Advanced ChatGPT Chat and code artifacts:
  sessplane chatgpt project-sources list --project-url URL
  sessplane chatgpt project-sources add --project-url URL --file PATH [--dry-run]
  sessplane code generate --session SESSION_ID --prompt TEXT [--output-zip PATH]
  sessplane code generate --session SESSION_ID --prompt TEXT --multi-zip --output-dir DIR
  sessplane code extract --session SESSION_ID [--output-zip PATH] [--require-plan]
  sessplane code extract --conversation ID_OR_URL [--multi-zip --output-dir DIR]

Provider artifacts:
  sessplane artifact discover --session SESSION_ID
  sessplane artifact capture --session SESSION_ID [--artifact-id ID]
  sessplane artifact list --session SESSION_ID [--generation N]
  sessplane artifact get ARTIFACT_ID
  sessplane artifact export ARTIFACT_ID --out PATH [--overwrite]

Skill distribution:
  sessplane skills list [--json]
  sessplane skills get core --full
  sessplane skills path [SKILL]
  sessplane skills install --target DIR [--skill NAME ...] [--link] [--force]

  sessplane mcp

Global options:
  --client-id ID       Stable caller identity
  --request-id ID      Stable mutation identity for exact retries
  --page PAGE_KEY      Explicit browser Page identity
  --json               Emit one compact JSON object
  --state-dir PATH     Override runtime state directory
  --socket PATH        Override core Unix socket
  --browser NAME       auto|chrome|chromium|edge|brave|custom
  --browser-executable PATH  Explicit host Chromium-family executable
`;
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
