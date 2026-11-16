import { createHash, randomUUID } from 'node:crypto';
import { SessionPlaneDomainError } from '../domain/errors.ts';

import type { ExactSendIntent } from './durable-task-kernel.ts';
import type { SemanticContextResolver } from './semantic-exact-task-port.ts';
import type {
  SemanticActionCandidate, SemanticActionPurpose, SemanticActResult,
  SemanticInput, SemanticObservation, SemanticPermissionEvidence,
  SemanticControlDescriptor, SemanticTaskContext,
} from '../providers/semantic-adapter.ts';
import { semanticConfigurationMatches } from '../providers/semantic-adapter.ts';
import type { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { DecisionRecord, TaskKernelRepository } from '../storage/task-kernel-repository.ts';

const DEFAULT_PACKET_PREVIEW_BYTES = 2 * 1024;
const DEFAULT_PACKET_OPTIONS_BYTES = 4 * 1024;
const DEFAULT_PACKET_EVIDENCE_BYTES = 4 * 1024;
const DEFAULT_PACKET_MAX_BYTES = 12 * 1024;
const DEFAULT_EVIDENCE_PAGE_BYTES = 12 * 1024;
const MAX_REASON_LENGTH = 120;

export type AgentDecisionKind =
  | 'model_choice' | 'provider_question' | 'tool_permission' | 'provider_control'
  | 'recovery_choice' | 'adapter_unsupported' | 'human_verification';

export interface AgentDecisionOption {
  readonly actionRef: string;
  readonly purpose: SemanticActionPurpose;
  readonly effect: string;
  readonly risk: SemanticActionCandidate['risk'];
  readonly evidenceHash: string;
  readonly expiresAt: string;
  readonly inputSchema: SemanticInput;
  readonly inputOptionCount?: number | undefined;
  readonly control?: SemanticControlDescriptor | undefined;
}

export type AgentTaskControlPurpose =
  | 'reobserve' | 'wait' | 'resume' | 'cancel' | 'request_human';

export interface AgentDecisionControl {
  readonly actionRef: string;
  readonly purpose: AgentTaskControlPurpose;
  readonly effect: string;
  readonly risk: 'read_only' | 'task_control' | 'human_escalation';
  readonly evidenceHash: string;
  readonly inputSchema: { readonly kind: 'none' };
}

export interface AgentDecisionEvidenceSection {
  readonly section: 'original_request' | 'current_attempt' | 'provider_question' |
    'permission' | 'partial_answer' | 'capability_issues' | 'provider_controls' |
    'decision_options';
  readonly totalBytes: number;
  readonly preview: string;
  readonly previewBytes: number;
  readonly nextCursor: number | null;
}

export interface AgentDecisionPacket {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly decisionId: string;
  readonly kind: AgentDecisionKind;
  readonly reason: string;
  readonly humanOnly: boolean;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly snapshotId: string | null;
  readonly questionText: string | null;
  readonly permission: SemanticPermissionEvidence | null;
  readonly requestedModel: string | null;
  readonly options: readonly AgentDecisionOption[];
  readonly controls: readonly AgentDecisionControl[];
  readonly evidenceSections: readonly AgentDecisionEvidenceSection[];
  readonly optionCount?: number | undefined;
  readonly observedControls: readonly SemanticControlDescriptor[];
  readonly observedControlCount?: number | undefined;
  readonly resumePoint: string;
  readonly evidenceBytes: number;
}

interface StoredProviderAction {
  readonly purpose: SemanticActionPurpose;
  readonly snapshotId: string;
  readonly actionRef: string;
  readonly evidenceHash: string;
}

interface StoredDecisionEvidence {
  readonly original_request: string;
  readonly current_attempt: string;
  readonly provider_question: string;
  readonly permission: string;
  readonly partial_answer: string;
  readonly capability_issues: string;
  readonly provider_controls: string;
  readonly decision_options: string;
}

interface StoredDecision {
  readonly kind: 'semantic_action';
  readonly context: SemanticTaskContext;
  readonly attemptId: string;
  /** v0.4.108 single-action envelope retained for durable replay compatibility. */
  readonly purpose: SemanticActionPurpose | null;
  readonly snapshotId: string | null;
  readonly actionRef: string | null;
  readonly evidenceHash: string | null;
  readonly actions?: readonly StoredProviderAction[];
  readonly allOptions?: readonly AgentDecisionOption[];
  readonly reconcilesUncertainReasoningEffort?: boolean;
  readonly evidence?: StoredDecisionEvidence;
  readonly packet: AgentDecisionPacket;
}

export type AgentDecisionOutcome =
  | { readonly kind: 'performed'; readonly effect: string }
  | { readonly kind: 'refresh_required'; readonly packet: AgentDecisionPacket | null }
  | { readonly kind: 'uncertain'; readonly reason: string };

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function preview(value: string, maxBytes = DEFAULT_PACKET_PREVIEW_BYTES): {
  text: string; bytes: number; nextCursor: number | null;
} {
  let cursor = 0;
  let bytes = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    cursor += point.length;
  }
  return { text: value.slice(0, cursor), bytes,
    nextCursor: cursor < value.length ? cursor : null };
}

function evidenceSection(
  section: AgentDecisionEvidenceSection['section'], value: string,
): AgentDecisionEvidenceSection {
  const page = preview(value);
  return { section, totalBytes: Buffer.byteLength(value, 'utf8'), preview: page.text,
    previewBytes: page.bytes, nextCursor: page.nextCursor };
}

function evidenceSections(
  evidence: StoredDecisionEvidence,
): readonly AgentDecisionEvidenceSection[] {
  let remaining = DEFAULT_PACKET_EVIDENCE_BYTES;
  const result: AgentDecisionEvidenceSection[] = [];
  for (const [section, value] of Object.entries(evidence) as Array<[
    AgentDecisionEvidenceSection['section'], string
  ]>) {
    if (value.length === 0) continue;
    const allowance = remaining <= 0 ? 0 : Math.min(1_024, remaining);
    const page = preview(value, allowance);
    result.push({
      section, totalBytes: Buffer.byteLength(value, 'utf8'), preview: page.text,
      previewBytes: page.bytes, nextCursor: page.nextCursor,
    });
    remaining -= page.bytes;
  }
  return result;
}

function compactDecisionOption(option: AgentDecisionOption): AgentDecisionOption {
  if (option.inputSchema.kind !== 'option') {
    return {
      ...option, effect: preview(option.effect, 512).text,
      ...(option.control ? { control: {
        ...option.control, contextSummary: preview(option.control.contextSummary, 512).text,
      } } : {}),
    };
  }
  const selected: Array<{ value: string; enabled: boolean }> = [];
  let bytes = 0;
  for (const candidate of option.inputSchema.options) {
    const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    if (bytes + size > 1_536) break;
    selected.push(candidate);
    bytes += size;
  }
  return {
    ...option, effect: preview(option.effect, 512).text,
    inputSchema: { kind: 'option', options: selected },
    inputOptionCount: option.inputSchema.options.length,
    ...(option.control ? { control: {
      ...option.control, contextSummary: preview(option.control.contextSummary, 512).text,
    } } : {}),
  };
}

