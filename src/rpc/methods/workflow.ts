import { z } from 'zod';
import { DEFAULT_WORKFLOW_WAIT_MS, MAX_WORKFLOW_WAIT_MS, workflowWaitMs } from '../../domain/workflow-wait.ts';
import type { TeamWorkflow } from '../../core/team-workflow.ts';
import type { RpcRouter } from '../router.ts';

const requestId = z.string().trim().min(1).max(300).describe('Stable unique ID for this mutation. Reuse only for identical arguments.');
const teamId = z.string().uuid().describe('Durable team ID.');
const roleRef = z.string().regex(/^[0-9a-f-]{36}:\d+$/).describe('Copy the roleRef returned by team_get; refresh after each new send or replacement.');
const requestRef = z.string().uuid().describe('Copy the exact requestRef from send or team_get.');
const provider = z.enum(['chatgpt', 'gemini', 'grok']).default('chatgpt');
const mutation = { teamId, requestId };
const request = { teamId, requestRef };

export const workflowSchemas = {
  team_delete: z.object(mutation).strict(),
  team_create: z.object({ requestId, name: z.string().max(500).optional(), objective: z.string().max(20_000).optional(), provider }).strict(),
  team_get: z.object({ teamId, requestRef: requestRef.optional(), view: z.enum(['summary', 'result', 'evidence']).optional().describe('Default summary reads stored status, ACK, collection and pacing without a provider probe or prompt/answer body. result recovers the exact answer; evidence also inspects fresh UI and returns preparation/candidate controls. Explicit maxNodes implies evidence when view is omitted.'), maxNodes: z.number().int().min(1).max(5000).optional(), history: z.boolean().optional().describe('List all request generations in pages, newest first.'), beforeRequestRef: requestRef.optional().describe('Continue history using nextRequestRef returned by team_get.') }).strict(),
  role_create: z.object({ ...mutation, roleKey: z.string().trim().min(1).max(80), roleType: z.enum(['expert', 'reviewer', 'custom']).default('expert'), displayName: z.string().max(500).optional(), provider }).strict(),
  role_retire: z.object({ ...mutation, roleRef }).strict(),
  session_open: z.object({ ...mutation, roleRef }).strict().describe('Materialize only an empty current ChatGPT session. Opens its owned Chat page without a prompt, generation, configuration, submission or collector.'),
  session_replace: z.object({ ...mutation, roleRef: roleRef.optional(), roleKey: z.string().trim().min(1).max(80).optional().describe('Instead of roleRef, use the observed roleKey only when the role has no session.'), provider: provider.removeDefault().optional().describe('Only for an empty role; defaults to chatgpt. Existing conversations retain their provider.'), preserveConversation: z.literal(true).optional().describe('Explicit nondeleting recovery of a bound prepared/unsubmitted request using its fresh roleRef. Keeps the same role and old chat/request evidence; creates an empty successor without replay. Acknowledged idle renewal is also supported.'), unresolvedHandoff: z.object({ requestRef, approvalRef: z.string().trim().min(1).max(2000) }).strict().optional().describe('Only with preserveConversation:true and explicit user approval to move this exact held unresolved request to a new context. Requires no existing collectors. Preserves original uncertainty, ACK, draft and hold; neither stops provider work nor replays a prompt. Does not claim an idle page or completion.') }).strict(),
  session_delete: z.object({ ...request, requestId, outputsRetrieved: z.literal(true), discardRetiredObservation: z.object({ conversationId: z.string().min(1).max(300), evidenceRef: z.string().trim().min(1).max(2000), discardPageState: z.literal(true).optional().describe('Explicitly discard draft and generation UI only on the exact obsolete owned page after unresolved observation retirement. Never stops backend commands or marks them complete.') }).strict().optional().describe('Explicitly authorize permanent deletion of this exact obsolete conversation after observation retirement and role displacement/retirement. Preserves unresolved generation records; never means its answer was retrieved.'), }).strict(),
  send: z.object({ ...mutation, roleRef, thinkingFailureRecovery: z.literal(true).optional().describe('Explicit sender handoff to core for same-chat 계속 after exact idle Thinking failed; off when omitted. Preserves original deadline and failure; no refusal/auth retry.'), prompt: z.string().min(1).max(200_000), model: z.string().trim().min(1).max(200).optional(), effort: z.string().trim().min(1).max(200).optional(), files: z.array(z.string().min(1).max(20_000)).max(20).optional().describe('Attachment paths. Uploads are disabled by default; use only when team capabilities.uploadsEnabled is true.'), sessionDeadlineSec: z.number().int().min(1).max(86_400).default(5400) }).strict(),
  decide: z.union([
    z.object({ ...request, requestId, decision: z.literal('continue'), continuationApproved: z.literal(true),
      manageOnly: z.literal(true).optional().describe('Approve paced management of this exact acknowledged recovery chain in the existing collector. No immediate send or new collector; requires followupUserMessageId.'),
      followupUserMessageId: z.string().min(1).max(300).optional().describe('Recover this exact interrupted later turn while retaining a separate never-submitted preparation and its draft.'),
      userConfirmedInterruption: z.object({ conversationId: z.string().min(1).max(300), submittedUserMessageId: z.string().min(1).max(300),
        evidenceRef: z.string().trim().min(1).max(2000),
        resolvedToolAlert: z.object({ appName: z.string().regex(/^hostspan(?:-[a-z0-9_-]+)?$/i),
          alertSha256: z.string().regex(/^[a-f0-9]{64}$/), originalOperationOutcome: z.enum(['not-started', 'completed', 'unknown']),
          readOnlyOperationInactive: z.literal(true).optional()
        }).strict().refine(value => value.originalOperationOutcome !== 'unknown' || value.readOnlyOperationInactive === true,
          'Invalid UNKNOWN recovery: evidenceRef must preserve the reviewed read-only command and current operation inactivity')
          .optional().describe('After actual app recovery, record the original operation evidence and exact expiration-alert hash. UNKNOWN is retained only for a reviewed read-only command with current inactivity evidence and readOnlyOperationInactive:true; never reissues it. New permission/auth dialogs and other alerts remain blocked.')
      }).strict().optional().describe('Only after the user directly confirms this exact disconnected turn and explicitly requests one continue. Not for automated inference; active streaming, final answers, later users, permissions and separate drafts remain protected.') }).strict(),
    z.object({ ...request, requestId, decision: z.literal('hostspan_permission'), action: z.enum(['inspect', 'allow', 'decline']).describe('inspect reads the owned pending card and tool arguments, possibly opening/closing details or expanding activity; it never grants permission or executes the pending tool. Unknown arguments are inspected before approval. allow grants the separately authorized tool using fresh matching inspection evidence; it may resume execution. decline rejects only the exact pending tool using the same fresh card inspection hash; it never grants or executes that tool, sends a prompt or stops a process.'),
      followupUserMessageId: z.string().min(1).max(300).optional().describe('Source of an acknowledged exact recovery chain under a separate unsubmitted preparation.'),
      appName: z.string().regex(/^hostspan(?:-[a-z0-9_-]+)?$/i), toolName: z.string().trim().min(1).max(200).optional().describe('Omit only for inspect to discover actual HostSpan cards in this owned conversation; allow and decline require the observed tool name.'),
      allowMode: z.enum(['once', 'always']).optional().describe('Select the exact observed ChatGPT HostSpan permission option; always requires explicit user authorization. Defaults to once.'),
      evidenceHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
    z.object({ ...request, requestId, decision: z.literal('retire_observation'), workComplete: z.literal(true),
      evidenceRef: z.string().trim().min(1).max(2000), successorRequestRef: requestRef.optional() }).strict(),
    z.object({ ...request, requestId, decision: z.literal('retire_observation'), discardUnresolved: z.literal(true),
      evidenceRef: z.string().trim().min(1).max(2000).describe('Preserved outputs/drafts and UNKNOWN command references plus the explicit user disposal instruction. Disposes only obsolete observation, never asserts child completion.') }).strict(),
    z.object({ ...request, requestId, decision: z.literal('reconcile_followup'), followupUserMessageId: z.string().min(1).max(300),
      responseMessageId: z.string().min(1).max(300), responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
      followupCompleted: z.literal(true) }).strict(),
    z.object({ ...request, requestId, decision: z.literal('prepare_resend'), approvalRef: z.string().trim().min(1).max(300), duplicateRiskAccepted: z.literal(true) }).strict(),
    z.object({ ...request, requestId, decision: z.literal('followup'),
      approvalRef: z.string().trim().min(1).max(300).describe('Exact user instruction for one new literal 계속 in this bound UNKNOWN request or backend-proven lost literal continuation’s conversation. Not an automatic retry or original prompt resend; provider errors, activity and other drafts still block.') }).strict(),
    z.object({ ...request, requestId, decision: z.literal('human_review'), action: z.enum(['pause', 'resume']) }).strict(),
    z.object({ ...request, requestId, decision: z.literal('discover') }).strict(),
    z.object({ ...request, requestId, decision: z.literal('configure'), configurationId: z.string().regex(/^[a-f0-9]{24}$/).describe('Copy the ID of the desired combined configuration from configurationCatalog.options.') }).strict(),
    z.object({ ...request, requestId, decision: z.literal('acknowledge').describe('Bind only the explicitly selected existing message after full comparison. CLI/MCP retain valid provider deferrals within this one call using unchanged requestId/messageId/evidenceHash and nextCheckAt; every retry revalidates fresh evidence. Stale or unverified evidence returns immediately; never selects another candidate or resends.'), messageId: z.string().min(1).max(300), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    z.object({ ...request, requestId, decision: z.enum(['choose', 'reveal']), purpose: z.enum(['model', 'effort', 'composer', 'submit']), snapshotId: z.string().uuid(), ref: z.string().regex(/^@e\d+$/), value: z.number().optional() }).strict(),
    z.object({ ...request, requestId, decision: z.literal('reconcile_failure'), continuationPrompt: z.literal('계속').optional().describe('Explicitly authorized same-chat continuation: preserve only an existing exact 계속 draft during idle message-timeout reconciliation. Never submits.') }).strict(),
    z.object({ ...request, requestId, decision: z.enum(['refresh', 'focus', 'latest', 'reopen']) }).strict(),
  ]),
  wait: z.object({ teamId, continuationApproved: z.literal(true).optional().describe('Authorize at most one exact same-conversation continuation per verified stopped request; live/unknown work and drafts are preserved. Broad reviews are paced at thirty minutes.'), requestRefs: z.array(requestRef).min(1), followupUserMessageId: z.string().min(1).max(300).optional().describe('Collect and officially reconcile this already-submitted follow-up separately from the original ACK; never sends or borrows its answer.'), untilResult: z.boolean().optional().describe('Keep routine observation and wait expiry inside the existing process until completion, real error or a decision; CLI/MCP default true for positive waits. False retains bounded legacy waits.'), waitMs: z.number().int().min(0).max(MAX_WORKFLOW_WAIT_MS).default(DEFAULT_WORKFLOW_WAIT_MS).transform(workflowWaitMs).describe('External wait duration; positive values round up to whole minutes, minimum one minute. Default ten minutes. Completion, real errors and decisions return immediately. Zero is an explicit snapshot read.'), outputDir: z.string().min(1).optional() }).strict(),
  stop: z.object({ ...request, requestId }).strict(),
};

export function registerWorkflowMethods(router: RpcRouter, workflow: TeamWorkflow) {
  router.register('workflow.team_delete', workflowSchemas.team_delete, (input) => workflow.deleteTeam(input));
  router.register('workflow.team_create', workflowSchemas.team_create, (input) => workflow.createTeam(input));
  router.register('workflow.team_get', workflowSchemas.team_get, (input) => workflow.getTeam(input));
  router.register('workflow.role_create', workflowSchemas.role_create, (input) => workflow.createRole(input));
  router.register('workflow.role_retire', workflowSchemas.role_retire, (input) => workflow.retireRole(input));
  router.register('workflow.session_open', workflowSchemas.session_open, (input) => workflow.openSession(input));
  router.register('workflow.session_replace', workflowSchemas.session_replace, (input) => workflow.replaceSession(input));
  router.register('workflow.session_delete', workflowSchemas.session_delete, (input) => workflow.deleteSession(input));
  router.register('workflow.send', workflowSchemas.send, (input) => workflow.send(input));
  router.register('workflow.decide', workflowSchemas.decide, (input) => workflow.decide(input));
  router.register('workflow.wait', workflowSchemas.wait, (input, context) => workflow.wait(input, context.signal));
  router.register('workflow.stop', workflowSchemas.stop, (input) => workflow.stop(input));
}
