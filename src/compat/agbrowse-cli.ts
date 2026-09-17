import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

import { runCli } from '../cli/main.ts';
import { callRpc, RpcClientError } from '../cli/client.ts';
import { writeCliError, writeCliResult, type CliIo } from '../cli/format.ts';
import { resolveConfig, type SessionPlaneConfig } from '../config.ts';
import {
  capabilityForLegacyCommand,
  loadAgbrowseManifest,
} from './agbrowse-manifest.ts';

export async function runAgbrowseCli(
  argv: readonly string[],
  io: CliIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  const command = argv[0] ?? '--help';
  const json = argv.includes('--json') || process.env.AGBROWSE_JSON_ERRORS === '1';
  const manifest = loadAgbrowseManifest();
  const capability = capabilityForLegacyCommand(manifest, command);
  if (
    capability !== null &&
    capability.required &&
    capability.status !== 'implemented' &&
    !['web-ai'].includes(command)
  ) {
    return writeCompatibilityUnsupported(io, json, command, capability.id, capability.status);
  }

  try {
    switch (command) {
      case 'start':
        return await startCompatibilityCore(argv.slice(1), io, json);
      case 'status':
        return await runCli(['health', ...globalArgs(argv.slice(1))], io);
      case 'stop':
        return await runCli(['browser-stop', ...globalArgs(argv.slice(1))], io);
      case 'reset':
        return await runCli(['browser-reset', ...translateFlags(argv.slice(1))], io);
      case 'web-ai':
        return await runWebAiCompatibility(argv.slice(1), io, json);
      case 'tabs':
      case 'active-tab':
        return await runTransformedBrowserRead(command, argv.slice(1), io, json);
      case 'tab-switch':
      case 'select-tab':
        return await runTabSelect(argv.slice(1), io, json);
      case 'new-tab':
        return await runTransformedBrowserRead('new-tab', stripFlag(argv.slice(1), '--no-activate'), io, json);
      case 'snapshot':
        return await runTransformedBrowserRead('snapshot', argv.slice(1), io, json);
      case 'click':
        return await runCli(translateClick(argv), io);
      case 'type':
        return await runLegacyType(argv, io);
      case 'select':
        return await runCli(translateSelect(argv), io);
      case 'hover':
      case 'check':
      case 'uncheck':
      case 'wait-for':
        return await runCli(translateFirstRef(argv), io);
      case 'drag':
        return await runCli(translateDrag(argv), io);
      case 'scroll':
        return await runCli(translateScroll(argv), io);
      case 'wait':
        return await runLegacyWait(argv.slice(1), io, json);
      case 'text':
        return await runCli(translateText(argv), io);
      default:
        return await runCli(translateFlags(argv), io);
    }
  } catch (error) {
    writeCliError(io, json, error);
    return error instanceof RpcClientError ? 1 : 2;
  }
}