function packetOptions(options: readonly AgentDecisionOption[]): readonly AgentDecisionOption[] {
  const selected: AgentDecisionOption[] = [];
  let bytes = 0;
  for (const option of options) {
    const compact = compactDecisionOption(option);
    const size = Buffer.byteLength(JSON.stringify(compact), 'utf8');
    if (selected.length > 0 && bytes + size > DEFAULT_PACKET_OPTIONS_BYTES) break;
    selected.push(compact);
    bytes += size;
  }
  return selected;
}

function compactObservedControls(
  controls: readonly SemanticControlDescriptor[],
): readonly SemanticControlDescriptor[] {
  const selected: SemanticControlDescriptor[] = [];
  let bytes = 0;
  for (const control of controls) {
    const compact = { ...control,
      contextSummary: preview(control.contextSummary, 256).text,
      options: control.options.slice(0, 16),
    };
    const size = Buffer.byteLength(JSON.stringify(compact), 'utf8');
    if (selected.length > 0 && bytes + size > 2_048) break;
    selected.push(compact);
    bytes += size;
  }
  return selected;
}

function boundedPacket(packet: AgentDecisionPacket): AgentDecisionPacket {
  let bounded = countBytes(packet);
  if (bounded.evidenceBytes <= DEFAULT_PACKET_MAX_BYTES) return bounded;
  bounded = countBytes({
    ...bounded,
    questionText: bounded.questionText === null ? null : preview(bounded.questionText, 512).text,
    permission: bounded.permission === null ? null : {
      ...bounded.permission,
      visibleSummary: preview(bounded.permission.visibleSummary, 512).text,
      argumentsSummary: bounded.permission.argumentsSummary === null ? null
        : preview(bounded.permission.argumentsSummary, 512).text,
    },
    evidenceSections: bounded.evidenceSections.map(section => ({
      ...section, preview: '', previewBytes: 0,
      nextCursor: section.totalBytes > 0 ? 0 : null,
    })),
    observedControls: [],
    evidenceBytes: 0,
  });
  return bounded;
}

function decisionControls(
  decisionId: string, reason: string, humanOnly: boolean,
): readonly AgentDecisionControl[] {
  const controls: Array<{ purpose: AgentTaskControlPurpose; effect: string;
    risk: AgentDecisionControl['risk'] }> = [
    { purpose: 'reobserve', effect: 'Read the latest exact task and provider state', risk: 'read_only' },
    { purpose: 'wait', effect: 'Resume read-only observation without performing a provider mutation', risk: 'read_only' },
    { purpose: 'cancel', effect: 'Request cancellation of this exact task', risk: 'task_control' },
  ];
  if (!humanOnly) controls.push({
    purpose: 'request_human', effect: 'Escalate this exact decision with its evidence to a person',
    risk: 'human_escalation',
  });
  if (reason === 'managed-continuation-no-final-after-approved-continue' ||
      reason === 'managed-continuation-no-progress-policy-reached' ||
      reason === 'managed-continuation-safe-send-unavailable') {
    controls.splice(2, 0, {
      purpose: 'resume',
      effect: 'Re-enter the approved continuation flow for this exact task',
      risk: 'task_control',
    });
  }
  return controls.map(control => ({
    actionRef: `control:${decisionId}:${control.purpose}`,
    purpose: control.purpose, effect: control.effect, risk: control.risk,
    evidenceHash: sha(JSON.stringify({ decisionId, reason, purpose: control.purpose })),
    inputSchema: { kind: 'none' },
  }));
}

function countBytes(packet: AgentDecisionPacket): AgentDecisionPacket {
  let size = Buffer.byteLength(JSON.stringify(packet));
  while (true) {
    const actual = Buffer.byteLength(JSON.stringify({ ...packet, evidenceBytes: size }));
    if (actual === size) return { ...packet, evidenceBytes: size };
    size = actual;
  }
}

function boundedReason(reason: string | null): string {
  return reason !== null && reason.length <= MAX_REASON_LENGTH &&
    /^[a-z0-9_.:-]+$/i.test(reason) ? reason : 'semantic-evidence-requires-review';
}

function selectionIsValid(schema: SemanticInput, value: string | undefined): boolean {
  if (schema.kind === 'none') return value === undefined;
  if (schema.kind === 'text') return typeof value === 'string' &&
    value.length > 0 && value.length <= schema.maxLength;
  return typeof value === 'string' &&
    schema.options.some(option => option.value === value && option.enabled);
}

/**
 * Detect a prior reasoning-effort effect whose outcome was not confirmed. A
 * stale pre-existing action remains blocked, but a fresh exact observation may
 * publish a new current-state action. Configuration effects are reconciled by
 * observing the current selector, never by permanently sealing the Task.
 */
function priorUncertainReasoningEffort(decisions: readonly DecisionRecord[]): boolean {
  for (const row of decisions) {
    if (row.status !== 'resolved') continue;
    let stored: StoredDecision;
    try { stored = storedContext(row.contextJson); }
    catch { return true; } // Malformed durable decision history fails closed.
    const hasEffort = stored.purpose === 'choose_reasoning_effort' ||
      stored.actions?.some(action => action.purpose === 'choose_reasoning_effort') === true;
    if (!hasEffort) continue;
    if (row.resolutionJson === null) return true;
    let receipt: Record<string, unknown>;
    try { receipt = JSON.parse(row.resolutionJson) as Record<string, unknown>; }
    catch { return true; }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return true;
    // Read-only refresh has no provider mutation. A failed refresh may publish
    // a fresh, *still unconsumed* option with a distinct decisionId.
    if (receipt.kind === 'read_only_refresh' && !row.actionConsumed) continue;
    if (receipt.kind !== 'semantic_action' || !receipt.outcome ||
        typeof receipt.outcome !== 'object') return true;
    const outcome = receipt.outcome as { kind?: unknown; effect?: unknown };
    if (outcome.kind === 'performed' && row.actionConsumed &&
        outcome.effect === 'reasoning_effort_selected') continue;
    const kind = outcome.kind;
    if (kind === 'refresh_required' && !row.actionConsumed) continue;
    return true; // uncertain, malformed or action-consumption mismatch
  }
  return false;
}

function matchingActions(
  observation: SemanticObservation, purposes: readonly SemanticActionPurpose[],
): readonly SemanticActionCandidate[] {
  return observation.actions.filter(action => purposes.includes(action.purpose));
}

function decisionKind(
  observation: SemanticObservation, modelChoice: boolean,
): AgentDecisionKind | null {
  switch (observation.blocker) {
    case 'provider_question': return 'provider_question';
    case 'provider_permission': return 'tool_permission';
    case 'provider_control': return 'provider_control';
    case 'provider_retry':
    case 'rate_limit': return 'recovery_choice';
    case 'human_verification': return 'human_verification';
    case 'unsupported': return 'adapter_unsupported';
    case 'none': return modelChoice ? 'model_choice' : null;
  }
}

function storedContext(value: string): StoredDecision {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== 'object' ||
      (parsed as Partial<StoredDecision>).kind !== 'semantic_action' ||
      !(parsed as Partial<StoredDecision>).packet ||
      !(parsed as Partial<StoredDecision>).context) {
    throw new Error('Invalid durable semantic decision envelope');
  }
  return parsed as StoredDecision;
}

