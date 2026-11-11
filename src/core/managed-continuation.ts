import type { DurableTaskKernel } from './durable-task-kernel.ts';
import type {
  AttemptRecord, FullTaskRecord, TaskKernelRepository, TimerRecord,
} from '../storage/task-kernel-repository.ts';

export const CONTINUATION_INTERVAL_MS = 20 * 60_000;
const TIMER_KIND = 'continuation_due';

interface ContinuationContext {
  readonly contract: 'approved_continuation_v1';
  readonly approvalRef: string;
  readonly intervalMs: number;
  readonly message: string;
  readonly sourceAttemptId: string;
}

export interface ContinuationReviewReport {
  readonly timersClaimed: number;
  readonly dispatchesAttempted: number;
  readonly deferred: number;
}

/**
 * No separate browser, agent, collector, or timer database. SQLite owns
 * durable approvals (in each exact timer), due slots and dispatch attempts.
 * A timer may be claimed after a restart, but neither a fired timer nor
 * a speculative UI state is evidence that a POST occurred.
 */
export class ManagedContinuationService {
  readonly #repository: TaskKernelRepository;
  readonly #kernel: DurableTaskKernel;
  readonly #now: () => Date;
  readonly #canRun: () => boolean;
  readonly #bindAttempt: (input: {
    taskId: string; clientId: string; attemptId: string; sourceAttemptId: string;
  }) => void | Promise<void>;
  #interval: ReturnType<typeof setInterval> | null = null;
  #active: Promise<ContinuationReviewReport> | null = null;
  #closed = false;

  constructor(input: {
    repository: TaskKernelRepository;
    kernel: DurableTaskKernel;
    now?: () => Date;
    canRun?: () => boolean;
    bindAttempt?: (input: {
      taskId: string; clientId: string; attemptId: string; sourceAttemptId: string;
    }) => void | Promise<void>;
  }) {
    this.#repository = input.repository;
    this.#kernel = input.kernel;
    this.#now = input.now ?? (() => new Date());
    this.#canRun = input.canRun ?? (() => true);
    this.#bindAttempt = input.bindAttempt ?? (() => undefined);
  }

  /** Called only by a trusted Core caller with explicit user delegation.
   * An unapproved task never acquires a continuation timer or send attempt.
   */
  activate(input: {
    taskId: string; clientId: string; sourceAttemptId: string;
    approvalRef: string; message: string;
  }): TimerRecord {
    if (input.approvalRef.trim().length === 0 || input.approvalRef.length > 512 ||
        input.message.trim().length === 0 || input.message.length > 4_096) {
      throw new Error('Explicit bounded continuation approval and message required');
    }
    const full = this.#repository.getFullTask(input.taskId, input.clientId);
    if (full.task.cancelRequested || full.task.state !== 'working') {
      throw new Error('Task is not eligible for an approved continuation policy');
    }
    const source = full.attempts.find(attempt => attempt.attemptId === input.sourceAttemptId);
    if (!source || source.kind === 'stop' || source.state !== 'acknowledged' ||
        source.acknowledgedAt === null) {
      throw new Error('Continuation activation requires an exact acknowledged source turn');
    }
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (latest?.attemptId !== source.attemptId) {
      throw new Error('Cannot authorize continuation from a superseded attempt');
    }
    const slot = this.#repository.getSlot(
      full.task.projectId, full.task.slotId, input.clientId);
    if (slot.activeTaskId !== input.taskId || slot.revision !== full.task.slotRevision ||
        slot.providerConversationId === null) {
      throw new Error('Continuation approval requires the exact active conversation');
    }
    // Only the fixed literal is allowed for the ChatGPT B-first policy.
    // A future provider may specify its own reviewed continuation text.
    if (slot.providerKey === 'chatgpt' && input.message !== '계속') {
      throw new Error('ChatGPT continuation requires the exact approved literal 계속');
    }
    return this.#armFromAck(full, input.clientId, source, {
      contract: 'approved_continuation_v1',
      approvalRef: input.approvalRef,
      intervalMs: CONTINUATION_INTERVAL_MS,
      message: input.message,
      sourceAttemptId: source.attemptId,
    });
  }

  /** Core lifecycle only; subscriber count and task.wait never own the clock. */
  start(pollMs = 30_000): void {
    if (this.#closed) throw new Error('Managed continuation service is closed');
    if (this.#interval !== null) return;
    if (!Number.isInteger(pollMs) || pollMs < 100) throw new Error('Invalid Core tick interval');
    this.#interval = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, pollMs);
    this.#interval.unref();
    void this.tick().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#interval !== null) clearInterval(this.#interval);
    this.#interval = null;
    await this.#active?.catch(() => undefined);
  }

  tick(): Promise<ContinuationReviewReport> {
    if (this.#closed || !this.#canRun()) {
      return Promise.resolve({ timersClaimed: 0, dispatchesAttempted: 0, deferred: 0 });
    }
    if (this.#active !== null) return this.#active;
    const work = this.#run();
    this.#active = work;
    void work.finally(() => {
      if (this.#active === work) this.#active = null;
    }).catch(() => undefined);
    return work;
  }

  async #run(): Promise<ContinuationReviewReport> {
    const now = this.#now().toISOString();
    // An approved public Task is admitted before any provider send. Once its
    // exact ACK lands, Core (not task.wait or a connected client) turns that
    // persisted approval into the first durable 20-minute timer.
    for (const candidate of this.#repository.listApprovedContinuationPolicies()) {
      try {
        const policy: unknown = JSON.parse(candidate.policyJson);
        if (!policy || typeof policy !== 'object') continue;
        const approved = policy as {
          enabled?: unknown; intervalMs?: unknown;
          approvalRef?: unknown; message?: unknown;
        };
        if (approved.enabled !== true || approved.intervalMs !== CONTINUATION_INTERVAL_MS ||
            typeof approved.approvalRef !== 'string' ||
            typeof approved.message !== 'string') continue;
        const full = this.#repository.getFullTask(candidate.taskId, candidate.clientId);
        const latest = full.attempts.filter(row => row.kind !== 'stop').at(-1);
        if (latest?.state !== 'acknowledged') continue;
        this.activate({
          taskId: candidate.taskId, clientId: candidate.clientId,
          sourceAttemptId: latest.attemptId, approvalRef: approved.approvalRef,
          message: approved.message,
        });
      } catch { /* One unready Task must not block any other due slot. */ }
    }
    // Reconcile an ACK after a Core crash between its exact journal write and
    // next timer scheduling. There is one idempotent timer per ACK.
    for (const owner of this.#repository.listContinuationTaskOwners()) {
      try { this.#reconcileOwner(owner.taskId, owner.clientId, now); }
      catch { /* One task must not starve the other due slots. */ }
    }
    const claimed = this.#repository.claimDueTimers(now, 50, TIMER_KIND);
    let dispatchesAttempted = 0;
    let deferred = 0;
    for (const timer of claimed) {
      try {
        const status = await this.#handle(timer, now);
        if (status === 'attempted') dispatchesAttempted++;
        else if (status === 'deferred') deferred++;
      } catch {
        deferred++;
        try {
          const clientId = this.#repository.dispatchClientId(timer.taskId);
          if (clientId) {
            this.#repository.recordObservationDeferred(timer.taskId, clientId,
              'managed-continuation-review-unverified');
            const context = parseContext(timer.contextJson);
            if (context) this.#rearmReview(timer, clientId, context, now);
          }
        } catch { /* Never reinterpret unknown dispatch as safe to replay. */ }
      }
    }
    // A standalone public Task must finish even when every client has exited.
    // This read-only observer never takes over the provider or retries a POST.
    // Process due sends first; a slow FINAL GET cannot starve another Task's due.
    for (const pending of this.#repository.listPendingPublicFinals(8)) {
      try {
        const policy: unknown = JSON.parse(pending.policyJson);
        const managed = policy !== null && typeof policy === 'object' &&
          (policy as { enabled?: unknown }).enabled === true;
        await this.#kernel.observeFinal({
          taskId: pending.taskId, clientId: pending.clientId,
          attemptId: pending.attemptId, resultId: 'public-final:' + pending.attemptId,
          completeTask: !managed,
        });
      } catch {
        try {
          this.#repository.recordObservationDeferred(pending.taskId, pending.clientId,
            'public-exact-final-observation-unavailable');
        } catch { /* Do not convert read failure into task completion. */ }
      }
    }
    return { timersClaimed: claimed.length, dispatchesAttempted, deferred };
  }

  #armFromAck(
    full: FullTaskRecord, clientId: string, source: AttemptRecord,
    approved: ContinuationContext,
  ): TimerRecord {
    if (source.acknowledgedAt === null || source.state !== 'acknowledged') {
      throw new Error('No exact ACK for managed due timer');
    }
    const dueAt = new Date(Date.parse(source.acknowledgedAt) + approved.intervalMs).toISOString();
    return this.#repository.scheduleTimer({
      taskId: full.task.taskId, clientId,
      timerId: 'continuation-due:' + source.attemptId,
      kind: TIMER_KIND, dueAt,
      contextJson: JSON.stringify({ ...approved, sourceAttemptId: source.attemptId }),
    });
  }

  #reconcileOwner(taskId: string, clientId: string, now: string): void {
    const full = this.#repository.getFullTask(taskId, clientId);
    if (full.task.cancelRequested ||
        ['completed', 'failed', 'canceled'].includes(full.task.state)) return;
    const approved = full.timers.map(timer => parseContext(timer.contextJson))
      .find(context => context !== null);
    if (!approved) return;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (!latest) return;
    if (latest.state === 'acknowledged' && latest.acknowledgedAt !== null) {
      this.#armFromAck(full, clientId, latest, approved);
    }
    // Recover a claimed due timer after a crash before planning or rearming.
    // Skip missed slots rather than issuing a burst of historical Continue.
    const sourceTimer = full.timers.filter(timer => timer.kind === TIMER_KIND &&
      parseContext(timer.contextJson)?.sourceAttemptId ===
        (latest.kind === 'continuation' && latest.state === 'planned'
          ? full.attempts.find(row => row.sequence === latest.sequence - 1)?.attemptId
          : latest.attemptId)).at(-1);
    if (sourceTimer?.status === 'fired' &&
        !full.timers.some(timer => timer.status === 'pending' && timer.kind === TIMER_KIND &&
          parseContext(timer.contextJson)?.sourceAttemptId ===
          parseContext(sourceTimer.contextJson)?.sourceAttemptId)) {
      const context = parseContext(sourceTimer.contextJson);
      if (context && (latest.state === 'planned' || latest.state === 'acknowledged')) {
        this.#rearmReview(sourceTimer, clientId, context, now);
      }
    }
  }

  #rearmReview(
    timer: TimerRecord, clientId: string, context: ContinuationContext, now: string,
  ): void {
    const nextMs = Date.parse(timer.dueAt) +
      (Math.floor(Math.max(0, Date.parse(now) - Date.parse(timer.dueAt)) /
        context.intervalMs) + 1) * context.intervalMs;
    this.#repository.scheduleTimer({
      taskId: timer.taskId, clientId,
      timerId: 'continuation-review:' + context.sourceAttemptId + ':' + nextMs,
      kind: TIMER_KIND,
      dueAt: new Date(nextMs).toISOString(),
      contextJson: JSON.stringify(context),
    });
  }

  async #handle(timer: TimerRecord, now: string): Promise<'attempted' | 'deferred' | 'ignored'> {
    const clientId = this.#repository.dispatchClientId(timer.taskId);
    const context = parseContext(timer.contextJson);
    if (!clientId || !context) return 'ignored';
    const full = this.#repository.getFullTask(timer.taskId, clientId);
    if (full.task.cancelRequested ||
        ['completed', 'failed', 'canceled'].includes(full.task.state)) return 'ignored';
    const source = full.attempts.find(attempt => attempt.attemptId === context.sourceAttemptId);
    if (!source || source.state !== 'acknowledged' ||
        !full.results.some(result => result.attemptId === source.attemptId &&
          result.externalTurnId === source.externalTurnId && !result.completesTask)) {
      this.#repository.recordObservationDeferred(timer.taskId, clientId,
        'managed-continuation-exact-final-not-ready');
      this.#rearmReview(timer, clientId, context, now);
      return 'deferred';
    }
    const continuationId = 'managed-continuation:' + source.attemptId;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (latest?.attemptId !== source.attemptId &&
        latest?.attemptId !== continuationId) return 'ignored';
    if (full.task.state !== 'working' || full.task.pendingDecisionId !== null) {
      this.#rearmReview(timer, clientId, context, now);
      return 'deferred';
    }
    if (latest.attemptId === source.attemptId) {
      this.#repository.planAttempt({
        taskId: timer.taskId, clientId, attemptId: continuationId,
        kind: 'continuation', turnKey: continuationId, content: context.message,
      });
    } else if (latest.state !== 'planned') {
      // A dispatched or uncertain continuation can never be sent again.
      return 'ignored';
    }
    try {
      await this.#bindAttempt({
        taskId: timer.taskId, clientId, attemptId: continuationId,
        sourceAttemptId: source.attemptId,
      });
    } catch {
      this.#repository.recordObservationDeferred(timer.taskId, clientId,
        'managed-continuation-owned-binding-unavailable');
      this.#rearmReview(timer, clientId, context, now);
      return 'deferred';
    }
    const state = await this.#kernel.dispatch(timer.taskId, clientId, continuationId);
    const current = this.#repository.getFullTask(timer.taskId, clientId);
    const attempt = current.attempts.find(row => row.attemptId === continuationId);
    if (attempt?.state === 'acknowledged') {
      this.#armFromAck(current, clientId, attempt, context);
      return 'attempted';
    }
    if (attempt?.state === 'planned' &&
        !state.cancelRequested && state.state !== 'completed') {
      this.#rearmReview(timer, clientId, context, now);
      return 'deferred';
    }
    return attempt?.state === 'uncertain' ? 'attempted' : 'ignored';
  }
}

function parseContext(raw: string): ContinuationContext | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const v = value as Partial<ContinuationContext>;
    return v.contract === 'approved_continuation_v1' &&
      typeof v.approvalRef === 'string' && v.approvalRef.length > 0 &&
      typeof v.message === 'string' && v.message.length > 0 &&
      v.intervalMs === CONTINUATION_INTERVAL_MS &&
      typeof v.sourceAttemptId === 'string' && v.sourceAttemptId.length > 0
      ? v as ContinuationContext : null;
  } catch { return null; }
}
