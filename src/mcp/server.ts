import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

import { resolveConfig, type SessionPlaneConfig } from '../config.ts';
import {
  MCP_LEGACY_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SERVER_INFO,
  McpProtocolError,
  isRecord,
  mcpError,
  mcpSuccess,
  modernResult,
  parseMcpRequest,
  requireModernMetadata,
  stripProtocolMetadata,
  type McpRequest,
  type McpRequestId,
  type McpResponse,
} from './schemas.ts';
import {
  MCP_TOOLS,
  McpToolNotFoundError,
  invokeMcpTool,
  resolveMcpToolTimeoutMs,
} from './tools.ts';

export interface McpServerOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly error?: NodeJS.WritableStream;
  readonly config?: SessionPlaneConfig;
}

type ProtocolMode = 'modern' | 'legacy';

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const config = options.config ?? resolveConfig();
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const server = new SessionPlaneMcpServer({ config, output, error });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  const operations = new Set<Promise<void>>();
  for await (const line of lines) {
    if (Buffer.byteLength(line, 'utf8') > config.rpcMaxLineBytes) {
      await server.writeResponse(
        mcpError(null, -32600, 'MCP request line exceeded configured limit'),
      );
      continue;
    }
    const operation = server.handleLine(line).finally(() => operations.delete(operation));
    operations.add(operation);
  }
  await Promise.allSettled([...operations]);
  await server.close();
}

class SessionPlaneMcpServer {
  readonly #config: SessionPlaneConfig;
  readonly #output: NodeJS.WritableStream;
  readonly #error: NodeJS.WritableStream;
  readonly #inFlight = new Map<string, AbortController>();
  #legacyInitialized = false;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly config: SessionPlaneConfig;
    readonly output: NodeJS.WritableStream;
    readonly error: NodeJS.WritableStream;
  }) {
    this.#config = options.config;
    this.#output = options.output;
    this.#error = options.error;
  }

  async handleLine(line: string): Promise<void> {
    let input: unknown;
    try {
      input = JSON.parse(line) as unknown;
    } catch {
      await this.writeResponse(mcpError(null, -32700, 'Parse error'));
      return;
    }

    let request: McpRequest;
    try {
      request = parseMcpRequest(input);
    } catch (error) {
      const protocolError = normalizeProtocolError(error);
      await this.writeResponse(
        mcpError(null, protocolError.code, protocolError.message, protocolError.data),
      );
      return;
    }

    if (request.id === undefined) {
      await this.#handleNotification(request);
      return;
    }

    let response: McpResponse;
    try {
      response = mcpSuccess(request.id, await this.#dispatch(request));
    } catch (error) {
      const protocolError = normalizeProtocolError(error);
      response = mcpError(
        request.id,
        protocolError.code,
        protocolError.message,
        protocolError.data,
      );
    }
    await this.writeResponse(response);
  }

  async writeResponse(response: McpResponse): Promise<void> {
    const line = `${JSON.stringify(response)}\n`;
    const write = this.#writeTail.then(
      async () => await writeChunk(this.#output, line),
    );
    this.#writeTail = write.catch(() => undefined);
    await write;
  }

  async close(): Promise<void> {
    for (const controller of this.#inFlight.values()) {
      controller.abort();
    }
    this.#inFlight.clear();
    await this.#writeTail;
  }

  async #dispatch(request: McpRequest): Promise<unknown> {
    switch (request.method) {
      case 'server/discover': {
        requireModernMetadata(request.params);
        return modernResult({
          supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: false } },
          instructions: serverInstructions(),
          ttlMs: 300_000,
          cacheScope: 'public',
        });
      }
      case 'initialize':
        return this.#initializeLegacy(request.params);
      case 'tools/list': {
        const mode = this.#requestMode(request.params);
        const result = {
          tools: MCP_TOOLS.map(({ rpcMethod: _rpcMethod, ...definition }) => definition),
        };
        return mode === 'modern' ? modernResult(result) : result;
      }
      case 'tools/call':
        if (request.id === undefined) {
          throw new McpProtocolError(-32600, 'tools/call requires a request id');
        }
        return await this.#callTool(request.id, request.params);
      case 'ping': {
        const mode = this.#requestMode(request.params);
        return mode === 'modern' ? modernResult({}) : {};
      }
      default:
        throw new McpProtocolError(-32601, 'Method not found', {
          method: request.method,
        });
    }
  }

  #initializeLegacy(params: unknown): Readonly<Record<string, unknown>> {
    if (!isRecord(params)) {
      throw new McpProtocolError(-32602, 'Invalid initialize params');
    }
    const requested = params.protocolVersion;
    if (typeof requested !== 'string' || requested.length === 0) {
      throw new McpProtocolError(-32602, 'Invalid initialize protocol version');
    }
    this.#legacyInitialized = true;
    return {
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_LEGACY_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: MCP_SERVER_INFO,
      instructions: serverInstructions(),
    };
  }

  async #callTool(id: McpRequestId, params: unknown): Promise<Readonly<Record<string, unknown>>> {
    const mode = this.#requestMode(params);
    const argumentsObject = stripProtocolMetadata(params);
    const name = argumentsObject.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new McpProtocolError(-32602, 'tools/call requires a tool name');
    }
    const toolArguments = argumentsObject.arguments ?? {};
    if (!isRecord(toolArguments)) {
      throw new McpProtocolError(-32602, 'tools/call arguments must be an object');
    }

    const controller = new AbortController();
    const requestKey = requestIdKey(id);
    if (this.#inFlight.has(requestKey)) {
      throw new McpProtocolError(-32600, 'Duplicate in-flight request id');
    }
    this.#inFlight.set(requestKey, controller);
    try {
      const invocation = await invokeMcpTool({
        name,
        arguments: toolArguments,
        socketPath: this.#config.socketPath,
        remote: this.#config.remote,
        timeoutMs: resolveMcpToolTimeoutMs({
          rpcRequestTimeoutMs: this.#config.rpcRequestTimeoutMs,
          submissionAckTimeoutMs: this.#config.submissionAckTimeoutMs,
        }),
        maxLineBytes: this.#config.rpcMaxLineBytes,
        signal: controller.signal,
      });
      const result = callToolResult(invocation.structuredContent, invocation.isError);
      return mode === 'modern' ? modernResult(result) : result;
    } catch (error) {
      if (error instanceof McpToolNotFoundError) {
        throw new McpProtocolError(-32602, error.message, { name });
      }
      if (controller.signal.aborted) {
        const result = callToolResult(
          {
            requestOk: false,
            errorCode: 'input.cancelled',
            message: 'MCP request was cancelled; core session lifecycle was not changed.',
          },
          true,
        );
        return mode === 'modern' ? modernResult(result) : result;
      }
      throw error;
    } finally {
      this.#inFlight.delete(requestKey);
    }
  }

  #requestMode(params: unknown): ProtocolMode {
    if (this.#legacyInitialized) return 'legacy';
    requireModernMetadata(params);
    return 'modern';
  }

  async #handleNotification(request: McpRequest): Promise<void> {
    switch (request.method) {
      case 'notifications/initialized':
        return;
      case 'notifications/cancelled': {
        const params = isRecord(request.params) ? request.params : {};
        const requestId = params.requestId;
        if (
          typeof requestId === 'string' ||
          typeof requestId === 'number' ||
          requestId === null
        ) {
          this.#inFlight.get(requestIdKey(requestId))?.abort();
        }
        return;
      }
      default:
        this.#error.write(`Ignored MCP notification: ${request.method}\n`);
    }
  }
}

