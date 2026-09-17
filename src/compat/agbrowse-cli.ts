import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

import { runCli } from '../cli/main.ts';
import { callRpc, RpcClientError } from '../cli/client.ts';
import { writeCliError, writeCliResult, type CliIo } from '../cli/format.ts';
import {
  resolveConfig,
  SESSIONPLANE_VERSION,
  type SessionPlaneConfig,
} from '../config.ts';
import { ContextPackageService } from '../context/context-package.ts';
import {
  capabilityForLegacyCommand,
  loadAgbrowseManifest,
} from './agbrowse-manifest.ts';
import { renderLegacyWebAiPrompt } from './web-ai-prompt.ts';

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
  if (isHelpToken(command) || (command !== 'web-ai' && argv.slice(1).some(isHelpToken))) {
    io.stdout.write(`${agbrowseCompatibilityHelp()}\n`);
    return 0;
  }
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
      case 'skills':
        return await runCli(['skills', ...argv.slice(1)], io);
      case 'install-skills':
        return await runCli(['skills', 'install', ...argv.slice(1)], io);
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
  if (isHelpToken(action) || argv.slice(1).some(isHelpToken)) {
    io.stdout.write(`${agbrowseWebAiHelp()}\n`);
    return 0;
  }
  if (action === 'context-dry-run' || action === 'context-render') {
    return await runCli(
      [
        'context',
        action === 'context-render' ? 'render' : 'dry-run',
        ...argv.slice(1),
      ],
      io,
    );
  }
  if (action === 'mcp-server') {
    return await runCli(['mcp', ...globalArgs(argv.slice(1))], io);
  }
  if (action === 'work') {
    return writeCompatibilityUnsupported(
      io,
      json,
      'web-ai work',
      'web-ai.work',
      'deferred',
    );
  }
  assertSupportedLegacyWebAiOptions(argv);

  const config = configFromArgs(argv);
  const clientId = optionValue(argv, '--client-id') ??
    process.env.SESSIONPLANE_CLIENT_ID ??
    'agbrowse-cli';
  switch (action) {
    case 'code':
      return await runLegacyCode(argv, config, clientId, io, json);
    case 'code-extract':
      return await runLegacyCodeExtract(argv, config, clientId, io, json);
    case 'project-sources':
      return await runLegacyProjectSources(argv.slice(1), config, clientId, io, json);
    case 'render': {
      const vendor = providerOption(argv);
      const rendered = renderPromptFromArgs(argv, vendor, legacyPromptText(argv));
      writeCliResult(io, json, {
        ok: true,
        status: 'rendered',
        vendor,
        prompt: rendered.composerText,
        ...rendered,
        model: optionValue(argv, '--model') ?? optionValue(argv, '--family') ?? null,
        effort: optionValue(argv, '--effort') ?? optionValue(argv, '--reasoning-effort') ?? null,
        surface: resolveLegacySurface(argv, vendor),
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
      let submitted = await sendWebAi(argv, config, clientId);
      let terminal = await pollWebAi(
        config,
        clientId,
        submitted.sessionId as string,
        numberOption(argv, '--timeout', 1_200) * 1_000,
        Number(submitted.generation),
      );
      const followUps = optionValues(argv, '--follow-up');
      for (const [index, followUp] of followUps.entries()) {
        const baseRequestId = optionValue(argv, '--request-id') ?? randomUUID();
        const followArgs = setOption(
          setOption(
            setOption(removeOption(argv, '--follow-up'), '--prompt', followUp),
            '--session',
            String(submitted.sessionId),
          ),
          '--request-id',
          `${baseRequestId}:follow-up:${index + 1}`,
        );
        submitted = await sendWebAi(followArgs, config, clientId);
        terminal = await pollWebAi(
          config,
          clientId,
          submitted.sessionId as string,
          numberOption(argv, '--timeout', 1_200) * 1_000,
          Number(submitted.generation),
        );
      }
      const outputImage = optionValue(argv, '--output-image');
      const image =
        outputImage === undefined
          ? null
          : await captureLegacyOutputImage(
              config,
              clientId,
              String(terminal.sessionId),
              Number(terminal.generation),
              outputImage,
              argv.includes('--overwrite'),
            );
      writeCliResult(io, json, {
        ...legacyWebAiEnvelope(terminal),
        ...(followUps.length === 0
          ? {}
          : { followUpApplied: true, followUpCount: followUps.length }),
        ...(image === null ? {} : { outputImage: image }),
      });
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

async function runLegacyCode(
  argv: readonly string[],
  config: SessionPlaneConfig,
  clientId: string,
  io: CliIo,
  json: boolean,
): Promise<number> {
  if (providerOption(argv) !== 'chatgpt') {
    throw new Error('web-ai code is ChatGPT-only');
  }
  const basePrompt = legacyPromptText(argv);
  let inlineContext = '';
  const files = [...optionValues(argv, '--file')];
  if (hasLegacyContext(argv)) {
    const contextPackages = new ContextPackageService({ stateDir: config.stateDir });
    const contextFile = optionValue(argv, '--context-file');
    const context = contextPackages.render({
      root: optionValue(argv, '--root') ?? process.cwd(),
      includes: optionValues(argv, '--context-from-files'),
      excludes: optionValues(argv, '--context-exclude'),
      ...(contextFile === undefined ? {} : { contextFile }),
      prompt: '',
      transport: legacyTransport(optionValue(argv, '--context-transport')),
      transform: legacyTransform(optionValue(argv, '--context-transform')),
      maxInputTokens: numberOption(argv, '--max-input', 120_000),
      maxFileBytes: legacyContextMaxFileBytes(argv),
      maxTotalBytes: numberOption(argv, '--max-total-size', 20 * 1024 * 1024),
    });
    if (context.transport === 'inline') inlineContext = context.composerText;
    else if (context.artifactPath !== null) files.push(context.artifactPath);
  }
  if (argv.includes('--inline-only') && files.length > 0) {
    throw new Error('--inline-only cannot be combined with uploaded files or context packages');
  }
  const prompt = renderPromptFromArgs(
    argv,
    'chatgpt',
    basePrompt,
    inlineContext,
  ).composerText;
  const requestId = optionValue(argv, '--request-id') ?? randomUUID();
  const sessionId = await ensureWebAiSession(
    argv,
    config,
    clientId,
    'chatgpt',
    requestId,
  );
  const timeoutSec = sessionDeadlineSeconds(argv, 5_400);
  const result = await callRpc<Record<string, unknown>>({
    socketPath: config.socketPath,
    method: 'code.generate',
    params: {
      clientId,
      requestId: `${requestId}:code`,
      sessionId,
      prompt,
      model: optionValue(argv, '--model') ?? optionValue(argv, '--family') ?? null,
      effort: optionValue(argv, '--effort') ?? optionValue(argv, '--reasoning-effort') ?? null,
      files,
      sessionDeadlineSec: timeoutSec,
      ...(optionValue(argv, '--output-zip') === undefined
        ? {}
        : { outputPath: optionValue(argv, '--output-zip') }),
      ...(optionValue(argv, '--output-dir') === undefined
        ? {}
        : { outputDir: optionValue(argv, '--output-dir') }),
      multiZip: argv.includes('--multi-zip'),
      overwrite: argv.includes('--overwrite'),
    },
    timeoutMs: timeoutSec * 1_000 + config.submissionAckTimeoutMs + 10_000,
    maxLineBytes: config.rpcMaxLineBytes,
  });
  writeCliResult(io, json, legacyWebAiEnvelope(result));
  return 0;
}

async function runLegacyCodeExtract(
  argv: readonly string[],
  config: SessionPlaneConfig,
  clientId: string,
  io: CliIo,
  json: boolean,
): Promise<number> {
  if (providerOption(argv) !== 'chatgpt') {
    throw new Error('web-ai code-extract is ChatGPT-only');
  }
  const sessionId = optionValue(argv, '--session');
  const conversationId = optionValue(argv, '--conversation') ?? optionValue(argv, '--url');
  const result = await callRpc<Record<string, unknown>>({
    socketPath: config.socketPath,
    method: 'code.extract',
    params: {
      clientId,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(optionValue(argv, '--output-zip') === undefined
        ? {}
        : { outputPath: optionValue(argv, '--output-zip') }),
      ...(optionValue(argv, '--output-dir') === undefined
        ? {}
        : { outputDir: optionValue(argv, '--output-dir') }),
      multiZip: argv.includes('--multi-zip'),
      requirePlan: argv.includes('--require-plan'),
      overwrite: argv.includes('--overwrite'),
    },
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, 120_000),
    maxLineBytes: config.rpcMaxLineBytes,
  });
  writeCliResult(io, json, legacyWebAiEnvelope(result));
  return 0;
}

async function runLegacyProjectSources(
  argv: readonly string[],
  config: SessionPlaneConfig,
  clientId: string,
  io: CliIo,
  json: boolean,
): Promise<number> {
  const action = argv[0] ?? 'list';
  if (action !== 'list' && action !== 'add') {
    throw new Error(`Unknown project-sources action: ${action}`);
  }
  const projectUrl = optionValue(argv, '--chatgpt-url') ?? optionValue(argv, '--url');
  if (projectUrl === undefined) {
    throw new Error('--chatgpt-url is required for project-sources');
  }
  const method =
    action === 'list' ? 'chatgpt.projectSources.list' : 'chatgpt.projectSources.add';
  const requestId = optionValue(argv, '--request-id') ?? randomUUID();
  const result = await callRpc<Record<string, unknown>>({
    socketPath: config.socketPath,
    method,
    params:
      action === 'list'
        ? { clientId, projectUrl }
        : {
            clientId,
            requestId,
            projectUrl,
            files: optionValues(argv, '--file'),
            dryRun: optionValue(argv, '--dry-run') !== undefined || argv.includes('--dry-run'),
          },
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, 120_000),
    maxLineBytes: config.rpcMaxLineBytes,
  });
  writeCliResult(io, json, legacyWebAiEnvelope(result));
  return 0;
}

async function sendWebAi(
  argv: readonly string[],
  config: SessionPlaneConfig,
  clientId: string,
): Promise<Record<string, unknown>> {
  const provider = providerOption(argv);
  const basePrompt = legacyPromptText(argv);
  let inlineContext = '';
  const files = [...optionValues(argv, '--file')];
  if (hasLegacyContext(argv)) {
    const contextPackages = new ContextPackageService({ stateDir: config.stateDir });
    const contextFile = optionValue(argv, '--context-file');
    const context = contextPackages.render({
      root: optionValue(argv, '--root') ?? process.cwd(),
      includes: optionValues(argv, '--context-from-files'),
      excludes: optionValues(argv, '--context-exclude'),
      ...(contextFile === undefined ? {} : { contextFile }),
      prompt: '',
      transport: legacyTransport(optionValue(argv, '--context-transport')),
      transform: legacyTransform(optionValue(argv, '--context-transform')),
      maxInputTokens: numberOption(argv, '--max-input', 120_000),
      maxFileBytes: legacyContextMaxFileBytes(argv),
      maxTotalBytes: numberOption(argv, '--max-total-size', 20 * 1024 * 1024),
    });
    if (context.transport === 'inline') inlineContext = context.composerText;
    else if (context.artifactPath !== null) files.push(context.artifactPath);
  }
  if (argv.includes('--inline-only') && files.length > 0) {
    throw new Error('--inline-only cannot be combined with uploaded files or context packages');
  }
  const prompt = renderPromptFromArgs(argv, provider, basePrompt, inlineContext).composerText;
  const requestId = optionValue(argv, '--request-id') ?? randomUUID();
  const sessionId = await ensureWebAiSession(
    argv,
    config,
    clientId,
    provider,
    requestId,
  );
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
      surface: resolveLegacySurface(argv, provider),
      files,
      sessionDeadlineSec: sessionDeadlineSeconds(argv, 1_200),
    },
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, config.submissionAckTimeoutMs + 5_000),
    maxLineBytes: config.rpcMaxLineBytes,
  });
}

