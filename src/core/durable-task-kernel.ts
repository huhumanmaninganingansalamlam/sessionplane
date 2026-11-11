import type { AttemptKind } from '../domain/durable-task.ts';
import type {
  AttemptRecord,
  ResultRecord,
  TaskKernelRepository,
  TaskRecord,
} from '../storage/task-kernel-repository.ts';

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
export interface ExactTurnQuery extends ExactSendIntent {
  readonly externalTurnId: string | null;
}
export type SendOutcome =
  | { readonly kind: 'verified_ack'; readonly externalTurnId: string }
  | { readonly kind: 'uncertain'; readonly reason: string };
export type RecoveryOutcome =
  | { readonly kind: 'verified_ack'; readonly externalTurnId: string }
  | { readonly kind: 'pending'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string };
export type FinalObservation =
  | { readonly kind: 'exact_final'; readonly externalTurnId: string; readonly answerText: string }
  | { readonly kind: 'pending'; readonly reason?: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

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
  observeFinal(query: ExactTurnQuery): Promise<FinalObservation>;
}

/**
 * One path for ChatGPT Main and all future providers/roles. This is not a
 * subscriber/collector: mutations and outcomes are journaled by the Store,
 * while callers can disconnect without changing task lifetime.
 */
export class DurableTaskKernel {
  readonly #storage: TaskKernelRepository;
  readonly #providers: ReadonlyMap<string, ExactTaskProviderPort>;

  constructor(storage: TaskKernelRepository, providers: readonly ExactTaskProviderPort[]) {
    this.#storage = storage;
    this.#providers = new Map(providers.map(provider => [provider.providerKey, provider]));
    if (this.#providers.size !== providers.length) throw new Error('Duplicate provider key');
  }

  async dispatch(taskId: string, clientId: string, attemptId: string): Promise<TaskRecord> {
    const { attempt, provider, intent } = this.#resolve(taskId, clientId, attemptId);
    if (attempt.state !== 'planned') throw new Error('Mutation already attempted; no replay');
    // A known missing page/conversation is NOT an ambiguous external send.
    // Preserve planned for the same caller when preparation later succeeds.
    if (provider.preflight) {
      let ready: { kind: 'ready' } | { kind: 'unavailable'; reason: string };
      try { ready = await provider.preflight(intent); }
      catch { ready = { kind: 'unavailable', reason: 'provider-preflight-unavailable' }; }
      if (ready.kind !== 'ready') {
        const reason = /^[a-z0-9_.:-]{1,100}$/i.test(ready.reason)
          ? ready.reason : 'provider-preflight-unverified';
        this.#storage.recordObservationDeferred(taskId, clientId,
          `preflight:${attemptId}:${reason}`);
        return this.#storage.getTask(taskId, clientId);
      }
    }
    this.#storage.beginDispatch(taskId, clientId, attemptId);
    try {
      const outcome = await provider.sendOnce(intent);
      if (outcome.kind === 'verified_ack') {
        this.#storage.acknowledgeAttempt({
          taskId, clientId, attemptId, externalTurnId: outcome.externalTurnId,
        });
      } else {
        this.#storage.markUncertain(taskId, clientId, attemptId, outcome.reason);
      }
    } catch {
      this.#storage.markUncertain(taskId, clientId, attemptId, 'adapter_dispatch_unverified');
    }
    return this.#storage.getTask(taskId, clientId);
  }

  /**
   * Observation-only recovery after ambiguous mutation or process restart.
   * The adapter cannot submit again through this call.
   */
  async recoverAck(taskId: string, clientId: string, attemptId: string): Promise<TaskRecord> {
    const { attempt, provider, intent } = this.#resolve(taskId, clientId, attemptId);
    if (attempt.state === 'acknowledged') return this.#storage.getTask(taskId, clientId);
    if (attempt.state !== 'uncertain' && attempt.state !== 'dispatched') {
      throw new Error('Only previously dispatched attempts may be reconciled');
    }
    const outcome = await provider.recoverAck({
      ...intent, externalTurnId: attempt.externalTurnId,
    });
    if (outcome.kind === 'verified_ack') {
      this.#storage.acknowledgeAttempt({
        taskId, clientId, attemptId, externalTurnId: outcome.externalTurnId,
      });
    } else {
      this.#storage.markUncertain(taskId, clientId, attemptId, outcome.reason);
      const reason = /^[a-z0-9_.:-]{1,100}$/i.test(outcome.reason)
        ? outcome.reason : 'provider-ack-unverified';
      // Exact ACK deferrals are durable observations, never a send receipt.
      this.#storage.recordObservationDeferred(taskId, clientId,
        `ack:${attemptId}:${outcome.kind}:${reason}`);
    }
    return this.#storage.getTask(taskId, clientId);
  }

  async observeFinal(input: {
    taskId: string;
    clientId: string;
    attemptId: string;
    resultId: string;
    completeTask: boolean;
  }): Promise<ResultRecord | null> {
    const { attempt, provider, intent } = this.#resolve(
      input.taskId, input.clientId, input.attemptId,
    );
    if (attempt.kind === 'stop' || attempt.state !== 'acknowledged' ||
      attempt.externalTurnId === null) throw new Error('No exact ACK for FINAL observation');
    const observation = await provider.observeFinal({
      ...intent, externalTurnId: attempt.externalTurnId,
    });
    if (observation.kind !== 'exact_final') {
      // Preserve the exact attempt's nonterminal read reason. A missing FINAL
      // is never task completion or permission to replay the original POST.
      const code = observation.reason && /^[a-z0-9_.:-]{1,100}$/i.test(observation.reason)
        ? observation.reason : 'provider-final-unverified';
      this.#storage.recordObservationDeferred(input.taskId, input.clientId,
        `final:${input.attemptId}:${observation.kind}:${code}`);
      return null;
    }
    if (observation.externalTurnId !== attempt.externalTurnId) {
      throw new Error('Provider returned FINAL for wrong turn; reject evidence');
    }
    return this.#storage.recordFinal({
      ...input,
      externalTurnId: observation.externalTurnId,
      answerText: observation.answerText,
    });
  }

  #resolve(taskId: string, clientId: string, attemptId: string): {
    attempt: AttemptRecord;
    provider: ExactTaskProviderPort;
    intent: ExactSendIntent;
  } {
    const full = this.#storage.getFullTask(taskId, clientId);
    const task = full.task;
    const attempt = full.attempts.find(row => row.attemptId === attemptId);
    if (!attempt) throw new Error('Attempt does not belong to task');
    const binding = this.#storage.getBindingAtRevision(task.projectId, task.slotId,
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
