import type { RemoteConnection } from '../config.ts';
import { z } from 'zod';
import { taskSchemas, projectOpenSchema } from '../rpc/methods/task.ts';
import { callRpc, RpcClientError } from '../cli/client.ts';

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
  readonly rpcMethod: string;
}

export interface McpToolInvocationResult {
  readonly isError: boolean;
  readonly structuredContent: Readonly<Record<string, unknown>>;
}

export class McpToolNotFoundError extends Error {
  constructor(name: string) {
    super('Unknown SessionPlane MCP tool: ' + name);
    this.name = 'McpToolNotFoundError';
  }
}

export function resolveMcpToolTimeoutMs(options: {
  readonly rpcRequestTimeoutMs: number;
  readonly submissionAckTimeoutMs: number;
}): number {
  return Math.max(options.rpcRequestTimeoutMs, options.submissionAckTimeoutMs + 10_000, 125_000);
}

const taskDescriptions: Record<keyof typeof taskSchemas, string> = {
  start: 'Start one exact project conversation Task. Core owns preparation, dispatch, canonical ACK, FINAL and approved continuation. Reuse requestId only for an identical request.',
  get: 'Read the durable Task. Select view=result for the complete exact answer or view=evidence for bounded provenance; never invokes provider mutation.',
  wait: 'Wait once, bounded by waitMs, for a newer Task revision. A client disconnect never cancels Core work.',
  decide: 'Consume an exact decisionId/actionRef once, or use refresh:true only for read-only reinspection of an unactionable/expired model decision. Never grants permission or replays a provider POST.',
  cancel: 'Persist Task cancellation intent and revoke future Continue; ambiguous external stop remains uncertain.',
};

export const TASK_MCP_TOOLS: readonly McpToolDefinition[] =
  Object.entries(taskSchemas).map(([name, schema]) => ({
    name: 'sessionplane_task_' + name,
    rpcMethod: 'task.' + name,
    description: taskDescriptions[name as keyof typeof taskSchemas],
    inputSchema: { ...z.toJSONSchema(schema, { io: 'input' }), type: 'object' },
    annotations: {
      readOnlyHint: name === 'get' || name === 'wait',
      destructiveHint: name === 'cancel',
      idempotentHint: true,
      openWorldHint: false,
    },
  }));

export const PROJECT_MCP_TOOL: McpToolDefinition = {
  name: 'sessionplane_project_open',
  rpcMethod: 'project.open',
  description: 'Open the canonical owner-scoped project and Main conversation slot. No provider send occurs until task.start.',
  inputSchema: { ...z.toJSONSchema(projectOpenSchema, { io: 'input' }), type: 'object' },
  annotations: {
    readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  },
};

/** The sole public MCP catalogue. Old workflow names are not registered,
 * callable, or emitted by the package, including on reconnect.
 */
export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  PROJECT_MCP_TOOL, ...TASK_MCP_TOOLS,
]);

export function getMcpTool(name: string): McpToolDefinition | null {
  return MCP_TOOLS.find(candidate => candidate.name === name) ?? null;
}

export async function invokeMcpTool(options: {
  readonly name: string;
  readonly arguments: unknown;
  readonly socketPath: string;
  readonly remote?: RemoteConnection | undefined;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly signal?: AbortSignal;
}): Promise<McpToolInvocationResult> {
  const definition = getMcpTool(options.name);
  if (definition === null) throw new McpToolNotFoundError(options.name);

  try {
    // Every invocation is a thin call into the same Core RPC. No client
    // lifecycle loop, collector, timer, or implicit mutation retry.
    const wait = definition.rpcMethod === 'task.wait'
      ? taskSchemas.wait.safeParse(options.arguments) : null;
    const timeoutMs = wait?.success
      ? Math.max(options.timeoutMs, wait.data.waitMs + 5_000)
      : options.timeoutMs;
    const result = await callRpc<unknown>({
      socketPath: options.socketPath,
      remote: options.remote,
      method: definition.rpcMethod,
      params: options.arguments,
      timeoutMs,
      maxLineBytes: options.maxLineBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      isError: false,
      structuredContent: isRecord(result) ? result : { value: result },
    };
  } catch (error) {
    if (!(error instanceof RpcClientError)) throw error;
    const data = isRecord(error.data) ? error.data : {};
    return {
      isError: true,
      structuredContent: {
        requestOk: false,
        errorCode: typeof data.errorCode === 'string'
          ? data.errorCode : 'internal_failure',
        message: error.message,
        ...(data.details === undefined ? {} : { details: data.details }),
      },
    };
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