async function runWebAiCompatibility(
  argv: readonly string[],
  io: CliIo,
  json: boolean,
): Promise<number> {
  const action = argv[0] ?? 'status';
  if (action === 'work' || action === 'code' || action === 'code-extract' || action === 'project-sources') {
    return writeCompatibilityUnsupported(io, json, `web-ai ${action}`, 'web-ai.advanced-chatgpt', 'missing');
  }
  if (action === 'context-dry-run' || action === 'context-render') {
    return writeCompatibilityUnsupported(io, json, `web-ai ${action}`, 'context.package', 'missing');
  }

  const config = configFromArgs(argv);
  const clientId = optionValue(argv, '--client-id') ??
    process.env.SESSIONPLANE_CLIENT_ID ??
    'agbrowse-cli';
  switch (action) {
    case 'render': {
      const prompt = requireArgOption(argv, '--prompt');
      writeCliResult(io, json, {
        ok: true,
        status: 'rendered',
        vendor: providerOption(argv),
        prompt,
        model: optionValue(argv, '--model') ?? optionValue(argv, '--family') ?? null,
        effort: optionValue(argv, '--effort') ?? optionValue(argv, '--reasoning-effort') ?? null,
        surface: optionValue(argv, '--surface') ?? 'chat',
        files: optionValues(argv, '--file'),
      });
      return 0;
    }
    case 'status': {
      const sessionId = optionValue(argv, '--session');
      const result = sessionId === undefined
        ? await callRpc<Record<string, unknown>>({
            socketPath: config.socketPath,
            method: 'system.health',
            params: {},
            timeoutMs: config.rpcRequestTimeoutMs,
            maxLineBytes: config.rpcMaxLineBytes,
          })
        : await getSession(config, clientId, sessionId);
      writeCliResult(io, json, legacyWebAiEnvelope(result));
      return 0;
    }
    case 'send': {
      const snapshot = await sendWebAi(argv, config, clientId);
      writeCliResult(io, json, legacyWebAiEnvelope(snapshot));
      return 0;
    }
    case 'query': {
      const submitted = await sendWebAi(argv, config, clientId);
      const terminal = await pollWebAi(
        config,
        clientId,
        submitted.sessionId as string,
        numberOption(argv, '--timeout', 1_200) * 1_000,
        Number(submitted.generation),
      );
      writeCliResult(io, json, legacyWebAiEnvelope(terminal));
      return 0;
    }
    case 'poll':
    case 'watch': {
      const sessionId = requireArgOption(argv, '--session');
      const current = await getSession(config, clientId, sessionId);
      const terminal = await pollWebAi(
        config,
        clientId,
        sessionId,
        numberOption(argv, '--timeout', action === 'watch' ? 1_200 : 30) * 1_000,
        Number(current.generation),
      );
      writeCliResult(io, json, legacyWebAiEnvelope(terminal));
      return 0;
    }
    case 'stop': {
      const sessionId = requireArgOption(argv, '--session');
      const requestId = optionValue(argv, '--request-id') ?? randomUUID();
      const result = await callRpc<Record<string, unknown>>({
        socketPath: config.socketPath,
        method: 'session.stop',
        params: { clientId, requestId, sessionId },
        timeoutMs: config.rpcRequestTimeoutMs,
        maxLineBytes: config.rpcMaxLineBytes,
      });
      writeCliResult(io, json, legacyWebAiEnvelope(result));
      return 0;
    }
    case 'snapshot': {
      const sessionId = requireArgOption(argv, '--session');
      const session = await getSession(config, clientId, sessionId);
      if (typeof session.pageKey !== 'string') {
        throw new Error(`Session ${sessionId} has no exact pageKey`);
      }
      const result = await callRpc<Record<string, unknown>>({
        socketPath: config.socketPath,
        method: 'browser.snapshot',
        params: {
          pageKey: session.pageKey,
          interactive: true,
          maxNodes: numberOption(argv, '--max-nodes', 250),
        },
        timeoutMs: config.rpcRequestTimeoutMs,
        maxLineBytes: config.rpcMaxLineBytes,
      });
      writeCliResult(io, json, { ok: true, status: 'snapshot', sessionId, ...result });
      return 0;
    }
    case 'sessions':
      return await runWebAiSessions(argv.slice(1), config, clientId, io, json);
    case 'doctor': {
      const [health, sessions] = await Promise.all([
        callRpc<Record<string, unknown>>({
          socketPath: config.socketPath,
          method: 'system.health',
          params: {},
          timeoutMs: config.rpcRequestTimeoutMs,
          maxLineBytes: config.rpcMaxLineBytes,
        }),
        listSessions(config, clientId),
      ]);
      writeCliResult(io, json, {
        ok: true,
        status: 'ok',
        health,
        sessions: sessions.sessions,
      });
      return 0;
    }
    default:
      return writeCompatibilityUnsupported(io, json, `web-ai ${action}`, 'web-ai.advanced-chatgpt', 'missing');
  }
}

