import type { AttemptKind } from '../domain/durable-task.ts';
import type {
  AttemptRecord,
  ResultRecord,
  KernelStores,
  TaskRecord,
} from '../storage/kernel/create-kernel-stores.ts';

/**
 * Provider-specific observe/act/verify lives behind this narrow port.
 * An adapter MUST verify the exact page/conversation/turn before reporting
 * an ACK or FINAL. "sendOnce" is NEVER called during recovery.
 */
export interface ExactSendIntent {
  readonly clientId: string;
  readonly projectId: string;
  readonly slotId: string;
  readonly slotRevision: number;
  readonly providerConversationId: string | null;
  readonly taskId: string;
  readonly attemptId: string;
  readonly kind: AttemptKind;
  readonly content: string;
}
export type FinalReadPriority = 'ordinary' | 'due';
export interface ExactTurnQuery extends ExactSendIntent {
  readonly externalTurnId: string | null;
  readonly readPriority?: FinalReadPriority;
}
export type SendOutcome =
  | { readonly kind: 'verified_ack'; readonly externalTurnId: string }
  | { readonly kind: 'uncertain'; readonly reason: string };
export type RecoveryOutcome =
  | { readonly kind: 'verified_ack'; readonly externalTurnId: string }
  | { readonly kind: 'verified_root_ack'; readonly conversationId: string;
      readonly messageId: string; readonly externalTurnId: string }
  | { readonly kind: 'pending'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };
export type FinalObservation =
  | { readonly kind: 'exact_final'; readonly externalTurnId: string; readonly answerText: string }
  | { readonly kind: 'pending'; readonly reason?: string; readonly nextCheckAt?: string | null }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly nextCheckAt?: string | null };
export type FinalProbeOutcome =
  | { readonly kind: 'exact_final'; readonly result: ResultRecord }
  | { readonly kind: 'pending'; readonly reason?: string; readonly nextCheckAt?: string | null }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly nextCheckAt?: string | null };

export interface ExactTaskProviderPort {
  readonly providerKey: string;
  /** Read-only readiness check before committing an irreversible attempt.
   * This check never grants send authority: sendOnce revalidates all identity.
   */
  preflight?(intent: ExactSendIntent): Promise<
    { readonly kind: 'ready' } | { readonly kind: 'unavailable'; readonly reason: string }
  >;
  sendOnce(intent: ExactSendIntent): Promise<SendOutcome>;
  recoverAck(query: ExactTurnQuery): Promise<RecoveryOutcome>;
  /** Optional provider-local reservation for a future exact due read. It is
   * scheduling only and can never authorize a POST or prove no-FINAL. */
  reserveFinalRead?(query: ExactTurnQuery, notBefore: string): Promise<void>;
  observeFinal(query: ExactTurnQuery): Promise<FinalObservation>;
}

/**
 * One path for ChatGPT Main and all future providers/roles. This is not a
 * subscriber/collector: mutations and outcomes are journaled by the Store,
 * while callers can disconnect without changing task lifetime.
 */
export class DurableTaskKernel {
  readonly #storage: Pick<KernelStores, 'projects' | 'tasks' | 'attempts'>;
  readonly #providers: ReadonlyMap<string, ExactTaskProviderPort>;

