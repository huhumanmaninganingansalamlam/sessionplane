import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

import {
  findHostBrowser,
  type BrowserPreference,
} from '../browser/browser-health.ts';
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
    capability.status !== 'implemented' &&
    !['web-ai'].includes(command)
  ) {
    return writeCompatibilityUnsupported(io, json, command, capability.id, capability.status);
  }
  if (command === 'fetch' && hasDeferredLegacyFetchOption(argv.slice(1))) {
    return writeCompatibilityUnsupported(
      io,
      json,
      'fetch',
      'fetch.experimental-escalation',
      'deferred',
    );
  }

  try {
    assertSupportedLegacyBrowserOptions(command, argv.slice(1));
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
        return await runTabSelect(argv.slice(1), io, json, false);
      case 'select-tab':
        return await runTabSelect(argv.slice(1), io, json, true);
      case 'new-tab':
        return await runTransformedBrowserRead('new-tab', argv.slice(1), io, json);
      case 'snapshot':
        return await runTransformedBrowserRead(
          'snapshot',
          translateLegacySnapshotArgs(argv.slice(1)),
          io,
          json,
        );
      case 'observe-bundle':
        return await runTransformedBrowserRead(
          'observe-bundle',
          translateLegacyObserveBundleArgs(argv.slice(1)),
          io,
          json,
        );
      case 'console':
        return await runCli(['console', ...translateLegacyConsoleArgs(argv.slice(1))], io);
      case 'click':
        return await runCli(translateClick(argv), io);
      case 'type':
        return await runLegacyType(argv, io);
      case 'select':
        return await runCli(translateSelect(argv), io);
      case 'hover':
      case 'check':
      case 'uncheck':
        return await runCli(translateFirstRef(argv), io);
      case 'wait-for':
        return await runCli(translateLegacyTimeoutArgs(translateFirstRef(argv)), io);
      case 'wait-for-selector':
        return await runCli([
          'wait-for-selector',
          ...translateLegacyTimeoutArgs(argv.slice(1)),
        ], io);
      case 'wait-for-text':
        return await runCli(translateLegacyWaitForTextArgs(argv), io);
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
  if (action === 'eval' || action === 'claim-audit') {
    return writeCompatibilityUnsupported(
      io,
      json,
      `web-ai ${action}`,
      'web-ai.release-audit',
      'deferred',
    );
  }
  if (action === 'watch') {
    return writeCompatibilityUnsupported(
      io,
      json,
      'web-ai watch',
      'web-ai.watch',
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
      const prepared = prepareLegacyContext(argv, config);
      const rendered = renderPromptFromArgs(
        argv,
        vendor,
        legacyPromptText(argv),
        prepared.inlineContext,
      );
      writeCliResult(io, json, {
        ok: true,
        status: 'rendered',
        vendor,
        prompt: rendered.composerText,
        ...rendered,
        model: optionValue(argv, '--model') ?? optionValue(argv, '--family') ?? null,
        effort: optionValue(argv, '--effort') ?? optionValue(argv, '--reasoning-effort') ?? null,
        surface: resolveLegacySurface(argv, vendor),
        files: prepared.files,
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
    case 'poll': {
      const sessionId = requireArgOption(argv, '--session');
      const current = await getSession(config, clientId, sessionId);
      const terminal = await pollWebAi(
        config,
        clientId,
        sessionId,
        numberOption(argv, '--timeout', 30) * 1_000,
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
  const prepared = prepareLegacyContext(argv, config);
  const { inlineContext, files } = prepared;
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
  const resolvedTarget = await resolveWebAiSendTarget(argv, config, clientId);
  const provider = resolvedTarget.provider;
  if (
    provider === 'grok' &&
    hasLegacyContextPackaging(argv) &&
    !argv.includes('--allow-grok-context-pack')
  ) {
    throw new Error(
      'Grok context-pack is disabled by default; pass --allow-grok-context-pack to opt in',
    );
  }
  const basePrompt = legacyPromptText(argv);
  const prepared = prepareLegacyContext(argv, config);
  const { inlineContext, files } = prepared;
  if (argv.includes('--inline-only') && files.length > 0) {
    throw new Error('--inline-only cannot be combined with uploaded files or context packages');
  }
  const prompt = renderPromptFromArgs(argv, provider, basePrompt, inlineContext).composerText;
  const requestId = optionValue(argv, '--request-id') ?? randomUUID();
  const sessionId =
    resolvedTarget.sessionId ??
    await ensureWebAiSession(argv, config, clientId, provider, requestId);
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

async function resolveWebAiSendTarget(
  argv: readonly string[],
  config: SessionPlaneConfig,
  clientId: string,
): Promise<{
  readonly provider: 'chatgpt' | 'gemini' | 'grok';
  readonly sessionId?: string;
}> {
  const requested = optionValue(argv, '--session');
  if (requested === undefined) return { provider: providerOption(argv) };

  const existing = await getSession(config, clientId, requested);
  const provider = storedProvider(existing.provider);
  const explicitProvider = optionValue(argv, '--vendor');
  if (explicitProvider !== undefined) {
    const validated = providerOption(['--vendor', explicitProvider]);
    if (validated !== provider) {
      throw new Error(
        `Session ${requested} belongs to ${provider}, not ${validated}`,
      );
    }
  }
  return { provider, sessionId: requested };
}

function storedProvider(value: unknown): 'chatgpt' | 'gemini' | 'grok' {
  if (value === 'chatgpt' || value === 'gemini' || value === 'grok') return value;
  throw new Error(`Unsupported provider in stored session: ${String(value)}`);
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
    const vendor = optionValue(argv, '--vendor');
    if (vendor !== undefined && !['chatgpt', 'gemini', 'grok'].includes(vendor)) {
      throw new Error(`Unsupported provider: ${vendor}`);
    }
    const status = optionValue(argv, '--status');
    const limit = optionalPositiveIntegerOption(argv, '--limit');
    const sessions = (Array.isArray(result.sessions) ? result.sessions : [])
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null,
      )
      .map(legacySessionListRow)
      .filter((entry) => vendor === undefined || entry.provider === vendor)
      .filter((entry) => status === undefined || entry.status === status);
    writeCliResult(io, json, {
      ...result,
      ok: true,
      status: 'list',
      sessions: limit === undefined ? sessions : sessions.slice(-limit),
    });
    return 0;
  }
  const sessionId = optionValue(argv, '--session') ?? argv[1];
  if (action === 'show') {
    if (sessionId === undefined) throw new Error('web-ai sessions show requires session id');
    const result = await getSession(config, clientId, sessionId);
    writeCliResult(io, json, {
      ok: result.requestOk !== false,
      requestOk: result.requestOk !== false,
      status: 'show',
      session: legacySessionListRow(result),
    });
    return 0;
  }
  if (action === 'resume') {
    if (sessionId === undefined) throw new Error('web-ai sessions resume requires session id');
    const current = await getSession(config, clientId, sessionId);
    const generation = Number(current.generation);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error(`Session ${sessionId} has invalid generation`);
    }
    const result = await pollWebAi(
      config,
      clientId,
      sessionId,
      numberOption(argv, '--timeout', 1_200) * 1_000,
      generation,
    );
    writeCliResult(io, json, legacyWebAiEnvelope(result));
    return 0;
  }
  if (action === 'doctor') {
    if (sessionId === undefined) throw new Error('web-ai sessions doctor requires session id');
    const result = await buildWebAiSessionDoctor(config, clientId, sessionId);
    writeCliResult(io, json, result);
    return 0;
  }
  if (action === 'reattach') {
    return writeCompatibilityUnsupported(
      io,
      json,
      'web-ai sessions reattach',
      'web-ai.manual-reattach',
      'deferred',
    );
  }
  if (action === 'prune') {
    return writeCompatibilityUnsupported(
      io,
      json,
      'web-ai sessions prune',
      'web-ai.session-maintenance',
      'deferred',
    );
  }
  return writeCompatibilityUnsupported(io, json, `web-ai sessions ${action}`, 'web-ai.chatgpt', 'foundation');
}

async function buildWebAiSessionDoctor(
  config: SessionPlaneConfig,
  clientId: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const [session, health, tabsResult] = await Promise.all([
    getSession(config, clientId, sessionId),
    callRpc<Record<string, unknown>>({
      socketPath: config.socketPath,
      method: 'system.health',
      params: {},
      timeoutMs: config.rpcRequestTimeoutMs,
      maxLineBytes: config.rpcMaxLineBytes,
    }),
    callRpc<Record<string, unknown>>({
      socketPath: config.socketPath,
      method: 'browser.tabs',
      params: {},
      timeoutMs: config.rpcRequestTimeoutMs,
      maxLineBytes: config.rpcMaxLineBytes,
    }),
  ]);
  const tabs = Array.isArray(tabsResult.tabs)
    ? tabsResult.tabs.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null,
      )
    : [];
  const pageKey = typeof session.pageKey === 'string' ? session.pageKey : null;
  const page = pageKey === null
    ? undefined
    : tabs.find((entry) => entry.pageKey === pageKey);
  const issues: string[] = [];
  const bindingRequired = session.terminal !== true;
  if (bindingRequired) {
    if (pageKey === null) {
      issues.push('session.page-key-missing');
    } else if (page === undefined) {
      issues.push('session.page-not-registered');
    } else {
      if (page.sessionId !== session.sessionId) issues.push('session.page-session-mismatch');
      if (Number(page.generation) !== Number(session.generation)) {
        issues.push('session.page-generation-mismatch');
      }
      if ((page.conversationId ?? null) !== (session.conversationId ?? null)) {
        issues.push('session.page-conversation-mismatch');
      }
    }
  }
  const browser =
    typeof health.browser === 'object' && health.browser !== null
      ? health.browser as Record<string, unknown>
      : null;
  if (bindingRequired && browser?.state !== 'ready') issues.push('browser.not-ready');
  if (typeof session.errorCode === 'string' && session.errorCode.length > 0) {
    issues.push(`session.error:${session.errorCode}`);
  }
  const summary =
    issues.length > 0
      ? 'issues detected'
      : bindingRequired
        ? 'exact binding healthy'
        : 'terminal session healthy; live binding not required';
  return {
    ok: true,
    requestOk: true,
    status: 'session-doctor',
    sessionId,
    summary,
    bindingRequired,
    recoveryMode: 'automatic-on-core-and-browser-start',
    issues,
    session,
    page: page ?? null,
    browser,
    metrics:
      typeof health.metrics === 'object' && health.metrics !== null
        ? health.metrics
        : null,
  };
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
  const sessionLike =
    typeof value.sessionState === 'string' || typeof value.providerState === 'string';
  const status = sessionLike
    ? legacySessionStatus(value)
    : typeof value.status === 'string'
      ? value.status
      : 'ok';
  return {
    ...value,
    ok: value.requestOk !== false,
    status,
  };
}

function legacySessionListRow(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    vendor: value.provider,
    status: legacySessionStatus(value),
    targetId: value.pageKey ?? null,
  };
}

function legacySessionStatus(value: Record<string, unknown>): string {
  const sessionState = typeof value.sessionState === 'string' ? value.sessionState : '';
  const providerState = typeof value.providerState === 'string' ? value.providerState : '';
  if (sessionState === 'complete' || providerState === 'complete') return 'complete';
  if (providerState === 'stopped' || sessionState === 'cancelled') return 'stopped';
  if (providerState === 'blocked') return 'blocked';
  if (providerState === 'error' || sessionState === 'failed') return 'error';
  if (sessionState === 'observing') return 'polling';
  if (['submitting', 'submitted', 'ready', 'created'].includes(sessionState)) return 'sent';
  return sessionState || providerState || 'unknown';
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
    '--navigate',
    '--diagnostics',
    '--archive',
    '--thinking-time',
    '--probe',
    '--interval',
    '--poll-timeout',
    '--max-iterations',
    '--once',
    '--interactive',
    '--compact',
    '--snapshot',
    '--max-depth',
    '--root-selector',
    '--full',
    '--cache-metrics',
    '--reuse-tab',
    '--control-summary',
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
  if (action !== 'query' && hasOption(argv, '--output-image')) {
    throw new Error('--output-image is supported only by web-ai query');
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
  agbrowse start [--headed|--headless] [--browser NAME]
                 [--chrome-path PATH|--browser-executable PATH] [--json]
  agbrowse status|stop|reset
  agbrowse browser-list [--browser NAME] [--browser-executable PATH]

Browser compatibility:
  agbrowse tabs|new-tab [URL] [--no-activate]|tab-switch|tab-close|tab-cleanup
  agbrowse navigate|snapshot|click|type|press|hover|select|upload
  agbrowse screenshot|text|get-dom|console|network|evaluate
  agbrowse fetch|extract|search|research
  agbrowse web-ai <command> [options]
  agbrowse skills|install-skills

Compatibility notes:
  snapshot defaults to all accessibility nodes; pass --interactive to restrict it.
  new-tab --no-activate preserves SessionPlane's logical selected-page target.
  get-dom --selector and console --limit retain the legacy read semantics.
  advanced fetch escalation options fail closed instead of changing meaning.
  legacy tab-cleanup policy/dry-run flags fail closed; plain tab-cleanup uses
  SessionPlane ownership-aware cleanup. start --port is unsupported because
  SessionPlane reserves its own private loopback CDP port.

Legacy-only surfaces that violate SessionPlane ownership or are intentionally
out of scope fail closed with compatibility.unsupported (for example connect,
action-memory, and runway).

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
  agbrowse web-ai send|query [--vendor PROVIDER] --prompt TEXT [--session ID]
  agbrowse web-ai poll|status|snapshot|stop --session ID
  agbrowse web-ai sessions list [--vendor PROVIDER] [--status STATUS] [--limit N]
  agbrowse web-ai sessions show|resume|doctor SESSION_ID
  agbrowse web-ai project-sources list|add --chatgpt-url URL
  agbrowse web-ai code --vendor chatgpt --prompt TEXT --output-zip PATH
  agbrowse web-ai code-extract --vendor chatgpt --session ID
  agbrowse web-ai context-dry-run|context-render [context options]

Common options:
  --model MODEL --effort EFFORT --surface chat|deep-research|create-image
  --file PATH --context-from-files GLOB --context-transport inline|upload
  --timeout SEC --deadline ISO_TIME --request-id ID --json

Session semantics:
  With --session and no --vendor, the stored session provider is inferred.
  An explicit conflicting --vendor fails before submission.
  render and send/query share the same context preparation path.
  Grok context-pack input requires explicit --allow-grok-context-pack opt-in.
  legacy web-ai watch is a streaming watcher with lifecycle/lock/event semantics
  that SessionPlane does not approximate; it fails closed as a deferred surface.

ChatGPT is Chat-only. "agbrowse web-ai work", --power, --speed, and an active
Work composer fail before prompt fill or submit. Manual sessions reattach is
not exposed: SessionPlane restores exact conversation bindings automatically on
core/browser start. sessions prune, eval, and claim-audit also fail closed.`;
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

function optionalPositiveIntegerOption(
  argv: readonly string[],
  name: string,
): number | undefined {
  const raw = optionValue(argv, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
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

function hasLegacyContextPackaging(argv: readonly string[]): boolean {
  return (
    optionValues(argv, '--context-from-files').length > 0 ||
    optionValue(argv, '--context-file') !== undefined ||
    optionValue(argv, '--context-transform') === 'repomix'
  );
}

function prepareLegacyContext(
  argv: readonly string[],
  config: SessionPlaneConfig,
): { readonly inlineContext: string; readonly files: readonly string[] } {
  let inlineContext = '';
  const files = [...optionValues(argv, '--file')];
  if (!hasLegacyContext(argv)) return { inlineContext, files };

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
  return { inlineContext, files };
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

function assertCompatibilityCoreBrowserSelection(
  config: SessionPlaneConfig,
  health: Readonly<Record<string, unknown>>,
): void {
  if (config.browserPreference === 'auto' && config.browserExecutable === null) return;

  const expected = findHostBrowser({
    preference: config.browserPreference,
    ...(config.browserExecutable === null
      ? {}
      : { executablePath: config.browserExecutable }),
  });
  if (expected === null) throw new Error('The requested host browser is unavailable');

  const current = (health.browser as {
    readonly chrome?: {
      readonly executable?: string;
      readonly product?: string;
    } | null;
  } | undefined)?.chrome;
  const matches =
    current !== null &&
    current !== undefined &&
    (config.browserExecutable !== null
      ? current.executable === expected.executable
      : current.product === expected.product);
  if (!matches) {
    throw new Error(
      `The running core owns ${current?.product ?? 'an unknown browser'}; ` +
        `stop it and restart with --browser ${config.browserPreference}`,
    );
  }
}

async function startCompatibilityCore(
  argv: readonly string[],
  io: CliIo,
  json: boolean,
): Promise<number> {
  const normalizedArgv = normalizeLegacyStartArgs(argv);
  const config = configFromArgs(normalizedArgv);
  let health = await tryHealth(config);
  if (health === null) {
    const cliPath = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', cliPath, 'serve', ...globalArgs(normalizedArgv)],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          SESSIONPLANE_LOG_LEVEL: process.env.SESSIONPLANE_LOG_LEVEL ?? 'warn',
          ...(normalizedArgv.includes('--headless') ? { SESSIONPLANE_BROWSER_HEADLESS: '1' } : {}),
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

  assertCompatibilityCoreBrowserSelection(config, health);
  assertCompatibilityBrowserMode(health, normalizedArgv);
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
  assertCompatibilityBrowserMode(health, normalizedArgv);
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

function assertSupportedLegacyBrowserOptions(
  command: string,
  argv: readonly string[],
): void {
  const unsupported: readonly string[] = command === 'tab-cleanup'
    ? [
        '--idle-after',
        '--max-tabs',
        '--include-untracked',
        '--provider',
        '--keep-provider-tabs',
        '--force',
        '--dry-run',
      ]
    : command === 'tab-switch' || command === 'select-tab'
      ? ['--force']
      : command === 'console'
        ? ['--duration', '--expression', '--reload']
        : command === 'network'
          ? ['--duration', '--filter', '--live-only', '--reload']
          : command === 'navigate'
            ? ['--timeout', '--wait-until']
            : [];
  for (const option of unsupported) {
    if (hasOption(argv, option)) {
      throw new Error(
        `${option} is not supported by the SessionPlane compatibility runtime; ` +
          `${command} only accepts options with exact SessionPlane semantics`,
      );
    }
  }
}

function hasDeferredLegacyFetchOption(argv: readonly string[]): boolean {
  return [
    '--trace',
    '--browser',
    '--browser-session',
    '--identity',
    '--no-browser',
    '--selector',
    '--no-public-endpoints',
    '--allow-third-party-reader',
    '--allow-archive',
  ].some((option) => hasOption(argv, option));
}

function normalizeLegacyStartArgs(argv: readonly string[]): readonly string[] {
  if (argv.includes('--headless') && argv.includes('--headed')) {
    throw new Error('--headless and --headed are mutually exclusive');
  }
  for (const option of [
    '--port',
    '--heavy-site-compat',
    '--keep-bg-networking',
    '--profile',
  ] as const) {
    if (hasOption(argv, option)) {
      throw new Error(
        `${option} is not supported by the SessionPlane compatibility runtime; ` +
          'SessionPlane owns a dedicated profile and reserves a private loopback CDP port',
      );
    }
  }

  const chromePath = optionValue(argv, '--chrome-path');
  const browserExecutable = optionValue(argv, '--browser-executable');
  if (
    chromePath !== undefined &&
    browserExecutable !== undefined &&
    chromePath !== browserExecutable
  ) {
    throw new Error('--chrome-path and --browser-executable must refer to the same executable');
  }
  if (chromePath === undefined) return argv;

  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--chrome-path') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--chrome-path requires a value');
      }
      result.push('--browser-executable', next);
      index += 1;
    } else if (value?.startsWith('--chrome-path=')) {
      result.push('--browser-executable', value.slice('--chrome-path='.length));
    } else if (value !== undefined) {
      result.push(value);
    }
  }
  return result;
}

function assertCompatibilityBrowserMode(
  health: Readonly<Record<string, unknown>>,
  argv: readonly string[],
): void {
  const requested = argv.includes('--headless')
    ? true
    : argv.includes('--headed')
      ? false
      : null;
  if (requested === null) return;
  const browser =
    typeof health.browser === 'object' && health.browser !== null
      ? (health.browser as { readonly headless?: unknown })
      : null;
  if (typeof browser?.headless === 'boolean' && browser.headless !== requested) {
    throw new Error(
      `The running SessionPlane browser is ${browser.headless ? 'headless' : 'headed'}; ` +
        `agbrowse start requested ${requested ? 'headless' : 'headed'} mode`,
    );
  }
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
  if (command === 'observe-bundle' && Array.isArray(value.refs)) {
    value.refs = value.refs.map((entry) => {
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
    const tabs = value.tabs.map((entry, index) => {
      const tab = entry as Record<string, unknown>;
      return { index: index + 1, targetId: tab.pageKey, ...tab };
    });
    if (command === 'tabs') {
      writeCliResult(io, json, tabs);
      return 0;
    }
    const selectedPageKey =
      typeof value.selectedPageKey === 'string' ? value.selectedPageKey : null;
    const selected = tabs.find((tab) => tab.targetId === selectedPageKey);
    if (selected === undefined) {
      writeCliResult(io, json, { targetId: null });
      return 0;
    }
    const { index: _index, ...active } = selected;
    writeCliResult(io, json, active);
    return 0;
  }
  if (command === 'new-tab') {
    const binding =
      typeof value.binding === 'object' && value.binding !== null
        ? value.binding as { readonly pageKey?: unknown }
        : null;
    const createdPageKey =
      typeof value.createdPageKey === 'string'
        ? value.createdPageKey
        : typeof binding?.pageKey === 'string'
          ? binding.pageKey
          : null;
    if (createdPageKey !== null) value.targetId = createdPageKey;
    value.status = 'created';
  }
  writeCliResult(io, json, value);
  return 0;
}

async function runTabSelect(
  args: readonly string[],
  io: CliIo,
  json: boolean,
  selectAlias: boolean,
): Promise<number> {
  const target = args.find((arg) => !arg.startsWith('--'));
  if (target === undefined) throw new Error('tab target is required');
  let pageKey = target;
  if (/^\d+$/.test(target)) {
    const legacyIndex = Number(target);
    if (legacyIndex < 1) throw new Error(`Unknown tab index: ${target}`);
    const tabs = await captureCli(['tabs', ...globalArgs(args), '--json']);
    if (tabs.code !== 0) throw new Error(tabs.stderr);
    const parsed = JSON.parse(tabs.stdout) as {
      tabs: ReadonlyArray<{ pageKey: string }>;
    };
    const selected = parsed.tabs[legacyIndex - 1];
    if (selected === undefined) throw new Error(`Unknown tab index: ${target}`);
    pageKey = selected.pageKey;
  }
  const run = await captureCli(['select-tab', pageKey, ...globalArgs(args), '--json']);
  if (run.code !== 0) {
    io.stderr.write(`${run.stderr}\n`);
    return run.code;
  }
  const value = JSON.parse(run.stdout) as Record<string, unknown>;
  const binding =
    typeof value.binding === 'object' && value.binding !== null
      ? value.binding as { readonly title?: unknown }
      : null;
  value.ok = value.requestOk !== false;
  value.tab = /^\d+$/.test(target) ? Number(target) : null;
  value.targetId = value.selectedPageKey;
  if (typeof binding?.title === 'string') value.title = binding.title;
  if (selectAlias) value.alias = 'select-tab';
  writeCliResult(io, json, value);
  return 0;
}

async function runLegacyType(argv: readonly string[], io: CliIo): Promise<number> {
  const ref = normalizeRef(argv[1]);
  if (ref === undefined) throw new Error('type requires ref and text');
  const valueOptions = new Set([
    '--state-dir',
    '--socket',
    '--browser',
    '--browser-executable',
    '--page',
    '--snapshot-id',
  ]);
  const textParts: string[] = [];
  const passthrough: string[] = [];
  let submit = false;
  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (value === '--submit') {
      submit = true;
      continue;
    }
    if (valueOptions.has(value)) {
      const next = args[index + 1];
      if (next === undefined) throw new Error(`${value} requires a value`);
      passthrough.push(value, next);
      index += 1;
      continue;
    }
    if (value.startsWith('--')) {
      passthrough.push(value);
      continue;
    }
    textParts.push(value);
  }
  if (textParts.length === 0) throw new Error('type requires ref and text');
  const text = textParts.join(' ');
  const translatedPassthrough = translateFlags(passthrough);
  const first = await runCli(['type', ref, '--text', text, ...translatedPassthrough], io);
  if (first !== 0 || !submit) return first;
  return await runCli(['press', ref, 'Enter', ...translatedPassthrough], io);
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

function translateLegacySnapshotArgs(argv: readonly string[]): readonly string[] {
  const interactive = argv.includes('--interactive');
  const translated = argv.filter((value) => value !== '--interactive');
  return interactive || translated.includes('--all-nodes')
    ? translated
    : [...translated, '--all-nodes'];
}

function translateLegacyObserveBundleArgs(argv: readonly string[]): readonly string[] {
  return argv.map((value) => {
    if (value === '--max-text-chars') return '--max-chars';
    if (value.startsWith('--max-text-chars=')) {
      return `--max-chars=${value.slice('--max-text-chars='.length)}`;
    }
    return value;
  });
}

function translateLegacyConsoleArgs(argv: readonly string[]): readonly string[] {
  const translated = translateFlags(argv);
  return hasOption(translated, '--limit') ? translated : [...translated, '--limit', '50'];
}

function translateLegacyTimeoutArgs(argv: readonly string[]): readonly string[] {
  return translateFlags(argv).map((value) => {
    if (value === '--timeout') return '--timeout-ms';
    if (value.startsWith('--timeout=')) {
      return `--timeout-ms=${value.slice('--timeout='.length)}`;
    }
    return value;
  });
}

function translateLegacyWaitForTextArgs(argv: readonly string[]): readonly string[] {
  const args = argv.slice(1);
  const valueOptions = new Set([
    '--timeout',
    '--state-dir',
    '--socket',
    '--browser',
    '--browser-executable',
    '--page',
  ]);
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (valueOptions.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith('--')) continue;
    positional.push(value);
  }
  if (positional.length === 0) throw new Error('wait-for-text requires text');

  const result = ['wait-for-text', '--text', positional.join(' ')];
  for (const [legacy, canonical] of [
    ['--timeout', '--timeout-ms'],
    ['--state-dir', '--state-dir'],
    ['--socket', '--socket'],
    ['--browser', '--browser'],
    ['--browser-executable', '--browser-executable'],
    ['--page', '--page'],
  ] as const) {
    const value = optionValue(args, legacy);
    if (value !== undefined) result.push(canonical, value);
  }
  if (args.includes('--json')) result.push('--json');
  return result;
}

function globalArgs(argv: readonly string[]): readonly string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (
      value === '--state-dir' ||
      value === '--socket' ||
      value === '--browser' ||
      value === '--browser-executable'
    ) {
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
  const browserPreference = optionValue(argv, '--browser');
  const browserExecutable = optionValue(argv, '--browser-executable');
  return resolveConfig({
    ...(stateDir === undefined ? {} : { stateDir }),
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(browserPreference === undefined
      ? {}
      : { browserPreference: browserPreference as BrowserPreference }),
    ...(browserExecutable === undefined ? {} : { browserExecutable }),
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
    message: `agbrowse command is unsupported by SessionPlane: ${command}`,
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
