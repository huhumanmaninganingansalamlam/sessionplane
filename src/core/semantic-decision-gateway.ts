import { randomUUID } from 'node:crypto';

import type { ExactSendIntent } from './durable-task-kernel.ts';
import type { SemanticContextResolver } from './semantic-exact-task-port.ts';
import type {
  SemanticActionCandidate, SemanticActionPurpose, SemanticActResult,
  SemanticInput, SemanticObservation, SemanticPermissionEvidence,
  SemanticTaskContext,
} from '../providers/semantic-adapter.ts';
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
  readonly options: readonly AgentDecisionOption[];
  readonly evidenceBytes: number;
}

interface StoredDecision {
  readonly kind: 'semantic_action';
  readonly context: SemanticTaskContext;
  readonly purpose: SemanticActionPurpose | null;
  readonly snapshotId: string | null;
  readonly actionRef: string | null;
  readonly evidenceHash: string | null;
  readonly packet: AgentDecisionPacket;
}

export type AgentDecisionOutcome =
  | { readonly kind: 'performed'; readonly effect: string }
  | { readonly kind: 'previously_resolved'; readonly actionConsumed: boolean }
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

  /** Only a blocker or an explicitly requested model choice creates a packet. */
  async inspect(input: {
    taskId: string; clientId: string; attemptId: string;
    modelChoice?: boolean;
  }): Promise<AgentDecisionPacket | null> {
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
      kind: 'semantic_action', context,
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
    modelChoice?: boolean;
  }): Promise<AgentDecisionPacket | null> {
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    if (full.task.pendingDecisionId !== input.decisionId) {
      throw new Error('Only the current pending decision may be refreshed');
    }
    this.#repository.resolveDecision({
      taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
      resolutionJson: JSON.stringify({ kind: 'read_only_refresh' }),
    });
    return await this.inspect({ taskId: input.taskId, clientId: input.clientId,
      attemptId: input.attemptId,
      ...(input.modelChoice === undefined ? {} : { modelChoice: input.modelChoice }) });
  }

  /** Validated typed selection. The provider consumes the durable grant itself. */
  async decide(input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
  }): Promise<AgentDecisionOutcome> {
    if (!input.requestId || !input.actionRef) throw new Error('Exact decision input required');
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    const decision = full.decisions.find(row => row.decisionId === input.decisionId);
    if (!decision) throw new Error('Unknown decision identity');
    const stored = storedContext(decision.contextJson);
    const normalized = input.input ?? null;
    if (decision.status === 'resolved') {
      const original: unknown = decision.resolutionJson === null ? null
        : JSON.parse(decision.resolutionJson);
      if (original && typeof original === 'object') {
        const receipt = original as Record<string, unknown>;
        if (receipt.kind === 'semantic_action' && receipt.requestId === input.requestId &&
            receipt.actionRef === input.actionRef && receipt.input === normalized) {
          return { kind: 'previously_resolved', actionConsumed: decision.actionConsumed };
        }
      }
      throw new Error('Decision already resolved by a different request');
    }
    if (decision.status !== 'pending' || full.task.pendingDecisionId !== input.decisionId ||
        full.task.cancelRequested) throw new Error('Decision is not pending on this Task');
    const [option] = stored.packet.options;
    if (stored.packet.options.length !== 1 || !option ||
        option.actionRef !== input.actionRef || stored.actionRef !== input.actionRef ||
        stored.purpose !== option.purpose || stored.evidenceHash !== option.evidenceHash ||
        option.risk === 'permission_grant' || option.purpose === 'grant_permission') {
      throw new Error('Decision does not authorize the selected action');
    }
    if (!selectionIsValid(option.inputSchema, input.input)) {
      throw new Error('Selected input does not match the enabled decision schema');
    }
    if (!Number.isFinite(Date.parse(option.expiresAt)) ||
        Date.now() > Date.parse(option.expiresAt)) {
      throw new Error('Decision action expired; refresh before selecting');
    }
    const slot = this.#repository.getSlot(full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision) {
      throw new Error('Decision lost its exact active slot');
    }
    const binding = this.#repository.getBindingAtRevision(
      full.task.projectId, full.task.slotId, full.task.slotRevision, input.clientId);
    const provider = this.#providers.resolve(binding.providerKey, 'conversation');
    if (provider.kind !== 'available' ||
        (provider.adapter.capabilities.browserRequired && stored.context.pageLease === null)) {
      throw new Error('Executable decision provider/page is unavailable');
    }
    this.#repository.resolveDecision({
      taskId: input.taskId, clientId: input.clientId, decisionId: input.decisionId,
      resolutionJson: JSON.stringify({
        kind: 'semantic_action', requestId: input.requestId,
        actionRef: input.actionRef, input: normalized,
      }),
    });
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
    if (result.kind === 'performed' && accepted?.actionConsumed) {
      return { kind: 'performed', effect: result.effect };
    }
    if (accepted?.actionConsumed || result.kind === 'uncertain' ||
        result.kind === 'dispatched_unverified') {
      const reason = result.kind === 'uncertain' ? boundedReason(result.reason) :
        'semantic-decision-effect-unverified';
      this.#repository.recordObservationDeferred(input.taskId, input.clientId,
        'decision:' + input.decisionId + ':uncertain:' + reason);
      return { kind: 'uncertain', reason };
    }
    // No durable action consumption: nothing was authorized to click. A fresh
    // packet can be issued without replaying the old action or user prompt.
    const packet = await this.inspect({
      taskId: input.taskId, clientId: input.clientId, attemptId: input.attemptId,
      modelChoice: stored.packet.kind === 'model_choice',
    });
    return { kind: 'refresh_required', packet };
  }
}
