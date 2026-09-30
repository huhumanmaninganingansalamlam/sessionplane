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
  team_delete: 'Permanently delete this entire team, including its roles, sessions, request history and artifact references. Stops owned work and closes owned tabs. Makes one best-effort provider conversation deletion attempt; cleanup failures are returned but do not block local deletion. Retrieve needed outputs first. Exported files and shared content remain. Reuse requestId for retries.',
  team_create: 'Create a durable team with its main conversation. Keep teamId and use team_get to resume.',
  team_get: 'Read roles and request references in a team. history:true lists all generations; continue with nextRequestRef as beforeRequestRef. Include requestRef to recover or inspect that exact request and fresh UI evidence.',
  role_create: 'Create an expert/reviewer role and its provider conversation in the team.',
  role_retire: 'Retire a finished non-primary role. Submitted work remains observable; provider history is not deleted.',
  session_replace: 'Attempt to permanently delete the previous provider conversation, close its tab and end observation, then create a new session with the same provider. This discards unfinished provider work; retrieve required outputs and write the handoff first. Local stored results remain. Deletion failure or unknown conversation identity does not block replacement; there is no automatic retry. Use a fresh roleRef, or roleKey only for an empty role. Never replays prompts.',
  session_delete: 'Permanently delete the exact completed provider conversation after retrieving needed answers/files. Rejects ambiguous, active or shared history.',
  send: 'Send to a fresh roleRef with the intended model/effort. Returns requestRef, configurationCatalog with observed combined model/power labels, and needs_decision evidence or submission state.',
  decide: 'Select an observed configurationCatalog option with decision configure and configurationId. Use discover to rebuild a missing or stale catalog. Neither operation submits. Choose composer and submit from fresh evidence; raw reveal is for diagnostics. focus brings the exact connected request tab to the foreground for human intervention, without reload, resend or creating a tab. Use only when the user asks to view or control it. refresh reloads the owned page. For submission_unknown, inspect team_get submissionCandidates; acknowledge with the matching messageId and evidenceHash binds that existing message and reads its answer without sending. Choose only after checking the candidate against the requested prompt; leave unresolved candidates for user judgment. Use stop to cancel.',
  wait: 'Wait for state changes on exact requestRefs, retrieve answers and capture generated files; outputDir exports them locally. For active work, call wait on the same requestRef with a positive waitMs, including before nextCheckAt. nextCheckAt schedules core backend probes only; do not sleep until it to collect results. The core enforces probe cooldowns while DOM observation continues. needs_decision requires decide; provider-actionable-alert requires inspecting evidence.',
  stop: 'Cancel preparation or attempt one provider stop for this exact requestRef without affecting a newer request. provider.stop-unavailable means no mutation was attempted; provider.stop-unknown means an unacknowledged attempt, not confirmed cancellation. Observe the same request read-only; never repeat an uncertain stop under another requestId. Get/wait expose stopOutcome.state unknown across restart.',
};

export const MCP_TOOLS: readonly McpToolDefinition[] = Object.entries(workflowSchemas).map(([name, schema]) => ({
  name: 'sessionplane_' + name,
  rpcMethod: 'workflow.' + name,
  description: descriptions[name as keyof typeof workflowSchemas],
  inputSchema: { ...z.toJSONSchema(schema, { io: 'input' }), type: 'object' },
  annotations: {
    readOnlyHint: name === 'team_get',
    destructiveHint: ['team_delete', 'role_retire', 'session_replace', 'session_delete', 'stop'].includes(name),
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
