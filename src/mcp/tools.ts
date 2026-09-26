import { z } from 'zod';
import { workflowSchemas } from '../rpc/methods/workflow.ts';
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
    super(`Unknown SessionPlane MCP tool: ${name}`);
    this.name = 'McpToolNotFoundError';
  }
}

export function resolveMcpToolTimeoutMs(options: {
  readonly rpcRequestTimeoutMs: number;
  readonly submissionAckTimeoutMs: number;
}): number {
  return Math.max(options.rpcRequestTimeoutMs, options.submissionAckTimeoutMs + 10_000, 125_000);
}

const descriptions: Record<keyof typeof workflowSchemas, string> = {
  team_create: 'Create a durable team with its main conversation. Keep teamId and use team_get to resume.',
  team_get: 'Read roles and request references in a team. history:true lists all generations; continue with nextRequestRef as beforeRequestRef. Include requestRef to recover or inspect that exact request and fresh UI evidence.',
  role_create: 'Create an expert/reviewer role and its provider conversation in the team.',
  role_retire: 'Retire a finished non-primary role. Submitted work remains observable; provider history is not deleted.',
  session_replace: 'Replace a broken or long conversation using a fresh roleRef, keeping its provider and old results. If team_get shows a role with no session, use its roleKey instead to initialize it. Never replays prompts or deletes history.',
  session_delete: 'Permanently delete the exact completed provider conversation after retrieving needed answers/files. Rejects ambiguous, active or shared history.',
  send: 'Send to an observed roleRef. Returns requestRef and either needs_decision with fresh evidence or submission state. Preserve model intent. Never resend an ambiguous request.',
  decide: 'Choose a fresh observed control for the pending request and continue it automatically, or reveal model/effort choices. No separate resume call. Use stop to cancel.',
  wait: 'Wait on exact requestRefs, retrieve answers and capture generated files. outputDir exports files locally. needs_decision requires decide; timeout is not failure or permission to resend.',
  stop: 'Cancel preparation or stop generation for this exact requestRef without affecting a newer request.',
};

export const MCP_TOOLS: readonly McpToolDefinition[] = Object.entries(workflowSchemas).map(([name, schema]) => ({
  name: 'sessionplane_' + name,
  rpcMethod: 'workflow.' + name,
  description: descriptions[name as keyof typeof workflowSchemas],
  inputSchema: z.toJSONSchema(schema, { io: 'input' }),
  annotations: {
    readOnlyHint: name === 'team_get',
    destructiveHint: ['role_retire', 'session_replace', 'session_delete', 'stop'].includes(name),
    idempotentHint: true,
    openWorldHint: true,
  },
}));

export function getMcpTool(name: string): McpToolDefinition | null {
  return MCP_TOOLS.find((candidate) => candidate.name === name) ?? null;
}

export async function invokeMcpTool(options: {
  readonly name: string;
  readonly arguments: unknown;
  readonly socketPath: string;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly signal?: AbortSignal;
}): Promise<McpToolInvocationResult> {
  const definition = getMcpTool(options.name);
  if (definition === null) {
    throw new McpToolNotFoundError(options.name);
  }

  try {
    const result = await callRpc<unknown>({
      socketPath: options.socketPath,
      method: definition.rpcMethod,
      params: options.arguments,
      timeoutMs: options.timeoutMs,
      maxLineBytes: options.maxLineBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return {
      isError: false,
      structuredContent: normalizeStructuredContent(result),
    };
  } catch (error) {
    if (!(error instanceof RpcClientError)) {
      throw error;
    }
    const data = isRecord(error.data) ? error.data : {};
    return {
      isError: true,
      structuredContent: {
        requestOk: false,
        errorCode:
          typeof data.errorCode === 'string'
            ? data.errorCode
            : 'internal.invariant-violation',
        message: error.message,
        ...(data.details === undefined ? {} : { details: data.details }),
      },
    };
  }
}

function normalizeStructuredContent(value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  return { value };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