async function sendWebAi(
  argv: readonly string[],
  config: SessionPlaneConfig,
  clientId: string,
): Promise<Record<string, unknown>> {
  const provider = providerOption(argv);
  const prompt = requireArgOption(argv, '--prompt');
  const requestId = optionValue(argv, '--request-id') ?? randomUUID();
  let sessionId = optionValue(argv, '--session');
  if (sessionId === undefined) {
    const team = await callRpc<{ teamId: string }>({
      socketPath: config.socketPath,
      method: 'team.create',
      params: {
        clientId,
        requestId: `${requestId}:team`,
        name: `agbrowse ${provider} session`,
        objective: 'Legacy agbrowse web-ai compatibility session',
        primaryRoleKey: 'main',
      },
      timeoutMs: config.rpcRequestTimeoutMs,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    const session = await callRpc<{ sessionId: string }>({
      socketPath: config.socketPath,
      method: 'session.create',
      params: {
        clientId,
        requestId: `${requestId}:session`,
        teamId: team.teamId,
        roleKey: 'main',
        provider,
      },
      timeoutMs: config.rpcRequestTimeoutMs,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    sessionId = session.sessionId;
  } else {
    const existing = await getSession(config, clientId, sessionId);
    if (existing.provider !== provider) {
      throw new Error(
        `Session ${sessionId} belongs to ${String(existing.provider)}, not ${provider}`,
      );
    }
  }
  return await callRpc<Record<string, unknown>>({
    socketPath: config.socketPath,
    method: 'session.send',
    params: {
      clientId,
      requestId: `${requestId}:send`,
      sessionId,
      prompt,
      model: optionValue(argv, '--model') ?? optionValue(argv, '--family') ?? null,
      effort: optionValue(argv, '--effort') ?? optionValue(argv, '--reasoning-effort') ?? null,
      surface: optionValue(argv, '--surface') ?? 'chat',
      files: optionValues(argv, '--file'),
      sessionDeadlineSec: numberOption(argv, '--timeout', 1_200),
    },
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, config.submissionAckTimeoutMs + 5_000),
    maxLineBytes: config.rpcMaxLineBytes,
  });
}

async function pollWebAi(
  config: SessionPlaneConfig,
  clientId: string,
  sessionId: string,
  waitMs: number,
  generation: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + waitMs;
  let cursor = 0;
  let current = await getSession(config, clientId, sessionId);
  while (current.terminal !== true && Date.now() < deadline) {
    const remaining = Math.max(0, deadline - Date.now());
    current = await callRpc<Record<string, unknown>>({
      socketPath: config.socketPath,
      method: 'session.wait',
      params: {
        clientId,
        sessionId,
        generation,
        afterEventSequence: cursor,
        waitMs: Math.min(120_000, remaining),
      },
      timeoutMs: Math.min(120_000, remaining) + 5_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    cursor = Math.max(cursor, Number(current.latestEventSequence ?? 0));
    if (current.waitExpired === true && remaining <= 120_000) break;
  }
  return current;
}

async function runWebAiSessions(
  argv: readonly string[],
  config: SessionPlaneConfig,
  clientId: string,
  io: CliIo,
  json: boolean,
): Promise<number> {
  const action = argv[0] ?? 'list';
  if (action === 'list') {
    const result = await listSessions(config, clientId);
    writeCliResult(io, json, { ok: true, status: 'sessions', ...result });
    return 0;
  }
  if (['show', 'resume', 'reattach', 'doctor'].includes(action)) {
    const sessionId = optionValue(argv, '--session') ?? argv[1];
    if (sessionId === undefined) throw new Error(`web-ai sessions ${action} requires session id`);
    const result = await getSession(config, clientId, sessionId);
    writeCliResult(io, json, legacyWebAiEnvelope(result));
    return 0;
  }
  return writeCompatibilityUnsupported(io, json, `web-ai sessions ${action}`, 'web-ai.chatgpt', 'foundation');
}

async function listSessions(
  config: SessionPlaneConfig,
  clientId: string,
): Promise<{ requestOk: boolean; sessions: unknown }> {
  return await callRpc({
    socketPath: config.socketPath,
    method: 'session.list',
    params: { clientId },
    timeoutMs: config.rpcRequestTimeoutMs,
    maxLineBytes: config.rpcMaxLineBytes,
  });
}

async function getSession(
  config: SessionPlaneConfig,
  clientId: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return await callRpc<Record<string, unknown>>({
    socketPath: config.socketPath,
    method: 'session.get',
    params: { clientId, sessionId },
    timeoutMs: config.rpcRequestTimeoutMs,
    maxLineBytes: config.rpcMaxLineBytes,
  });
}

function legacyWebAiEnvelope(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ok: value.requestOk !== false,
    status:
      typeof value.sessionState === 'string'
        ? value.sessionState
        : typeof value.status === 'string'
          ? value.status
          : 'ok',
    ...value,
  };
}

function providerOption(argv: readonly string[]): 'chatgpt' | 'gemini' | 'grok' {
  const value = optionValue(argv, '--vendor') ?? 'chatgpt';
  if (value !== 'chatgpt' && value !== 'gemini' && value !== 'grok') {
    throw new Error(`Unsupported provider: ${value}`);
  }
  return value;
}

function requireArgOption(argv: readonly string[], name: string): string {
  const value = optionValue(argv, name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionValues(argv: readonly string[], name: string): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === name) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} requires a value`);
      result.push(next);
      index += 1;
    } else if (value?.startsWith(`${name}=`)) {
      result.push(value.slice(name.length + 1));
    }
  }
  return result;
}

function numberOption(argv: readonly string[], name: string, fallback: number): number {
  const raw = optionValue(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  process.exitCode = await runAgbrowseCli(argv);
}

async function startCompatibilityCore(
  argv: readonly string[],
  io: CliIo,
  json: boolean,
): Promise<number> {
  const config = configFromArgs(argv);
  let health = await tryHealth(config);
  if (health === null) {
    const cliPath = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', cliPath, 'serve', ...globalArgs(argv)],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          SESSIONPLANE_LOG_LEVEL: process.env.SESSIONPLANE_LOG_LEVEL ?? 'warn',
          ...(argv.includes('--headless') ? { SESSIONPLANE_BROWSER_HEADLESS: '1' } : {}),
        },
      },
    );
    child.unref();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      health = await tryHealth(config);
      if (health !== null) break;
    }
    if (health === null) {
      throw new Error('SessionPlane core did not become ready after agbrowse start');
    }
  }

  const browser = health.browser as { state?: string } | undefined;
  if (browser?.state === 'stopped' || browser?.state === 'not_started') {
    await callRpc({
      socketPath: config.socketPath,
      method: 'browser.runtime.start',
      params: {},
      timeoutMs: config.browserLaunchTimeoutMs + 5_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    health = await requireHealth(config);
  }
  writeCliResult(io, json, {
    requestOk: true,
    status: 'running',
    service: health.service,
    process: health.process,
    browser: health.browser,
    socket: health.socket,
  });
  return 0;
}

async function runTransformedBrowserRead(
  command: string,
  args: readonly string[],
  io: CliIo,
  json: boolean,
): Promise<number> {
  const result = await captureCli([command, ...args.filter((arg) => arg !== '--json'), '--json']);
  if (result.code !== 0) {
    io.stderr.write(`${result.stderr}\n`);
    return result.code;
  }
  const value = JSON.parse(result.stdout) as Record<string, unknown>;
  if (command === 'snapshot' && Array.isArray(value.nodes)) {
    value.nodes = value.nodes.map((entry) => {
      const node = entry as Record<string, unknown>;
      const ref = typeof node.ref === 'string' ? node.ref : '';
      return {
        ...node,
        ref: legacyRef(ref),
        canonicalRef: ref,
      };
    });
  }
  if ((command === 'tabs' || command === 'active-tab') && Array.isArray(value.tabs)) {
    value.tabs = value.tabs.map((entry, index) => {
      const tab = entry as Record<string, unknown>;
      return { index, targetId: tab.pageKey, ...tab };
    });
    value.activeTargetId = value.selectedPageKey ?? null;
  }
  if (command === 'new-tab' && typeof value.selectedPageKey === 'string') {
    value.targetId = value.selectedPageKey;
  }
  writeCliResult(io, json, value);
  return 0;
}

async function runTabSelect(
  args: readonly string[],
  io: CliIo,
  json: boolean,
): Promise<number> {
  const target = args.find((arg) => !arg.startsWith('--'));
  if (target === undefined) throw new Error('tab target is required');
  let pageKey = target;
  if (/^\d+$/.test(target)) {
    const tabs = await captureCli(['tabs', ...globalArgs(args), '--json']);
    if (tabs.code !== 0) throw new Error(tabs.stderr);
    const parsed = JSON.parse(tabs.stdout) as {
      tabs: ReadonlyArray<{ pageKey: string }>;
    };
    const selected = parsed.tabs[Number(target)];
    if (selected === undefined) throw new Error(`Unknown tab index: ${target}`);
    pageKey = selected.pageKey;
  }
  const run = await captureCli(['select-tab', pageKey, ...globalArgs(args), '--json']);
  if (run.code !== 0) {
    io.stderr.write(`${run.stderr}\n`);
    return run.code;
  }
  const value = JSON.parse(run.stdout) as Record<string, unknown>;
  value.targetId = value.selectedPageKey;
  writeCliResult(io, json, value);
  return 0;
}

async function runLegacyType(argv: readonly string[], io: CliIo): Promise<number> {
  const ref = normalizeRef(argv[1]);
  const text = argv[2];
  if (ref === undefined || text === undefined) throw new Error('type requires ref and text');
  const submit = argv.includes('--submit');
  const passthrough = translateFlags(argv.slice(3).filter((arg) => arg !== '--submit'));
  const first = await runCli(['type', ref, '--text', text, ...passthrough], io);
  if (first !== 0 || !submit) return first;
  return await runCli(['press', ref, 'Enter', ...passthrough], io);
}

async function runLegacyWait(
  args: readonly string[],
  io: CliIo,
  json: boolean,
): Promise<number> {
  const timeoutMs = Number(args.find((arg) => /^\d+$/.test(arg)) ?? '0');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error('wait requires a non-negative millisecond value');
  }
  const config = configFromArgs(args);
  const result = await callRpc<Record<string, unknown>>({
    socketPath: config.socketPath,
    method: 'browser.wait',
    params: { timeoutMs },
    timeoutMs: timeoutMs + 5_000,
    maxLineBytes: config.rpcMaxLineBytes,
  });
  writeCliResult(io, json, result);
  return 0;
}

function translateClick(argv: readonly string[]): readonly string[] {
  const result = ['click', normalizeRef(argv[1]) ?? ''];
  const rest = argv.slice(2);
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--double') {
      result.push('--click-count', '2');
    } else if (value === '--right') {
      result.push('--button', 'right');
    } else if (value !== undefined) {
      result.push(value);
    }
  }
  return translateFlags(result);
}

function translateSelect(argv: readonly string[]): readonly string[] {
  const ref = normalizeRef(argv[1]);
  const value = argv[2];
  if (ref === undefined || value === undefined) throw new Error('select requires ref and value');
  return translateFlags(['select', ref, '--value', value, ...argv.slice(3)]);
}

function translateFirstRef(argv: readonly string[]): readonly string[] {
  return translateFlags([
    argv[0] ?? '',
    normalizeRef(argv[1]) ?? argv[1] ?? '',
    ...argv.slice(2),
  ]);
}

function translateDrag(argv: readonly string[]): readonly string[] {
  return translateFlags([
    'drag',
    normalizeRef(argv[1]) ?? '',
    normalizeRef(argv[2]) ?? '',
    ...argv.slice(3),
  ]);
}

function translateScroll(argv: readonly string[]): readonly string[] {
  const direction = argv[1] ?? 'down';
  const amountIndex = argv.indexOf('--amount');
  const amount = Number(amountIndex >= 0 ? argv[amountIndex + 1] : 700);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('scroll amount must be non-negative');
  const [deltaX, deltaY] = direction === 'up'
    ? [0, -amount]
    : direction === 'left'
      ? [-amount, 0]
      : direction === 'right'
        ? [amount, 0]
        : [0, amount];
  return translateFlags([
    'scroll',
    String(deltaX),
    String(deltaY),
    ...argv.slice(2).filter((_value, index) => index !== amountIndex - 2 && index !== amountIndex - 1),
  ]);
}

function translateText(argv: readonly string[]): readonly string[] {
  const formatIndex = argv.indexOf('--format');
  const format = formatIndex >= 0 ? argv[formatIndex + 1] : 'text';
  const rest = argv.filter((_value, index) => index !== formatIndex && index !== formatIndex + 1);
  return translateFlags([format === 'html' ? 'get-dom' : 'text', ...rest.slice(1)]);
}

function translateFlags(argv: readonly string[]): readonly string[] {
  return argv
    .filter((arg) => !['--headed', '--headless', '--no-activate', '--force'].includes(arg) || arg === '--force')
    .map((arg) => (/^e\d+$/.test(arg) ? `@${arg}` : arg));
}

function globalArgs(argv: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--state-dir' || value === '--socket') {
      const next = argv[index + 1];
      if (next !== undefined) result.push(value, next);
      index += 1;
    } else if (value === '--json') {
      result.push(value);
    }
  }
  return result;
}

function stripFlag(argv: readonly string[], flag: string): readonly string[] {
  return argv.filter((value) => value !== flag);
}

function normalizeRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^e\d+$/.test(value)) return `@${value}`;
  return value;
}

function legacyRef(value: string): string {
  return value.startsWith('@') ? value.slice(1) : value;
}

function configFromArgs(argv: readonly string[]): SessionPlaneConfig {
  const stateDir = optionValue(argv, '--state-dir');
  const socketPath = optionValue(argv, '--socket');
  return resolveConfig({
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(socketPath === undefined ? {} : { socketPath }),
  });
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

async function tryHealth(
  config: SessionPlaneConfig,
): Promise<Record<string, unknown> | null> {
  try {
    return await callRpc<Record<string, unknown>>({
      socketPath: config.socketPath,
      method: 'system.health',
      params: {},
      timeoutMs: 500,
      maxLineBytes: config.rpcMaxLineBytes,
    });
  } catch {
    return null;
  }
}

async function requireHealth(config: SessionPlaneConfig): Promise<Record<string, unknown>> {
  const health = await tryHealth(config);
  if (health === null) throw new Error('SessionPlane core is unavailable');
  return health;
}

async function captureCli(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const code = await runCli(argv, { stdin: Readable.from([]), stdout, stderr });
  return { code, stdout: stdout.value.trim(), stderr: stderr.value.trim() };
}

class CaptureWritable extends Writable {
  value = '';

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

function writeCompatibilityUnsupported(
  io: CliIo,
  json: boolean,
  command: string,
  capabilityId: string,
  status: string,
): number {
  const error = {
    requestOk: false,
    errorCode: 'compatibility.unsupported',
    message: `agbrowse command is not implemented by SessionPlane yet: ${command}`,
    details: { command, capabilityId, status },
  };
  io.stderr.write(
    json
      ? `${JSON.stringify(error)}\n`
      : `${error.errorCode}: ${error.message}\n${JSON.stringify(error.details, null, 2)}\n`,
  );
  return 2;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
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