function replayDecisionOutcome(
  resolutionJson: string | null,
  input: { requestId: string; actionRef: string; inputValue: string | null },
): AgentDecisionOutcome {
  const value: unknown = resolutionJson === null ? null : JSON.parse(resolutionJson);
  if (!value || typeof value !== 'object') {
    throw new SessionPlaneDomainError('idempotency_conflict', 'Decision already resolved by a different request');
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.kind !== 'semantic_action' || receipt.requestId !== input.requestId ||
      receipt.actionRef !== input.actionRef || receipt.input !== input.inputValue) {
    throw new SessionPlaneDomainError('idempotency_conflict', 'Decision already resolved by a different request');
  }
  // The decision grant is irreversibly reserved before the adapter acts.
  // Neither a consumed bit nor the resolution alone proves its effect.
  const recorded = receipt.outcome;
  if (!recorded || typeof recorded !== 'object') {
    return { kind: 'uncertain', reason: 'decision-effect-receipt-pending' };
  }
  const outcome = recorded as Record<string, unknown>;
  if (outcome.kind === 'performed' && typeof outcome.effect === 'string') {
    return { kind: 'performed', effect: outcome.effect };
  }
  if (outcome.kind === 'uncertain' && typeof outcome.reason === 'string') {
    return { kind: 'uncertain', reason: outcome.reason };
  }
  if (outcome.kind === 'refresh_required' &&
      (outcome.packet === null || (outcome.packet && typeof outcome.packet === 'object'))) {
    return { kind: 'refresh_required', packet: outcome.packet as AgentDecisionPacket | null };
  }
  throw new Error('Invalid persisted decision outcome');
}

/**
 * Agent-facing bridge. The provider still owns UI semantics, and SQLite still
 * owns the one-shot decision/reducer. Neither DOM selectors nor a new Task
 * state machine are introduced here.
 */