async function ensureWebAiSession(
  argv: readonly string[],
  config: SessionPlaneConfig,
  clientId: string,
  provider: 'chatgpt' | 'gemini' | 'grok',
  requestId: string,
): Promise<string> {
  const requested = optionValue(argv, '--session');
  if (requested !== undefined) {
    const existing = await getSession(config, clientId, requested);
    if (existing.provider !== provider) {
      throw new Error(
        `Session ${requested} belongs to ${String(existing.provider)}, not ${provider}`,
      );
    }
    return requested;
  }
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
  return session.sessionId;
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

async function captureLegacyOutputImage(
  config: SessionPlaneConfig,
  clientId: string,
  sessionId: string,
  generation: number,
  outputPath: string,
  overwrite: boolean,
): Promise<Readonly<Record<string, unknown>>> {
  const captured = await callRpc<{
    readonly requestOk: boolean;
    readonly artifacts: ReadonlyArray<{
      readonly artifactId: string;
      readonly artifactKind?: string;
      readonly mediaType?: string | null;
      readonly name?: string;
    }>;
    readonly failures?: ReadonlyArray<Readonly<Record<string, unknown>>>;
  }>({
    socketPath: config.socketPath,
    method: 'artifact.capture',
    params: { clientId, sessionId, generation },
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, 120_000),
    maxLineBytes: config.rpcMaxLineBytes,
  });
  const image = captured.artifacts.find(
    (artifact) =>
      artifact.artifactKind === 'image' ||
      artifact.mediaType?.toLowerCase().startsWith('image/') === true ||
      /\.(?:png|jpe?g|gif|webp|svg)$/i.test(artifact.name ?? ''),
  );
  if (image === undefined) {
    throw new Error(
      captured.failures?.length
        ? `Provider image capture failed: ${JSON.stringify(captured.failures)}`
        : `No generated image artifact was discovered for session ${sessionId} generation ${generation}`,
    );
  }
  const exported = await callRpc<Record<string, unknown>>({
    socketPath: config.socketPath,
    method: 'artifact.export',
    params: {
      clientId,
      artifactId: image.artifactId,
      outputPath,
      overwrite,
    },
    timeoutMs: Math.max(config.rpcRequestTimeoutMs, 120_000),
    maxLineBytes: config.rpcMaxLineBytes,
  });
  return { artifact: image, export: exported };
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

function legacyPromptText(argv: readonly string[]): string {
  const value = optionValue(argv, '--prompt') ?? optionValue(argv, '--question');
  if (value === undefined || value.trim().length === 0) {
    throw new Error('a prompt is required: pass --prompt <text>');
  }
  return value;
}

function renderPromptFromArgs(
  argv: readonly string[],
  vendor: 'chatgpt' | 'gemini' | 'grok',
  prompt: string,
  packagedContext = '',
): ReturnType<typeof renderLegacyWebAiPrompt> {
  const question = optionValue(argv, '--question');
  const system = optionValue(argv, '--system');
  const project = optionValue(argv, '--project');
  const goal = optionValue(argv, '--goal');
  const output = optionValue(argv, '--output');
  const constraints = optionValue(argv, '--constraints');
  const context = [optionValue(argv, '--context'), packagedContext]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
  return renderLegacyWebAiPrompt({
    vendor,
    prompt,
    ...(question === undefined ? {} : { question }),
    ...(system === undefined ? {} : { system }),
    ...(project === undefined ? {} : { project }),
    ...(goal === undefined ? {} : { goal }),
    ...(context === '' ? {} : { context }),
    ...(output === undefined ? {} : { output }),
    ...(constraints === undefined ? {} : { constraints }),
  });
}

function resolveLegacySurface(
  argv: readonly string[],
  vendor: 'chatgpt' | 'gemini' | 'grok',
): string | null {
  const explicit = normalizeLegacyMode(optionValue(argv, '--surface'));
  if (explicit === 'work') {
    throw new Error('ChatGPT Work is intentionally unsupported; SessionPlane uses Chat only');
  }

  const requested: string[] = [];
  const research = optionValue(argv, '--research');
  if (research !== undefined) {
    if (research.trim().toLowerCase() !== 'deep') {
      throw new Error('--research supports only the value deep');
    }
    requested.push('deep-research');
  }
  for (const tool of optionValues(argv, '--tool')) {
    requested.push(normalizeLegacyTool(tool));
  }
  if (argv.includes('--web-search')) requested.push('web-search');

  const tools = [...new Set(requested)];
  if (tools.length > 1) {
    throw new Error(
      `SessionPlane currently supports one explicit Chat tool per generation; received ${tools.join(', ')}`,
    );
  }
  const derived = tools[0] ?? null;
  if (vendor !== 'chatgpt' && derived !== null) {
    throw new Error(`--tool/--research is unsupported for ${vendor}; use that provider's model alias`);
  }
  if (explicit !== null && derived !== null && explicit !== derived) {
    throw new Error(`Conflicting Chat surfaces requested: ${explicit} and ${derived}`);
  }
  if (vendor !== 'chatgpt') {
    if (explicit !== null && explicit !== 'chat') {
      throw new Error(`--surface ${explicit} is unsupported for ${vendor}`);
    }
    return null;
  }
  return explicit ?? derived ?? 'chat';
}

function normalizeLegacyMode(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  if (normalized === '' || normalized === 'normal') return 'chat';
  return normalized;
}

function normalizeLegacyTool(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  switch (normalized) {
    case 'image':
    case 'create-image':
      return 'create-image';
    case 'research':
    case 'deep':
    case 'deep-research':
      return 'deep-research';
    case 'web':
    case 'search':
    case 'web-search':
      return 'web-search';
    default:
      if (normalized === '') throw new Error('--tool requires a nonempty value');
      return normalized;
  }
}

function assertSupportedLegacyWebAiOptions(argv: readonly string[]): void {
  const unsupported = [
    '--plugin',
    '--auto-tools',
    '--allow-copy-markdown-fallback',
    '--require-file-artifacts',
    '--require-source-audit',
    '--source-audit-ratio',
    '--source-audit-scope',
    '--source-audit-date',
    '--trace-dir',
    '--policy',
    '--unsafe-allow',
    '--normalize-surface',
    '--context-refresh',
    '--files-report',
    '--max-upload-file-size',
    '--attachment-upload-timeout-ms',
    '--power',
    '--speed',
  ] as const;
  for (const option of unsupported) {
    if (hasOption(argv, option)) {
      throw new Error(`${option} is not supported by the SessionPlane compatibility runtime`);
    }
  }

  const action = argv[0] ?? 'status';
  if (action !== 'query' && hasOption(argv, '--follow-up')) {
    throw new Error('--follow-up is supported only by web-ai query');
  }
  if (
    !['render', 'send', 'query', 'code'].includes(action) &&
    (hasOption(argv, '--tool') || hasOption(argv, '--research') || hasOption(argv, '--web-search'))
  ) {
    throw new Error(`Chat tool selection is not valid for web-ai ${action}`);
  }
  if (
    ['render', 'send', 'query', 'code'].includes(action) &&
    (hasOption(argv, '--url') || hasOption(argv, '--conversation'))
  ) {
    throw new Error(`web-ai ${action} requires --session for continuation; URL-based mutation is unsupported`);
  }
}

function hasOption(argv: readonly string[], name: string): boolean {
  return argv.some((value) => value === name || value.startsWith(`${name}=`));
}

function isHelpToken(value: string): boolean {
  return value === '--help' || value === '-h' || value === 'help';
}

function agbrowseCompatibilityHelp(): string {
  return `SessionPlane ${SESSIONPLANE_VERSION} — agbrowse compatibility

Usage:
  agbrowse start [--headed|--headless] [--json]
  agbrowse status|stop|reset
  agbrowse tabs|new-tab|tab-switch|tab-close|tab-cleanup
  agbrowse navigate|snapshot|click|type|press|hover|select|upload
  agbrowse screenshot|text|get-dom|console|network|evaluate
  agbrowse fetch|extract|search|research
  agbrowse web-ai <command> [options]
  agbrowse skills|install-skills

This command is the SessionPlane compatibility alias. It uses the same
long-running core, persistent Chrome profile, PageRegistry, SQLite state, and
session actors as sessplane. ChatGPT provider automation is Chat-only; Work,
Power, and speed controls are intentionally unsupported.

Run "agbrowse web-ai --help" for provider commands or "sessplane --help" for
the complete canonical command surface.`;
}

function agbrowseWebAiHelp(): string {
  return `SessionPlane ${SESSIONPLANE_VERSION} — agbrowse web-ai compatibility

Usage:
  agbrowse web-ai render --vendor chatgpt|gemini|grok --prompt TEXT
  agbrowse web-ai send|query --vendor PROVIDER --prompt TEXT [--session ID]
  agbrowse web-ai poll|watch|status|snapshot|stop --session ID
  agbrowse web-ai sessions list|show|resume|reattach|doctor
  agbrowse web-ai project-sources list|add --chatgpt-url URL
  agbrowse web-ai code --vendor chatgpt --prompt TEXT --output-zip PATH
  agbrowse web-ai code-extract --vendor chatgpt --session ID
  agbrowse web-ai context-dry-run|context-render [context options]

Common options:
  --model MODEL --effort EFFORT --surface chat|deep-research|create-image
  --file PATH --context-from-files GLOB --context-transport inline|upload
  --timeout SEC --deadline ISO_TIME --request-id ID --json

ChatGPT is Chat-only. "agbrowse web-ai work", --power, --speed, and an active
Work composer fail before prompt fill or submit.`;
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

function legacyContextMaxFileBytes(argv: readonly string[]): number {
  return hasOption(argv, '--max-context-file-size')
    ? numberOption(argv, '--max-context-file-size', 2 * 1024 * 1024)
    : numberOption(argv, '--max-file-size', 2 * 1024 * 1024);
}

function sessionDeadlineSeconds(argv: readonly string[], fallback: number): number {
  const explicit = optionValue(argv, '--deadline');
  if (explicit === undefined) return numberOption(argv, '--timeout', fallback);
  const deadline = Date.parse(explicit);
  if (!Number.isFinite(deadline)) throw new Error('--deadline must be a valid ISO date');
  const seconds = Math.ceil((deadline - Date.now()) / 1_000);
  if (seconds < 1) throw new Error('--deadline must be in the future');
  if (seconds > 86_400) throw new Error('--deadline cannot be more than 24 hours away');
  return seconds;
}

function hasLegacyContext(argv: readonly string[]): boolean {
  return (
    optionValues(argv, '--context-from-files').length > 0 ||
    optionValues(argv, '--context-exclude').length > 0 ||
    optionValue(argv, '--context-file') !== undefined
  );
}

function legacyTransport(value: string | undefined): 'inline' | 'upload' {
  const resolved = value ?? 'upload';
  if (resolved !== 'inline' && resolved !== 'upload') {
    throw new Error('--context-transport must be inline or upload');
  }
  return resolved;
}

function legacyTransform(value: string | undefined): 'raw' | 'repomix' {
  const resolved = value ?? 'raw';
  if (resolved !== 'raw' && resolved !== 'repomix') {
    throw new Error('--context-transform must be raw or repomix');
  }
  return resolved;
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
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === name) return argv[index + 1];
    if (value?.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return undefined;
}

function removeOption(argv: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === name) {
      index += 1;
      continue;
    }
    if (value?.startsWith(`${name}=`)) continue;
    if (value !== undefined) result.push(value);
  }
  return result;
}

function setOption(argv: readonly string[], name: string, value: string): string[] {
  return [...removeOption(argv, name), name, value];
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