function callToolResult(
  structuredContent: Readonly<Record<string, unknown>>,
  isError: boolean,
): Readonly<Record<string, unknown>> {
  const serialized = JSON.stringify(structuredContent);
  const request = structuredContent.request;
  const required = [structuredContent, structuredContent.request,
    ...(Array.isArray(structuredContent.results) ? structuredContent.results : []),
    ...(Array.isArray(structuredContent.roles) ? structuredContent.roles : [])]
    .filter(value => isRecord(value) && value.userActionRequired === true);
  const recoveryRequired = [...new Map(required.map(value => [value.requestRef,
    { requestRef: value.requestRef, status: value.status, userActionRequired: true, message: value.message, recovery: value.recovery }])).values()];
  const text =
    Buffer.byteLength(serialized, 'utf8') <= 64 * 1024
      ? serialized
      : JSON.stringify({
          requestOk: structuredContent.requestOk ?? !isError,
          ...(isRecord(request) ? { request: Object.fromEntries(
            ['requestRef', 'teamId', 'roleId', 'roleKey', 'sessionId', 'generation', 'conversationId',
              'submittedUserMessageId', 'submittedUserTurnId', 'submissionState', 'sessionState', 'providerState',
              'promptSubmitted', 'terminal', 'status', 'errorCode', 'reason', 'nextCheckAt', 'userActionRequired']
              .filter(key => key in request)
              .map(key => [key, request[key]])) } : {}),
          truncatedInText: true,
          byteLength: Buffer.byteLength(serialized, 'utf8'),
          note: 'The exact full result is available in structuredContent.',
          ...(recoveryRequired.length === 0 ? {} : { recoveryRequired }),
        });
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError,
  };
}

function serverInstructions(): string {
  return [
    'Keep teamId; copy roleRef for sends and requestRef for all request controls. Use stable unique requestId values and reuse only identical mutations.',
    'team_get defaults to compact stored summary without provider probes. Use view:result for the exact answer and view:evidence for fresh UI, original prompt/candidates and controls. Stored ACK, connected collector, tool evidence and final answer are separate facts.',
    'needs_decision preserves the same request. Select an observed configurationCatalog option by configurationId or option.selection; configure never submits. Choose composer and submit from fresh evidence. Honor exact requested model/effort and Chat; incomplete discovery does not prove model unavailability.',
    'Keep one positive wait per chain. When normal same-chat continuation is user-approved, pass continuationApproved:true; it retains broad reviews and successor collection. Pacing and routine expiry remain inside the client. nextCheckAt paces backend probes, not DOM collection. Retain original requests and Retry-After; never replay UNKNOWN submissions.',
    'For UNKNOWN, compare the full original prompt and candidate through view:evidence before acknowledge. Existing recovery decisions preserve original identity and drafts; returned errors and human-review requirements must reach the user.',
    'Do not refresh automatically. For user intervention, human_review pause actually holds observation and Continue without stopping provider work; focus the exact tab and report its current error and required action. Resume after user completion. A report alone does not pause Core. A normal final ends managed recovery; separately authorized next-work follow-ups belong to the owner.',
  ].join(' ');
}

function requestIdKey(id: McpRequestId): string {
  return JSON.stringify([typeof id, id]);
}

function normalizeProtocolError(error: unknown): McpProtocolError {
  if (error instanceof McpProtocolError) {
    return error;
  }
  return new McpProtocolError(-32603, 'Internal error', {
    errorCode: 'internal.invariant-violation',
  });
}

async function writeChunk(output: NodeJS.WritableStream, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      output.removeListener('error', onError);
      output.removeListener('drain', onDrain);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    output.once('error', onError);
    if (output.write(value)) {
      cleanup();
      resolve();
    } else {
      output.once('drain', onDrain);
    }
  });
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  runMcpServer().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
