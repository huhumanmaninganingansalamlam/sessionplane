import { MAX_WORKFLOW_WAIT_MS } from '../domain/workflow-wait.ts';
import type { RemoteConnection } from '../config.ts';
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
  team_get: 'Read roles and request references in a team. history:true lists all generations; continue with nextRequestRef as beforeRequestRef. Include requestRef for its exact request. Default view:summary reads stored ACK/result availability, connected collectors and managed review/pacing without provider access or bodies. view:result recovers the exact answer; view:evidence also returns fresh UI, prompt/candidate controls, owned mounted conversation context and current draft for preservation. Check anchor/scope/truncation: context is neither a collected final nor mutation readiness. Unrelated requests are omitted unless history:true is explicit.',
  role_create: 'Create an expert/reviewer role and its provider conversation in the team.',
  role_retire: 'Retire a finished non-primary role. Submitted work remains observable; provider history is not deleted.',
  session_replace: 'Renew context on the same stable role with its fresh roleRef; keep role ID/key and provider, not a new continuation role. Resolve current work, retrieve required outputs and save the handoff first, then carry it into the returned successor roleRef with fresh preparation. Default authorized replacement attempts provider conversation deletion once and independently closes verified idle owned tabs; inspect replacement.cleanup.pageCleanup even if deletion fails. Stored results remain; no prompt is sent or replayed. Preserve active/UNKNOWN work and drafts. preserveConversation:true explicitly retains the old chat/pages/evidence with the same provider, cleanup.outcome preserved. It accepts bound prepared/unsubmitted recovery or an acknowledged request after exact idle-page validation with no later user, draft, activity or pending permission/verification. For explicit user-directed handoff of a broken unresolved chat, pass unresolvedHandoff:{requestRef,approvalRef} with preserveConversation:true after holding the exact request and transferring all collectors. Only role routing moves: original submission, uncertainty, ACK, draft and hold remain unchanged; provider work is neither stopped nor declared finished. Without this explicit handoff, UNKNOWN delivery remains guarded; an exhausted conversation does not become a fabricated final. roleKey is only for an empty role.',
  session_delete: 'Permanently delete the exact completed provider conversation after retrieving needed answers/files. Rejects active or shared history. Unresolved history requires explicit discardRetiredObservation for the exact locally retired generation/conversation; original records remain preserved. Provider deletion and safe owned-tab closure are independent: inspect pageCleanup on results or error details; a closed tab does not prove provider deletion.',
  send: 'Optional thinkingFailureRecovery:true explicitly hands same-chat Thinking-failed continuation sending to the core until a normal final, within the original deadline. Never send in parallel while opted in. Omit for default owner-only sending. Send the task to a fresh roleRef using the requested model/effort; verify selection from supported provider UI/preparation/submission evidence when needed. Never ask the answering assistant to identify or confirm its model, or treat its self-report as verification. Missing response fields alone require neither an identity prompt nor user confirmation. Returns requestRef, configurationCatalog with observed combined model/power labels, and needs_decision evidence or submission state.',
  decide: 'Control the exact request using a stable requestId. configure selects an observed configurationId without submitting; discover rebuilds its catalog. choose/reveal use fresh snapshotId/ref and advertised purpose; choose submit last. acknowledge binds a matching existing messageId/evidenceHash after comparing full original/candidate evidence (team_get view:evidence), never resends. continue with continuationApproved:true uses the existing guarded same-chat recovery: one exact Retry or one literal 계속, then collection. Preserve active/UNKNOWN work, later turns, answers, separate drafts and real permission refusals. userConfirmedInterruption requires direct user confirmation of that exact conversation/ACK. hostspan_permission inspect with appName and no toolName discovers actual cards, including earlier turns and collapsed work in the owned conversation; inspect the observed toolName, then allow with its evidenceHash. To reveal a selected activity only, inspect without toolName using its fresh activityEvidenceHash as evidenceHash. Use followupUserMessageId for an acknowledged exact recovery chain under a distinct preparation. Explicit always authorization requires allowMode:always on both inspect and allow; never substitute once. human_review pause/resume holds/resumes observation and managed Continue without stopping generation; resume after user completion. focus activates only the exact connected tab when requested. reopen opens or rebinds only the verified original conversation URL, even under human hold; it preserves hold/ACK/results/drafts, never reloads an existing tab, clicks controls, submits or starts observation. latest reveals its existing anchor/answer without reload or send; anchorPresent is not completion, and historical answerRecovery is usable only when terminal. refresh is an explicit page reload, never automatic. reconcile_failure preserves a freshly verified idle failure; it does not submit, and active/ambiguous work stays guarded. continuationPrompt:계속 preserves only that explicitly authorized draft. reconcile_followup validates the confirmed later user/assistant/hash and closes only original tracking without borrowing the later answer. retire_observation ends obsolete local tracking only with workComplete/evidenceRef and the guarded retired/displaced or completed-successor ownership. Original uncertainty, answers and drafts remain. Use stop to cancel.',
  wait: 'Collect exact answers/files externally on the original request chain; outputDir exports files. Keep one owner. For user-approved normal same-chat recovery, continuationApproved:true enables broad reviews and follows successors; it never permits refresh or original-prompt replay. Positive waitMs defaults to ten minutes per round, rounded to minutes. The client retains routine expiry/pacing internally unless untilResult:false; zero reads once. Completion, errors and decisions return immediately. nextCheckAt limits backend probes while DOM collection continues. followupUserMessageId collects an already-submitted later turn without resending. Return userActionRequired/recovery.url to the user, preserve UNKNOWN and drafts, and never infer product progress from an ACK or live collection call.',

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
  readonly remote?: RemoteConnection | undefined;
  readonly timeoutMs: number;
  readonly maxLineBytes: number;
  readonly signal?: AbortSignal;
}): Promise<McpToolInvocationResult> {
  const definition = getMcpTool(options.name);
  if (definition === null) {
    throw new McpToolNotFoundError(options.name);
  }

  try {
    const wait = definition.rpcMethod === 'workflow.wait' ? workflowSchemas.wait.safeParse(options.arguments) : null;
    const keepWaiting = wait?.success && wait.data.waitMs > 0 && wait.data.untilResult !== false;
    const result = await callRpc<unknown>({
      socketPath: options.socketPath,
      remote: options.remote,
      method: definition.rpcMethod,
      collectContinuation: definition.rpcMethod === 'workflow.decide' && (options.arguments as { decision?: string })?.decision === 'continue',
      params: keepWaiting ? { ...wait.data, untilResult: true } : options.arguments,
      timeoutMs: wait?.success ? Math.max(options.timeoutMs, (keepWaiting ? MAX_WORKFLOW_WAIT_MS : wait.data.waitMs) + 5_000) : options.timeoutMs,
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