  constructor(storage: Pick<KernelStores, 'projects' | 'tasks' | 'attempts'>, providers: readonly ExactTaskProviderPort[]) {
    this.#storage = storage;
    this.#providers = new Map(providers.map(provider => [provider.providerKey, provider]));
    if (this.#providers.size !== providers.length) throw new Error('Duplicate provider key');
  }

  async dispatch(taskId: string, clientId: string, attemptId: string): Promise<TaskRecord> {
    const { attempt, provider, intent } = this.#resolve(taskId, clientId, attemptId);
    if (attempt.state !== 'planned') throw new Error('Mutation already attempted; no replay');
    if (attempt.kind !== 'stop') {
      const current = this.#storage.tasks.getTask(taskId, clientId);
      if (current.pendingDecisionId !== null &&
          (current.state === 'agent_input_required' ||
           current.state === 'human_input_required')) {
        // The packet's actionRef remains executable until the agent decides
        // or explicitly refreshes it. Another preflight observe would revoke
        // that snapshot without changing the provider.
        return current;
      }
      if (current.state !== 'working' || current.cancelRequested) {
        throw new Error('Task is not eligible for another provider dispatch');
      }
    }
    // A known missing page/conversation is NOT an ambiguous external send.
    // Preserve planned for the same caller when preparation later succeeds.
    if (provider.preflight) {
      let ready: { kind: 'ready' } | { kind: 'unavailable'; reason: string };
      try { ready = await provider.preflight(intent); }
      catch { ready = { kind: 'unavailable', reason: 'provider-preflight-unavailable' }; }
      if (ready.kind !== 'ready') {
        const reason = /^[a-z0-9_.:-]{1,100}$/i.test(ready.reason)
          ? ready.reason : 'provider-preflight-unverified';
        this.#storage.tasks.recordObservationDeferred(taskId, clientId,
          `preflight:${attemptId}:${reason}`);
        return this.#storage.tasks.getTask(taskId, clientId);
      }
    }
    this.#storage.attempts.reserveAttemptDispatch(taskId, clientId, attemptId);
    try {
      const outcome = await provider.sendOnce(intent);
      if (outcome.kind === 'verified_ack') {
        this.#storage.attempts.acknowledgeAttempt({
          taskId, clientId, attemptId, externalTurnId: outcome.externalTurnId,
        });
      } else {
        this.#storage.attempts.markAttemptUncertain(taskId, clientId, attemptId, outcome.reason);
      }
    } catch {
      this.#storage.attempts.markAttemptUncertain(taskId, clientId, attemptId, 'adapter_dispatch_unverified');
    }
    return this.#storage.tasks.getTask(taskId, clientId);
  }

  /**
   * Observation-only recovery after ambiguous mutation or process restart.
   * The adapter cannot submit again through this call.
   */
  async recoverAck(taskId: string, clientId: string, attemptId: string): Promise<TaskRecord> {
    const { attempt, provider, intent } = this.#resolve(taskId, clientId, attemptId);
    if (attempt.state === 'acknowledged') return this.#storage.tasks.getTask(taskId, clientId);
    if (attempt.state !== 'uncertain' && attempt.state !== 'dispatched') {
      throw new Error('Only previously dispatched attempts may be reconciled');
    }
    const outcome = await provider.recoverAck({
      ...intent, externalTurnId: attempt.externalTurnId,
    });
    if (outcome.kind === 'verified_root_ack') {
      this.#storage.attempts.promoteRootDispatchEvidence({
        taskId, clientId, attemptId,
        conversationId: outcome.conversationId,
        messageId: outcome.messageId,
        externalTurnId: outcome.externalTurnId,
      });
    } else if (outcome.kind === 'verified_ack') {
      this.#storage.attempts.acknowledgeAttempt({
        taskId, clientId, attemptId, externalTurnId: outcome.externalTurnId,
      });
    } else {
      this.#storage.attempts.markAttemptUncertain(taskId, clientId, attemptId, outcome.reason);
      const reason = /^[a-z0-9_.:-]{1,100}$/i.test(outcome.reason)
        ? outcome.reason : 'provider-ack-unverified';
      // Exact ACK deferrals are durable observations, never a send receipt.
      this.#storage.tasks.recordObservationDeferred(taskId, clientId,
        `ack:${attemptId}:${outcome.kind}:${reason}`);
    }
    return this.#storage.tasks.getTask(taskId, clientId);
  }

  async reserveFinalRead(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    notBefore: string;
  }): Promise<void> {
    const dueMs = Date.parse(input.notBefore);
    if (!Number.isFinite(dueMs)) throw new Error('Invalid FINAL read reservation');
    const { attempt, provider, intent } = this.#resolve(
      input.taskId, input.clientId, input.attemptId,
    );
    if (attempt.kind === 'stop' || attempt.state !== 'acknowledged' ||
        attempt.externalTurnId === null) {
      throw new Error('No exact ACK for FINAL read reservation');
    }
    if (!provider.reserveFinalRead) return;
    await provider.reserveFinalRead({
      ...intent, externalTurnId: attempt.externalTurnId, readPriority: 'due',
    }, input.notBefore);
  }

  async observeFinal(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    resultId: string;
    completeTask: boolean;
  }): Promise<ResultRecord | null> {
    const probe = await this.probeFinal(input);
    return probe.kind === 'exact_final' ? probe.result : null;
  }

  /** Preserve the difference between a verified absent FINAL and a read
   * failure. Only a known pending answer may permit a safe-idle Continue.
   */
  async probeFinal(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    resultId: string;
    completeTask: boolean;
    readPriority?: FinalReadPriority;
  }): Promise<FinalProbeOutcome> {
    const { attempt, provider, intent } = this.#resolve(
      input.taskId, input.clientId, input.attemptId,
    );
    if (attempt.kind === 'stop' || attempt.state !== 'acknowledged' ||
      attempt.externalTurnId === null) throw new Error('No exact ACK for FINAL observation');
    const observation = await provider.observeFinal({
      ...intent, externalTurnId: attempt.externalTurnId,
      readPriority: input.readPriority ?? 'ordinary',
    });
    if (observation.kind !== 'exact_final') {
      const code = observation.reason && /^[a-z0-9_.:-]{1,100}$/i.test(observation.reason)
        ? observation.reason : 'provider-final-unverified';
      this.#storage.tasks.recordObservationDeferred(input.taskId, input.clientId,
        `final:${input.attemptId}:${observation.kind}:${code}`);
      return observation;
    }
    if (observation.externalTurnId !== attempt.externalTurnId) {
      throw new Error('Provider returned FINAL for wrong turn; reject evidence');
    }
    return { kind: 'exact_final', result: this.#storage.tasks.recordTaskFinal({
      ...input,
      externalTurnId: observation.externalTurnId,
      answerText: observation.answerText,
    }) };
  }

  #resolve(taskId: string, clientId: string, attemptId: string): {
    attempt: AttemptRecord;
    provider: ExactTaskProviderPort;
    intent: ExactSendIntent;
  } {
    const full = this.#storage.tasks.readTaskAggregate(taskId, clientId);
    const task = full.task;
    const attempt = full.attempts.find(row => row.attemptId === attemptId);
    if (!attempt) throw new Error('Attempt does not belong to task');
    const binding = this.#storage.projects.getSlotBindingAtRevision(task.projectId, task.slotId,
      task.slotRevision, clientId);
    const provider = this.#providers.get(binding.providerKey);
    if (!provider) throw new Error('Provider capability unavailable');
    return {
      attempt,
      provider,
      intent: {
        clientId,
        projectId: task.projectId,
        slotId: task.slotId,
        slotRevision: task.slotRevision,
        providerConversationId: binding.providerConversationId,
        taskId,
        attemptId,
        kind: attempt.kind,
        content: attempt.content,
      },
    };
  }
}