export class SemanticDecisionGateway {
  readonly #repository: TaskKernelRepository;
  readonly #providers: SemanticProviderRegistry;
  readonly #resolveContext: SemanticContextResolver;
  readonly #onTaskResumed: ((input: {
    taskId: string; clientId: string; attemptId: string;
    mode: 'wait' | 'resume' | 'provider_effect';
  }) => Promise<void>) | undefined;

  constructor(input: {
    repository: TaskKernelRepository;
    providers: SemanticProviderRegistry;
    resolveContext: SemanticContextResolver;
    onTaskResumed?: (input: {
      taskId: string; clientId: string; attemptId: string;
      mode: 'wait' | 'resume' | 'provider_effect';
    }) => Promise<void>;
  }) {
    this.#repository = input.repository;
    this.#providers = input.providers;
    this.#resolveContext = input.resolveContext;
    this.#onTaskResumed = input.onTaskResumed;
  }

  /** Reconnection needs only Task identity, not a live browser or caller wait. */
  get(taskId: string, clientId: string): AgentDecisionPacket | null {
    const full = this.#repository.getFullTask(taskId, clientId);
    if (full.task.pendingDecisionId === null) return null;
    const decision = full.decisions.find(row => row.decisionId === full.task.pendingDecisionId);
    if (!decision || decision.status !== 'pending') {
      throw new Error('Durable pending decision is missing');
    }
    return { ...storedContext(decision.contextJson).packet,
      taskRevision: full.task.revision };
  }

  readEvidence(input: {
    taskId: string; clientId: string; decisionId: string;
    section: AgentDecisionEvidenceSection['section'];
    cursor?: number; maxBytes?: number;
  }): {
    decisionId: string; section: AgentDecisionEvidenceSection['section'];
    cursor: number; text: string; returnedBytes: number;
    totalBytes: number; nextCursor: number | null;
  } {
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    const row = full.decisions.find(decision => decision.decisionId === input.decisionId);
    if (!row) throw new SessionPlaneDomainError('stale_decision', 'Unknown decision identity');
    const stored = storedContext(row.contextJson);
    const value = stored.evidence?.[input.section] ?? '';
    const cursor = input.cursor ?? 0;
    const maxBytes = input.maxBytes ?? DEFAULT_EVIDENCE_PAGE_BYTES;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > value.length ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 64 * 1024) {
      throw new SessionPlaneDomainError('invalid_request', 'Invalid decision evidence page');
    }
    const page = preview(value.slice(cursor), maxBytes);
    return {
      decisionId: input.decisionId, section: input.section, cursor,
      text: page.text, returnedBytes: page.bytes,
      totalBytes: Buffer.byteLength(value, 'utf8'),
      nextCursor: page.nextCursor === null ? null : cursor + page.nextCursor,
    };
  }

  /** A no-progress Continue, an unsendable approved Continue, or a foreign
   * later user turn must move to an agent before another speculative POST.
   * The durable packet grants no executable provider action.
   */
  async requireNoProgressReview(input: {
    taskId: string; clientId: string; attemptId: string;
    cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress';
  }): Promise<AgentDecisionPacket | null> {
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    if (full.task.pendingDecisionId !== null) return this.get(input.taskId, input.clientId);
    if (full.task.cancelRequested || full.task.state !== 'working') return null;
    const attempt = full.attempts.find(row => row.attemptId === input.attemptId);
    const latest = full.attempts.filter(row => row.kind !== 'stop').at(-1);
    if (!attempt || latest?.attemptId !== attempt.attemptId ||
        full.results.some(row => row.attemptId === attempt.attemptId)) {
      throw new Error('Agent review requires the current unanswered exact attempt');
    }
    const previous = full.attempts.find(row => row.sequence === attempt.sequence - 1);
    const acknowledged = attempt.state === 'acknowledged' &&
      attempt.externalTurnId !== null &&
      (attempt.kind === 'continuation' || attempt.kind === 'initial');
    const unableToSend = attempt.kind === 'continuation' &&
      attempt.state === 'planned' && attempt.dispatchedAt === null &&
      previous?.state === 'acknowledged' && previous.externalTurnId !== null &&
      previous.kind !== 'stop' &&
      !full.results.some(row => row.attemptId === previous.attemptId);
    if (!acknowledged && !unableToSend) {
      throw new Error('Agent review requires an unanswered ACK or an unsent approved Continue');
    }
    const slot = this.#repository.getSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      throw new Error('Agent review lost the exact Task slot');
    }
    const binding = this.#repository.getBindingAtRevision(
      full.task.projectId, full.task.slotId, full.task.slotRevision, input.clientId);
    const intent: ExactSendIntent = {
      taskId: input.taskId, clientId: input.clientId,
      projectId: full.task.projectId, slotId: full.task.slotId,
      slotRevision: full.task.slotRevision,
      providerConversationId: binding.providerConversationId,
      attemptId: attempt.attemptId, kind: attempt.kind, content: attempt.content,
    };
    let context: SemanticTaskContext;
    try { context = await this.#resolveContext(intent); }
    catch {
      // A lost tab must not prevent a durable agent handoff. Only immutable
      // Task/ACK facts are retained; the packet has no executable action.
      context = {
        projectId: full.task.projectId, slotId: full.task.slotId,
        slotRevision: full.task.slotRevision, taskId: input.taskId,
        providerConversationId: binding.providerConversationId,
        submittedUserMessageId: null,
        submittedUserTurnId: attempt.externalTurnId ?? previous?.externalTurnId ?? null,
        pageLease: null,
      };
    }
    if (context.taskId !== input.taskId || context.projectId !== full.task.projectId ||
        context.slotId !== full.task.slotId ||
        context.slotRevision !== full.task.slotRevision ||
        context.providerConversationId !== binding.providerConversationId) {
      throw new Error('No-progress review context changed its canonical identity');
    }
    const now = new Date().toISOString();
    const decisionId = randomUUID();
    const reason = input.cause === 'persistent_backend_read_throttle'
      ? 'canonical-final-rate-limit-persistent'
      : input.cause === 'repeated_no_progress'
        ? 'managed-continuation-no-progress-policy-reached'
        : attempt.kind === 'initial' ? 'managed-continuation-later-user-boundary'
      : unableToSend ? 'managed-continuation-safe-send-unavailable'
        : 'managed-continuation-no-final-after-approved-continue';
    const evidence: StoredDecisionEvidence = {
      original_request: full.task.originalPrompt,
      current_attempt: JSON.stringify({
        attemptId: attempt.attemptId, sequence: attempt.sequence, kind: attempt.kind,
        state: attempt.state, content: attempt.content,
        dispatchedAt: attempt.dispatchedAt, acknowledgedAt: attempt.acknowledgedAt,
        previousAttemptId: previous?.attemptId ?? null,
        attemptHistory: full.attempts.filter(row => row.kind !== 'stop').map(row => ({
          attemptId: row.attemptId, sequence: row.sequence, kind: row.kind,
          state: row.state, dispatchedAt: row.dispatchedAt,
          acknowledgedAt: row.acknowledgedAt, externalTurnId: row.externalTurnId,
          hasFinal: full.results.some(result => result.attemptId === row.attemptId),
        })),
      }, null, 2),
      provider_question: '', permission: '', partial_answer: '', capability_issues: '',
      provider_controls: '', decision_options: '[]',
    };
    const packet = boundedPacket({
      taskId: input.taskId, taskRevision: full.task.revision + 1, decisionId,
      kind: 'recovery_choice', reason,
      humanOnly: false, observedAt: now,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      snapshotId: null, questionText: null, permission: null,
      requestedModel: null, options: [], optionCount: 0,
      controls: decisionControls(decisionId, reason, false),
      evidenceSections: evidenceSections(evidence),
      observedControls: [], observedControlCount: 0,
      resumePoint: unableToSend
        ? 'retry the existing planned continuation through the Core-owned due path'
        : 'observe the same exact acknowledged turn and continue this task',
      evidenceBytes: 0,
    });
    const envelope: StoredDecision = {
      kind: 'semantic_action', context, attemptId: attempt.attemptId,
      purpose: null, snapshotId: null, actionRef: null,
      evidenceHash: null, actions: [], allOptions: [], evidence, packet,
    };
    try {
      this.#repository.requireDecision({
        taskId: input.taskId, clientId: input.clientId, decisionId,
        audience: 'agent', contextJson: JSON.stringify(envelope),
      });
    } catch (error) {
      const current = this.get(input.taskId, input.clientId);
      if (current !== null) return current;
      throw error;
    }
    return this.get(input.taskId, input.clientId);
  }

  /**
   * One read-only fresh model-state check before an initial send. Failure is
   * converted into an agent packet; a previous successful chooser click does
   * not authorize a later Submit by itself.
   */
  async verifyModelIntent(input: {
    taskId: string; clientId: string; attemptId: string; modelIntent: string;
  }): Promise<boolean> {
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    if (full.task.state !== 'working' || full.task.cancelRequested ||
        full.task.pendingDecisionId !== null) return false;
    const attempt = full.attempts.find(a => a.attemptId === input.attemptId);
    const slot = this.#repository.getSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (!attempt || attempt.kind !== 'initial' || attempt.state !== 'planned' ||
        slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) return false;
    const provider = this.#providers.resolve(slot.providerKey, 'conversation');
    if (provider.kind !== 'available') return false;
    const context = await this.#resolveContext({
      taskId: input.taskId, clientId: input.clientId,
      projectId: full.task.projectId, slotId: full.task.slotId,
      slotRevision: full.task.slotRevision,
      providerConversationId: slot.providerConversationId,
      attemptId: attempt.attemptId, kind: attempt.kind, content: attempt.content,
    });
    if (context.requiredModel !== input.modelIntent || context.pageLease === null) {
      return false;
    }
    try {
      const observed = await provider.adapter.observe(context);
      if (observed.providerKey === provider.adapter.providerKey &&
          observed.surface === 'chat' && observed.blocker === 'none' &&
          observed.progress !== 'streaming' &&
          semanticConfigurationMatches(
            provider.adapter.providerKey, input.modelIntent, observed)) return true;
    } catch { /* Re-examine the latest observed blocker as an agent decision. */ }
    await this.inspect({ ...input, modelChoice: true });
    return false;
  }

  /** Only a blocker or an explicitly requested model choice creates a packet. */
  async inspect(input: {
    taskId: string; clientId: string; attemptId: string;
    modelChoice?: boolean;
    modelIntent?: string;
  }): Promise<AgentDecisionPacket | null> {
    if (input.modelIntent !== undefined &&
        (input.modelChoice !== true ||
         input.modelIntent.trim().length === 0 || input.modelIntent.length > 200)) {
      throw new Error('Invalid bounded model intent');
    }
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    if (full.task.pendingDecisionId !== null) return this.get(input.taskId, input.clientId);
    if (full.task.state !== 'working' || full.task.cancelRequested) return null;
    const attempt = full.attempts.find(row => row.attemptId === input.attemptId);
    if (!attempt || attempt.kind === 'stop') throw new Error('Exact active attempt required');
    const slot = this.#repository.getSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      return null;
    }
    const binding = this.#repository.getBindingAtRevision(
      full.task.projectId, full.task.slotId, full.task.slotRevision, input.clientId);
    const intent: ExactSendIntent = {
      taskId: full.task.taskId, projectId: full.task.projectId,
      slotId: full.task.slotId, slotRevision: full.task.slotRevision,
      providerConversationId: binding.providerConversationId, clientId: input.clientId,
      attemptId: attempt.attemptId, kind: attempt.kind, content: attempt.content,
    };
    const context = await this.#resolveContext(intent);
    if (context.taskId !== input.taskId || context.projectId !== full.task.projectId ||
        context.slotId !== full.task.slotId || context.slotRevision !== full.task.slotRevision ||
        context.providerConversationId !== binding.providerConversationId) {
      throw new Error('Semantic decision context does not belong to the active Task');
    }
    const provider = this.#providers.resolve(binding.providerKey, 'conversation');
    if (provider.kind === 'available' &&
        provider.adapter.capabilities.browserRequired && context.pageLease === null) {
      return null; // Preparation, not a human-only barrier.
    }
    let observation: SemanticObservation | null = null;
    if (provider.kind === 'available') {
      try { observation = await provider.adapter.observe(context); }
      catch { /* A technical observation failure is an agent review, not human approval. */ }
    }
    if (observation && (observation.providerKey !== binding.providerKey ||
        observation.capabilityManifest.providerKey !== binding.providerKey ||
        observation.capabilityManifest.contractVersion !== 1)) {
      observation = null;
    }
    const kind = observation ? decisionKind(observation, input.modelChoice === true)
      : 'adapter_unsupported';
    if (kind === null) return null;
    const purposes: SemanticActionPurpose[] = kind === 'provider_question'
      ? ['answer_question'] : kind === 'model_choice'
        ? ['open_model_chooser', 'close_model_chooser',
          'choose_model', 'choose_reasoning_effort'] : kind === 'tool_permission'
          ? ['grant_permission', 'decline_permission'] : kind === 'provider_control'
            ? ['activate_control', 'set_control_value'] : kind === 'recovery_choice'
            ? ['retry'] : [];
    const uncertainEffort = kind === 'model_choice' &&
      priorUncertainReasoningEffort(full.decisions);
    const actions = observation ? matchingActions(observation, purposes) : [];
    const reconcilesUncertainReasoningEffort = uncertainEffort &&
      actions.some(action => action.purpose === 'choose_reasoning_effort');
    const now = new Date().toISOString();
    const decisionId = randomUUID();
    const options: AgentDecisionOption[] = actions.map(action => ({
      actionRef: action.actionRef, purpose: action.purpose, effect: action.effect,
      risk: action.risk, evidenceHash: action.evidenceHash,
      expiresAt: action.expiresAt, inputSchema: action.input,
      ...(action.control ? { control: { ...action.control,
        contextSummary: preview(action.control.contextSummary).text } } : {}),
    }));
    const reason = reconcilesUncertainReasoningEffort
      ? 'reasoning-effort-current-state-reobserved'
      : observation ? boundedReason(observation.reason) :
        provider.kind === 'unsupported' ? provider.reason : 'semantic-observation-unavailable';
    const humanOnly = kind === 'human_verification';
    const permissionPreview = observation?.permission ? {
      ...observation.permission,
      visibleSummary: preview(observation.permission.visibleSummary).text,
      argumentsSummary: observation.permission.argumentsSummary === null ? null
        : preview(observation.permission.argumentsSummary).text,
    } : null;
    const observedControlPreviews = (observation?.controls ?? []).map(control => ({
      ...control, contextSummary: preview(control.contextSummary).text,
    }));
    const evidence: StoredDecisionEvidence = {
      original_request: full.task.originalPrompt,
      current_attempt: JSON.stringify({
        attemptId: attempt.attemptId, sequence: attempt.sequence, kind: attempt.kind,
        state: attempt.state, content: attempt.content,
        dispatchedAt: attempt.dispatchedAt, acknowledgedAt: attempt.acknowledgedAt,
      }, null, 2),
      provider_question: observation?.questionText ?? '',
      permission: observation?.permission ? JSON.stringify(observation.permission, null, 2) : '',
      partial_answer: observation?.turn.partialAnswer ?? '',
      capability_issues: observation?.capabilityIssues
        ? JSON.stringify(observation.capabilityIssues, null, 2) : '',
      provider_controls: observation?.controls?.length
        ? JSON.stringify(observation.controls, null, 2) : '',
      decision_options: JSON.stringify(options, null, 2),
    };
    const sections = evidenceSections(evidence);
    const questionPage = preview(evidence.provider_question);
    const packetOptionPage = packetOptions(options);
    const controlPage = compactObservedControls(observation?.controls ?? []);
    let packet: AgentDecisionPacket = {
      taskId: input.taskId, taskRevision: full.task.revision + 1, decisionId,
      kind, reason, humanOnly,
      observedAt: observation?.observedAt ?? now,
      expiresAt: options.length > 0
        ? options.map(option => option.expiresAt).sort()[0]!
        : new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      snapshotId: observation?.snapshotId ?? null,
      questionText: kind === 'provider_question' ? questionPage.text || null : null,
      permission: kind === 'tool_permission' ? permissionPreview : null,
      requestedModel: kind === 'model_choice' ? input.modelIntent ?? null : null,
      options: packetOptionPage, optionCount: options.length,
      controls: decisionControls(decisionId, reason, humanOnly),
      evidenceSections: sections, observedControls: controlPage,
      observedControlCount: observation?.controls?.length ?? 0,
      resumePoint: 'return to the same task, exact conversation and current attempt after the selected effect',
      evidenceBytes: 0,
    };
    packet = boundedPacket(packet);
    const storedActions: StoredProviderAction[] = options.map(option => ({
      purpose: option.purpose, snapshotId: packet.snapshotId!,
      actionRef: option.actionRef, evidenceHash: option.evidenceHash,
    }));
    const compatibilityOption = options.length === 1 ? options[0]! : null;
    const envelope: StoredDecision = {
      kind: 'semantic_action', context, attemptId: input.attemptId,
      purpose: compatibilityOption?.purpose ?? null,
      snapshotId: packet.snapshotId,
      actionRef: compatibilityOption?.actionRef ?? null,
      evidenceHash: compatibilityOption?.evidenceHash ?? null,
      actions: storedActions, allOptions: options,
      ...(reconcilesUncertainReasoningEffort
        ? { reconcilesUncertainReasoningEffort: true } : {}),
      evidence, packet,
    };
    try {
      this.#repository.requireDecision({
        taskId: input.taskId, clientId: input.clientId, decisionId,
        audience: packet.humanOnly ? 'human' : 'agent',
        contextJson: JSON.stringify(envelope),
      });
    } catch (error) {
      // Parallel inspectors must not issue a second packet for one Task.
      const current = this.get(input.taskId, input.clientId);
      if (current !== null) return current;
      throw error;
    }
    return { ...packet, taskRevision: this.#repository.getTask(input.taskId, input.clientId).revision };
  }

  /** Explicit read-only refresh after restart/expiry; never replays an action. */
  async refresh(input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    modelChoice?: boolean; requestId?: string;
  }): Promise<AgentDecisionPacket | null> {
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    if (full.task.pendingDecisionId !== input.decisionId) {
      throw new Error('Only the current pending decision may be refreshed');
    }
    const current = full.decisions.find(row => row.decisionId === input.decisionId);
    if (!current) throw new Error('Missing exact decision for refresh');
    const original = storedContext(current.contextJson);
    if (original.attemptId !== input.attemptId) {
      throw new Error('Decision refresh belongs to another exact attempt');
    }
    const requestedModel = original.packet.requestedModel ??
      (input.modelChoice === true ? original.context.requiredModel ?? null : null);
    this.#repository.resolveDecision({
      taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
      resolutionJson: JSON.stringify({ kind: 'read_only_refresh',
        ...(input.requestId ? { requestId: input.requestId } : {}) }),
    });
    if (requestedModel && original.packet.kind === 'model_choice') {
      // An externally selected, exact model/effort can clear a stale pending
      // chooser without replaying a prior uncertain pointer click. This does
      // not approve a send: the Core dispatch port will independently observe
      // the model again before spending the originally planned attempt.
      try {
        if (await this.verifyModelIntent({
          taskId: input.taskId, clientId: input.clientId,
          attemptId: input.attemptId, modelIntent: requestedModel,
        })) return null;
      } catch { /* Fall back to a fresh blocked read-only packet. */ }
      const existing = this.get(input.taskId, input.clientId);
      if (existing !== null) return existing;
    }
    return await this.inspect({ taskId: input.taskId, clientId: input.clientId,
      attemptId: input.attemptId,
      modelChoice: original.packet.kind === 'model_choice' || input.modelChoice === true,
      ...(requestedModel ? { modelIntent: requestedModel } : {}) });
  }

  /**
   * Public read-only reinspection of an unactionable or expired model packet.
   * No browser click, permission, retry or submission can be granted here.
   * The request identity is durable so a lost response never repeats an effect.
   */
  async refreshCurrent(input: {
    taskId: string; clientId: string; decisionId: string; requestId: string;
  }): Promise<AgentDecisionOutcome> {
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    const row = full.decisions.find(decision => decision.decisionId === input.decisionId);
    if (!row) throw new SessionPlaneDomainError('stale_decision', 'Unknown decision identity');
    const original = storedContext(row.contextJson);
    const originalAttempt = full.attempts.find(
      attempt => attempt.attemptId === original.attemptId);
    if (!original.attemptId || !originalAttempt) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision lost its exact attempt');
    }
    // Explicitly refresh only bounded, unsubmitted, exact page observations.
    // A page-load error is not permission to send or navigate again.
    const stalledContinuation =
      original.packet.kind === 'recovery_choice' &&
      original.packet.options.length === 0 && !original.packet.humanOnly &&
      (((original.packet.reason === 'managed-continuation-no-final-after-approved-continue' ||
         original.packet.reason === 'managed-continuation-no-progress-policy-reached') &&
        originalAttempt.kind === 'continuation' && originalAttempt.state === 'acknowledged') ||
       (original.packet.reason === 'managed-continuation-safe-send-unavailable' &&
        originalAttempt.kind === 'continuation' && originalAttempt.state === 'planned') ||
       (original.packet.reason === 'managed-continuation-later-user-boundary' &&
        originalAttempt.kind === 'initial' && originalAttempt.state === 'acknowledged') ||
       // A policy-authorized persistent 429 review has no provider mutation.
       // Only an explicit read-only agent refresh releases its durable hold.
       (original.packet.reason === 'canonical-final-rate-limit-persistent' &&
        (originalAttempt.kind === 'initial' || originalAttempt.kind === 'continuation') &&
        originalAttempt.state === 'acknowledged'));
    // A cold owned Pro root can be unverified before its Chat composer hydrates.
    // Refresh only that exact unsent root; an actual Work surface stays blocked.
    const transientRootObservation =
      original.packet.kind === 'adapter_unsupported' &&
      (original.packet.reason === 'semantic-observation-superseded-by-page-operation' ||
       original.packet.reason === 'chat-surface-unverified') &&
      original.packet.options.length === 0 && !original.packet.humanOnly &&
      original.context.requiredModel === 'Pro' &&
      original.context.providerConversationId === null &&
      original.context.submittedUserMessageId === null &&
      original.context.submittedUserTurnId === null &&
      original.context.pageLease !== null &&
      originalAttempt.kind === 'initial' && originalAttempt.state === 'planned';
    const transientBoundSurface =
      original.packet.kind === 'adapter_unsupported' &&
      original.packet.reason === 'chat-surface-unverified' &&
      original.packet.options.length === 0 && !original.packet.humanOnly &&
      original.context.providerConversationId !== null &&
      original.context.pageLease !== null &&
      original.context.submittedUserMessageId === null &&
      original.context.submittedUserTurnId === null &&
      originalAttempt.kind === 'initial' && originalAttempt.state === 'planned';
    const receipt = row.resolutionJson === null ? null
      : JSON.parse(row.resolutionJson) as Record<string, unknown>;
    if (row.status === 'resolved') {
      if (receipt?.kind !== 'read_only_refresh' || receipt.requestId !== input.requestId) {
        throw new SessionPlaneDomainError('stale_decision', 'Decision refreshed by a different request');
      }
      // A crash after the durable receipt but before reinspection cannot strand
      // this Task. A replay can only observe, never perform a provider action.
      let next = this.get(input.taskId, input.clientId);
      if (next === null && full.task.state === 'working' &&
          !full.task.cancelRequested &&
          (originalAttempt.state === 'planned' || stalledContinuation)) {
        if (original.packet.kind === 'model_choice' && original.packet.requestedModel) {
          try {
            if (await this.verifyModelIntent({
              taskId: input.taskId, clientId: input.clientId,
              attemptId: original.attemptId, modelIntent: original.packet.requestedModel,
            })) return { kind: 'refresh_required', packet: null };
          } catch { /* Fall through to read-only inspection. */ }
          next = this.get(input.taskId, input.clientId);
        }
        if (next === null) next = await this.inspect({
          taskId: input.taskId, clientId: input.clientId, attemptId: original.attemptId,
          modelChoice: original.packet.kind === 'model_choice' || transientRootObservation,
          ...(original.packet.requestedModel || (transientRootObservation ? original.context.requiredModel : null)
            ? { modelIntent: (original.packet.requestedModel ??
              original.context.requiredModel)! } : {}),
        });
      }
      if (next === null && original.packet.reason === 'managed-continuation-safe-send-unavailable') {
        this.#scheduleUnsentContinuationReview(input.taskId, input.clientId, input.decisionId);
      }
      return { kind: 'refresh_required', packet: next };
    }
    const packet = original.packet;
    const option = packet.options[0];
    if (row.status !== 'pending' || full.task.pendingDecisionId !== input.decisionId ||
        full.task.cancelRequested ||
        (packet.kind !== 'model_choice' && !transientRootObservation &&
         !transientBoundSurface && !stalledContinuation) ||
        packet.humanOnly ||
        (packet.kind === 'model_choice' && !packet.requestedModel) ||
        packet.options.length > 1 ||
        (option !== undefined &&
          (!Number.isFinite(Date.parse(option.expiresAt)) ||
           Date.now() <= Date.parse(option.expiresAt)))) {
      throw new SessionPlaneDomainError('stale_decision', 'Current decision is not refreshable');
    }
    const slot = this.#repository.getSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision lost its active slot');
    }
    try {
      const next = await this.refresh({ ...input, attemptId: original.attemptId,
        modelChoice: transientRootObservation });
      if (next === null && original.packet.reason === 'managed-continuation-safe-send-unavailable') {
        this.#scheduleUnsentContinuationReview(input.taskId, input.clientId, input.decisionId);
      }
      return { kind: 'refresh_required', packet: next };
    } catch (error) {
      // Concurrent identical refreshes may race the SQLite reservation. Only
      // the winning exact request may retrieve the newly observed decision.
      const latest = this.#repository.getFullTask(input.taskId, input.clientId)
        .decisions.find(decision => decision.decisionId === input.decisionId);
      const resolved = latest?.resolutionJson
        ? (JSON.parse(latest.resolutionJson) as Record<string, unknown>) : null;
      if (latest?.status === 'resolved' &&
          resolved?.kind === 'read_only_refresh' && resolved.requestId === input.requestId) {
        return { kind: 'refresh_required', packet: this.get(input.taskId, input.clientId) };
      }
      throw error;
    }
  }

  /**
   * Read-only agent refresh never sends. If the original approved Continue
   * was never attempted, restore one Core-owned retry review from the exact
   * fired timer, without minting a new request/attempt/approval.
   */
  #scheduleUnsentContinuationReview(taskId: string, clientId: string, decisionId: string): void {
    const full = this.#repository.getFullTask(taskId, clientId);
    if (full.task.cancelRequested || full.task.state !== 'working' ||
        full.task.pendingDecisionId !== null) return;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (latest?.kind !== 'continuation' || latest.state !== 'planned' ||
        latest.dispatchedAt !== null) return;
    const source = full.attempts.find(row => row.sequence === latest.sequence - 1);
    if (source?.state !== 'acknowledged' || source.externalTurnId === null ||
        full.results.some(row => row.attemptId === source.attemptId)) return;
    const timerId = 'continuation-agent-resume:' + decisionId;
    if (full.timers.some(row => row.timerId === timerId)) return;
    const original = full.timers.find(timer => {
      if (timer.kind !== 'continuation_due') return false;
      try {
        const context: unknown = JSON.parse(timer.contextJson);
        return context !== null && typeof context === 'object' &&
          (context as { contract?: unknown; sourceAttemptId?: unknown }).contract ===
            'approved_continuation_v1' &&
          (context as { sourceAttemptId?: unknown }).sourceAttemptId === source.attemptId;
      } catch { return false; }
    });
    if (!original) return; // A packet alone does not invent authorization.
    this.#repository.scheduleTimer({
      taskId, clientId, timerId, kind: 'continuation_due',
      dueAt: new Date(Date.now() + 30_000).toISOString(),
      contextJson: original.contextJson,
    });
  }

  async #decideControl(input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
    stored: StoredDecision; control: AgentDecisionControl;
  }): Promise<AgentDecisionOutcome> {
    const normalized = input.input ?? null;
    if (input.control.purpose === 'request_human') {
      const nextDecisionId = randomUUID();
      const reason = 'agent-requested-human-assistance';
      const currentRevision = this.#repository.getTask(input.taskId, input.clientId).revision;
      const packet = boundedPacket({
        ...input.stored.packet,
        decisionId: nextDecisionId,
        taskRevision: currentRevision + 4,
        kind: 'human_verification', reason, humanOnly: true,
        observedAt: new Date().toISOString(), options: [], optionCount: 0,
        controls: decisionControls(nextDecisionId, reason, true),
        resumePoint: 'return to this exact task after the requested human action is confirmed',
        evidenceBytes: 0,
      });
      const envelope: StoredDecision = {
        ...input.stored, purpose: null, snapshotId: null,
        actionRef: null, evidenceHash: null, actions: [], allOptions: [], packet,
      };
      try {
        this.#repository.escalateDecisionToHuman({
          taskId: input.taskId, clientId: input.clientId,
          decisionId: input.decisionId, requestId: input.requestId,
          actionRef: input.actionRef, inputValue: normalized,
          nextDecisionId, nextContextJson: JSON.stringify(envelope),
        });
      } catch (error) {
        const current = this.#repository.getFullTask(input.taskId, input.clientId)
          .decisions.find(row => row.decisionId === input.decisionId);
        if (current?.status === 'resolved') {
          return replayDecisionOutcome(current.resolutionJson, {
            requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
          });
        }
        throw error;
      }
      return { kind: 'performed', effect: 'human_assistance_requested' };
    }
    try {
      this.#repository.resolveDecision({
        taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
        resolutionJson: JSON.stringify({
          kind: 'semantic_action', requestId: input.requestId,
          actionRef: input.actionRef, input: normalized,
        }),
      });
    } catch (error) {
      const current = this.#repository.getFullTask(input.taskId, input.clientId)
        .decisions.find(row => row.decisionId === input.decisionId);
      if (current?.status === 'resolved') {
        return replayDecisionOutcome(current.resolutionJson, {
          requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
        });
      }
      throw error;
    }
    if (!this.#repository.consumeDecisionAction(
      input.taskId, input.clientId, input.decisionId)) {
      return { kind: 'uncertain', reason: 'task-control-consumption-unavailable' };
    }

    let outcome: AgentDecisionOutcome;
    try {
      switch (input.control.purpose) {
        case 'reobserve': {
          if (input.stored.packet.kind === 'model_choice' &&
              input.stored.packet.requestedModel &&
              await this.verifyModelIntent({
                taskId: input.taskId, clientId: input.clientId,
                attemptId: input.attemptId,
                modelIntent: input.stored.packet.requestedModel,
              })) {
            outcome = { kind: 'refresh_required', packet: null };
            break;
          }
          const packet = await this.inspect({
            taskId: input.taskId, clientId: input.clientId, attemptId: input.attemptId,
            modelChoice: input.stored.packet.kind === 'model_choice',
            ...(input.stored.packet.requestedModel
              ? { modelIntent: input.stored.packet.requestedModel } : {}),
          });
          outcome = { kind: 'refresh_required', packet };
          break;
        }
        case 'wait':
          outcome = { kind: 'performed', effect: 'observation_resumed' };
          break;
        case 'resume':
          outcome = { kind: 'performed', effect: 'task_resumed' };
          break;
        case 'cancel':
          this.#repository.requestCancel(input.taskId, input.clientId);
          outcome = { kind: 'performed', effect: 'cancel_requested' };
          break;
      }
    } catch {
      outcome = { kind: 'uncertain', reason: 'task-control-effect-unverified' };
    }

    try {
      this.#repository.recordDecisionOutcome({
        taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
        requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
        outcomeJson: JSON.stringify(outcome),
      });
    } catch {
      return { kind: 'uncertain', reason: 'decision-outcome-receipt-unavailable' };
    }
    if ((input.control.purpose === 'wait' || input.control.purpose === 'resume') &&
        this.#onTaskResumed) {
      try {
        await this.#onTaskResumed({
          taskId: input.taskId, clientId: input.clientId, attemptId: input.attemptId,
          mode: input.control.purpose,
        });
      } catch {
        try {
          this.#repository.recordObservationDeferred(input.taskId, input.clientId,
            'decision:' + input.decisionId + ':resume-scheduled-for-core-retry');
        } catch { /* The durable working state remains eligible for the Core scan. */ }
      }
    }
    return outcome;
  }

  /** Public decision entry point: the exact attempt stays server-owned.
   * Caller supplies only the current Task/decision/action identities.
   */
  async decideCurrent(input: {
    taskId: string; clientId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
  }): Promise<AgentDecisionOutcome> {
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    const row = full.decisions.find(decision => decision.decisionId === input.decisionId);
    if (!row) throw new SessionPlaneDomainError('stale_decision', 'Unknown decision identity');
    const bound = storedContext(row.contextJson);
    if (typeof bound.attemptId !== 'string' || bound.attemptId.length === 0) {
      throw new Error('Decision has no exact durable attempt binding');
    }
    return await this.decide({ ...input, attemptId: bound.attemptId });
  }

  /** Validated typed selection. The provider consumes the durable grant itself. */
  async decide(input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
  }): Promise<AgentDecisionOutcome> {
    if (!input.requestId || !input.actionRef) throw new SessionPlaneDomainError('invalid_request', 'Exact decision input required');
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    const decision = full.decisions.find(row => row.decisionId === input.decisionId);
    if (!decision) throw new SessionPlaneDomainError('stale_decision', 'Unknown decision identity');
    const stored = storedContext(decision.contextJson);
    if (stored.attemptId !== input.attemptId ||
        !full.attempts.some(attempt => attempt.attemptId === input.attemptId)) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision belongs to another exact attempt');
    }
    const normalized = input.input ?? null;
    if (decision.status === 'resolved') {
      return replayDecisionOutcome(decision.resolutionJson, {
        requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
      });
    }
    if (decision.status !== 'pending' || full.task.pendingDecisionId !== input.decisionId ||
        full.task.cancelRequested) throw new SessionPlaneDomainError('stale_decision', 'Decision is not pending on this Task');
    const option = (stored.allOptions ?? stored.packet.options)
      .find(candidate => candidate.actionRef === input.actionRef);
    const control = stored.packet.controls?.find(candidate => candidate.actionRef === input.actionRef);
    if ((option ? 1 : 0) + (control ? 1 : 0) !== 1) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision does not authorize the selected action');
    }
    if (control) {
      if (input.input !== undefined) {
        throw new SessionPlaneDomainError('invalid_request', 'Task controls do not accept provider input');
      }
      return await this.#decideControl({ ...input, stored, control });
    }
    if (!option || (option.purpose === 'grant_permission' &&
        stored.packet.permission?.canGrant !== true)) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision does not authorize the selected action');
    }
    const boundAction = stored.actions?.find(candidate =>
      candidate.actionRef === option.actionRef && candidate.purpose === option.purpose &&
      candidate.evidenceHash === option.evidenceHash) ??
      (stored.actionRef === option.actionRef && stored.purpose === option.purpose &&
       stored.evidenceHash === option.evidenceHash && stored.snapshotId !== null
        ? { purpose: option.purpose, snapshotId: stored.snapshotId,
          actionRef: option.actionRef, evidenceHash: option.evidenceHash } : null);
    if (!boundAction) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision action lost its durable evidence binding');
    }
    if (!selectionIsValid(option.inputSchema, input.input)) {
      throw new SessionPlaneDomainError('invalid_request', 'Selected input does not match the enabled decision schema');
    }
    // Cover previously published decisions too, including pending packets
    // created by an older Core before this barrier existed. Checking only the
    // read-only inspection path is insufficient: another client can call
    // task.decide directly with an old exact actionRef.
    if (option.purpose === 'choose_reasoning_effort' &&
        priorUncertainReasoningEffort(full.decisions) &&
        stored.reconcilesUncertainReasoningEffort !== true) {
      throw new SessionPlaneDomainError('stale_decision',
        'A stale reasoning effort action cannot bypass current-state reobservation');
    }
    if (!Number.isFinite(Date.parse(option.expiresAt)) ||
        Date.now() > Date.parse(option.expiresAt)) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision action expired; refresh before selecting');
    }
    const slot = this.#repository.getSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      throw new SessionPlaneDomainError('stale_decision', 'Decision lost its exact active slot');
    }
    const binding = this.#repository.getBindingAtRevision(
      full.task.projectId, full.task.slotId, full.task.slotRevision, input.clientId);
    const provider = this.#providers.resolve(binding.providerKey, 'conversation');
    if (provider.kind !== 'available' ||
        (provider.adapter.capabilities.browserRequired && stored.context.pageLease === null)) {
      throw new SessionPlaneDomainError('adapter_unsupported', 'Executable decision provider/page is unavailable');
    }
    try {
      this.#repository.resolveDecision({
        taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
        resolutionJson: JSON.stringify({
          kind: 'semantic_action', requestId: input.requestId,
          actionRef: input.actionRef, input: normalized,
        }),
      });
    } catch (error) {
      // Concurrent matching callers may race at this exact SQLite reservation.
      // The loser can only replay/read the committed receipt, never act again.
      const current = this.#repository.getFullTask(input.taskId, input.clientId)
        .decisions.find(row => row.decisionId === input.decisionId);
      if (current?.status === 'resolved') {
        return replayDecisionOutcome(current.resolutionJson, {
          requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
        });
      }
      throw error;
    }
    let result: SemanticActResult;
    try {
      result = await provider.adapter.act({
        context: stored.context, snapshotId: boundAction.snapshotId,
        actionRef: option.actionRef, evidenceHash: option.evidenceHash,
        authorizedDecisionId: input.decisionId,
        ...(input.input === undefined ? {} : { input: input.input }),
      });
    } catch {
      result = { kind: 'uncertain', reason: 'semantic-decision-effect-unverified' };
    }
    const accepted = this.#repository.getFullTask(input.taskId, input.clientId)
      .decisions.find(row => row.decisionId === input.decisionId);
    let outcome: AgentDecisionOutcome;
    if (result.kind === 'performed' && accepted?.actionConsumed) {
      outcome = { kind: 'performed', effect: result.effect };
    } else if (accepted?.actionConsumed || result.kind === 'uncertain' ||
        result.kind === 'dispatched_unverified') {
      const reason = result.kind === 'uncertain' ? boundedReason(result.reason) :
        'semantic-decision-effect-unverified';
      outcome = { kind: 'uncertain', reason };
    } else {
      // No durable consumption: never replay this action. The new snapshot
      // receives a distinct decisionId and a fresh provider action reference.
      try {
        const packet = await this.inspect({
          taskId: input.taskId, clientId: input.clientId, attemptId: input.attemptId,
          modelChoice: stored.packet.kind === 'model_choice',
          ...(stored.packet.requestedModel
            ? { modelIntent: stored.packet.requestedModel } : {}),
        });
        outcome = { kind: 'refresh_required', packet };
      } catch {
        outcome = { kind: 'uncertain', reason: 'decision-refresh-unavailable' };
      }
    }
    try {
      this.#repository.recordDecisionOutcome({
        taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
        requestId: input.requestId, actionRef: input.actionRef, inputValue: normalized,
        outcomeJson: JSON.stringify(outcome),
      });
    } catch {
      // The external effect might have happened even if this final SQLite
      // receipt could not commit. Never fabricate a success or repeat it.
      return { kind: 'uncertain', reason: 'decision-outcome-receipt-unavailable' };
    }
    if (outcome.kind === 'uncertain') {
      try {
        this.#repository.recordObservationDeferred(input.taskId, input.clientId,
          'decision:' + input.decisionId + ':uncertain:' + outcome.reason);
      } catch { /* The outcome receipt above is already durable. */ }
    } else if (outcome.kind === 'performed' && this.#onTaskResumed) {
      try {
        await this.#onTaskResumed({
          taskId: input.taskId, clientId: input.clientId, attemptId: input.attemptId,
          mode: 'provider_effect',
        });
      } catch {
        try {
          this.#repository.recordObservationDeferred(input.taskId, input.clientId,
            'decision:' + input.decisionId + ':provider-effect-resume-scheduled-for-core-retry');
        } catch { /* The verified effect receipt remains durable and replay-safe. */ }
      }
    }
    return outcome;
  }
}
