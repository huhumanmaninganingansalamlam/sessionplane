import { randomUUID } from 'node:crypto';
import { SessionPlaneDomainError } from '../domain/errors.ts';

import type { ExactSendIntent } from './durable-task-kernel.ts';
import type { SemanticContextResolver } from './semantic-exact-task-port.ts';
import type {
  SemanticActionCandidate, SemanticActionPurpose, SemanticActResult,
  SemanticInput, SemanticObservation, SemanticPermissionEvidence,
  SemanticTaskContext,
} from '../providers/semantic-adapter.ts';
import { semanticConfigurationMatches } from '../providers/semantic-adapter.ts';
import type { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { TaskKernelRepository } from '../storage/task-kernel-repository.ts';

const MAX_PACKET_BYTES = 12 * 1024;
const MAX_REASON_LENGTH = 120;

export type AgentDecisionKind =
  | 'model_choice' | 'provider_question' | 'tool_permission'
  | 'recovery_choice' | 'adapter_unsupported' | 'human_verification';

export interface AgentDecisionOption {
  readonly actionRef: string;
  readonly purpose: SemanticActionPurpose;
  readonly effect: string;
  readonly risk: SemanticActionCandidate['risk'];
  readonly evidenceHash: string;
  readonly expiresAt: string;
  readonly inputSchema: SemanticInput;
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
  readonly evidenceBytes: number;
}

interface StoredDecision {
  readonly kind: 'semantic_action';
  readonly context: SemanticTaskContext;
  readonly attemptId: string;
  readonly purpose: SemanticActionPurpose | null;
  readonly snapshotId: string | null;
  readonly actionRef: string | null;
  readonly evidenceHash: string | null;
  readonly packet: AgentDecisionPacket;
}

export type AgentDecisionOutcome =
  | { readonly kind: 'performed'; readonly effect: string }
  | { readonly kind: 'refresh_required'; readonly packet: AgentDecisionPacket | null }
  | { readonly kind: 'uncertain'; readonly reason: string };

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

function oneAction(
  observation: SemanticObservation, purposes: readonly SemanticActionPurpose[],
): SemanticActionCandidate | null {
  const candidates = observation.actions.filter(action => purposes.includes(action.purpose) &&
    action.purpose !== 'grant_permission' && action.risk !== 'permission_grant');
  return candidates.length === 1 ? candidates[0]! : null;
}

function decisionKind(
  observation: SemanticObservation, modelChoice: boolean,
): AgentDecisionKind | null {
  switch (observation.blocker) {
    case 'provider_question': return 'provider_question';
    case 'provider_permission': return 'tool_permission';
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

  constructor(input: {
    repository: TaskKernelRepository;
    providers: SemanticProviderRegistry;
    resolveContext: SemanticContextResolver;
  }) {
    this.#repository = input.repository;
    this.#providers = input.providers;
    this.#resolveContext = input.resolveContext;
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
        ? ['open_model_chooser', 'choose_model'] : kind === 'recovery_choice'
          ? ['retry'] : [];
    const action = observation ? oneAction(observation, purposes) : null;
    const now = new Date().toISOString();
    const decisionId = randomUUID();
    const option: AgentDecisionOption[] = action ? [{
      actionRef: action.actionRef, purpose: action.purpose, effect: action.effect,
      risk: action.risk, evidenceHash: action.evidenceHash,
      expiresAt: action.expiresAt, inputSchema: action.input,
    }] : [];
    const reason = observation ? boundedReason(observation.reason) :
      provider.kind === 'unsupported' ? provider.reason : 'semantic-observation-unavailable';
    let packet: AgentDecisionPacket = {
      taskId: input.taskId, taskRevision: full.task.revision + 1, decisionId,
      kind, reason, humanOnly: kind === 'human_verification',
      observedAt: observation?.observedAt ?? now,
      expiresAt: action?.expiresAt ?? new Date(Date.now() + 30_000).toISOString(),
      snapshotId: observation?.snapshotId ?? null,
      questionText: kind === 'provider_question' ? observation?.questionText ?? null : null,
      permission: kind === 'tool_permission' ? observation?.permission ?? null : null,
      requestedModel: kind === 'model_choice' ? input.modelIntent ?? null : null,
      options: option, evidenceBytes: 0,
    };
    packet = countBytes(packet);
    if (packet.evidenceBytes > MAX_PACKET_BYTES) {
      // Never publish a truncated question/permission with a live actionRef.
      packet = countBytes({ ...packet, kind: 'adapter_unsupported',
        reason: 'decision-evidence-requires-bounded-expansion', humanOnly: false,
        questionText: null, permission: null, options: [], evidenceBytes: 0 });
    }
    const actionable = packet.options.length === 1 ? packet.options[0]! : null;
    const envelope: StoredDecision = {
      kind: 'semantic_action', context, attemptId: input.attemptId,
      purpose: actionable?.purpose ?? null,
      snapshotId: packet.snapshotId,
      actionRef: actionable?.actionRef ?? null,
      evidenceHash: actionable?.evidenceHash ?? null,
      packet,
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
    // The only unsupported packet allowed a public read-only refresh is the
    // exact unsubmitted Pro-root observation raced by a page operation.
    const transientModelRace =
      original.packet.kind === 'adapter_unsupported' &&
      original.packet.reason === 'semantic-observation-superseded-by-page-operation' &&
      original.packet.options.length === 0 && !original.packet.humanOnly &&
      original.context.requiredModel === 'Pro' &&
      original.context.providerConversationId === null &&
      original.context.submittedUserMessageId === null &&
      original.context.submittedUserTurnId === null &&
      original.context.pageLease !== null &&
      originalAttempt.kind === 'initial' && originalAttempt.state === 'planned';
    const receipt = row.resolutionJson === null ? null
      : JSON.parse(row.resolutionJson) as Record<string, unknown>;
    if (row.status === 'resolved') {
      if (receipt?.kind !== 'read_only_refresh' || receipt.requestId !== input.requestId) {
        throw new SessionPlaneDomainError('stale_decision', 'Decision refreshed by a different request');
      }
      // A crash after the durable receipt but before reinspection cannot strand
      // this Task. A replay can only observe, never perform a provider action.
      const next = this.get(input.taskId, input.clientId) ??
        (full.task.state === 'working' && !full.task.cancelRequested &&
         originalAttempt.state === 'planned' ? await this.inspect({
          taskId: input.taskId, clientId: input.clientId, attemptId: original.attemptId,
          modelChoice: original.packet.kind === 'model_choice' || transientModelRace,
          ...(original.packet.requestedModel || (transientModelRace ? original.context.requiredModel : null)
            ? { modelIntent: (original.packet.requestedModel ??
              original.context.requiredModel)! } : {}),
        }) : null);
      return { kind: 'refresh_required', packet: next };
    }
    const packet = original.packet;
    const option = packet.options[0];
    if (row.status !== 'pending' || full.task.pendingDecisionId !== input.decisionId ||
        full.task.cancelRequested ||
        (packet.kind !== 'model_choice' && !transientModelRace) ||
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
        modelChoice: transientModelRace });
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
    const [option] = stored.packet.options;
    if (stored.packet.options.length !== 1 || !option ||
        option.actionRef !== input.actionRef || stored.actionRef !== input.actionRef ||
        stored.purpose !== option.purpose || stored.evidenceHash !== option.evidenceHash ||
        option.risk === 'permission_grant' || option.purpose === 'grant_permission') {
      throw new SessionPlaneDomainError('stale_decision', 'Decision does not authorize the selected action');
    }
    if (!selectionIsValid(option.inputSchema, input.input)) {
      throw new SessionPlaneDomainError('invalid_request', 'Selected input does not match the enabled decision schema');
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
        context: stored.context, snapshotId: stored.snapshotId!,
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
    }
    return outcome;
  }
}
