import type { DurableTaskKernel } from './durable-task-kernel.ts';
import type {
  AttemptRecord, FullTaskRecord, TaskKernelRepository, TimerRecord,
} from '../storage/task-kernel-repository.ts';

export const CONTINUATION_INTERVAL_MS = 20 * 60_000;
export const CONTINUATION_READ_RETRY_MIN_MS = 5_000;
const PERSISTENT_READ_LIMIT_AGENT_REVIEW_SLOT = 5;
const PERSISTENT_READ_LIMIT_AGENT_REVIEW_DELAY_MS =
  (PERSISTENT_READ_LIMIT_AGENT_REVIEW_SLOT - 1) * CONTINUATION_INTERVAL_MS;
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

interface ContinuationAgentReviewInput {
  readonly taskId: string;
  readonly clientId: string;
  readonly attemptId: string;
  readonly cause?: 'persistent_backend_read_throttle';
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
  readonly #bindInitialAttempt: ((input: {
    taskId: string; clientId: string; attemptId: string;
  }) => void | Promise<void>) | undefined;
  readonly #bindRootAttempt: ((input: {
    taskId: string; clientId: string; attemptId: string;
  }) => void | Promise<void>) | undefined;
  readonly #inspectModelIntent: ((input: {
    taskId: string; clientId: string; attemptId: string; modelIntent: string;
  }) => boolean | Promise<boolean>) | undefined;
  readonly #preparePublicTask: (() => Promise<void>) | undefined;
  readonly #requestAgentReview: ((
    input: ContinuationAgentReviewInput,
  ) => Promise<void>) | undefined;
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
    bindInitialAttempt?: (input: {
      taskId: string; clientId: string; attemptId: string;
    }) => void | Promise<void>;
    bindRootAttempt?: (input: {
      taskId: string; clientId: string; attemptId: string;
    }) => void | Promise<void>;
    inspectModelIntent?: (input: {
      taskId: string; clientId: string; attemptId: string; modelIntent: string;
    }) => boolean | Promise<boolean>;
    preparePublicTask?: () => Promise<void>;
    requestAgentReview?: (input: ContinuationAgentReviewInput) => Promise<void>;
  }) {
    this.#repository = input.repository;
    this.#kernel = input.kernel;
    this.#now = input.now ?? (() => new Date());
    this.#canRun = input.canRun ?? (() => true);
    this.#bindAttempt = input.bindAttempt ?? (() => undefined);
    this.#bindInitialAttempt = input.bindInitialAttempt;
    this.#bindRootAttempt = input.bindRootAttempt;
    this.#inspectModelIntent = input.inspectModelIntent;
    this.#preparePublicTask = input.preparePublicTask;
    this.#requestAgentReview = input.requestAgentReview;
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
    // A precisely-owned new-chat root may consume only its one journaled
    // initial attempt. The POST remains uncertain until canonical recovery.
    for (const planned of this.#repository.listPendingPublicRootInitials(8)) {
      try {
        if (planned.modelIntent !== null) {
          const verified = await this.#inspectModelIntent?.({
            taskId: planned.taskId, clientId: planned.clientId,
            attemptId: planned.attemptId, modelIntent: planned.modelIntent,
          });
          if (verified !== true) {
            this.#repository.recordObservationDeferred(planned.taskId, planned.clientId,
              'public-root-initial-model-intent-unverified');
            continue;
          }
        }
        await this.#kernel.dispatch(planned.taskId, planned.clientId, planned.attemptId);
      } catch {
        try {
          this.#repository.recordObservationDeferred(planned.taskId, planned.clientId,
            'public-root-initial-exact-preparation-unavailable');
        } catch { /* Another Task may independently become terminal. */ }
      }
    }
    // Fresh public initial work requires a verified, retained conversation.
    // Preparation still owns missing conversations; never fabricate one or
    // spend the initial attempt merely because a client asked to start.
    for (const planned of this.#repository.listPendingPublicInitials(8)) {
      try {
        await this.#bindInitialAttempt?.(planned);
        if (planned.modelIntent !== null) {
          // A requested model is not a hint to silently use whichever model
          // happens to be selected. Require explicit observed configuration
          // evidence before this initial POST may consume its attempt.
          const verified = await this.#inspectModelIntent?.({
            taskId: planned.taskId, clientId: planned.clientId,
            attemptId: planned.attemptId, modelIntent: planned.modelIntent,
          });
          if (verified !== true) {
            this.#repository.recordObservationDeferred(planned.taskId, planned.clientId,
              'public-initial-model-intent-unverified');
            continue;
          }
        }
        await this.#kernel.dispatch(planned.taskId, planned.clientId, planned.attemptId);
      } catch {
        try {
          this.#repository.recordObservationDeferred(planned.taskId, planned.clientId,
            'public-initial-exact-preparation-unavailable');
        } catch { /* Another Task may independently become terminal. */ }
      }
    }
    // A root POST is never replayed. The retained target contributes only a
    // candidate conversation ID; authenticated canonical GET proves the ACK.
    // After promotion, restore exact page/session ownership idempotently.
    for (const pending of this.#repository.listPendingPublicRootReconciliations(16)) {
      try {
        let full = this.#repository.getFullTask(pending.taskId, pending.clientId);
        let attempt = full.attempts.find(row => row.attemptId === pending.attemptId);
        let root = this.#repository.getRootPost(pending);
        if (!attempt || !root) continue;
        if (root.canonicalConversationId === null &&
            (attempt.state === 'dispatched' || attempt.state === 'uncertain')) {
          await this.#kernel.recoverAck(
            pending.taskId, pending.clientId, pending.attemptId);
          full = this.#repository.getFullTask(pending.taskId, pending.clientId);
          attempt = full.attempts.find(row => row.attemptId === pending.attemptId);
          root = this.#repository.getRootPost(pending);
        }
        if (attempt?.state === 'acknowledged' &&
            root?.canonicalConversationId !== null) {
          await this.#bindRootAttempt?.(pending);
        }
      } catch {
        try {
          this.#repository.recordObservationDeferred(pending.taskId, pending.clientId,
            'public-root-canonical-reconciliation-unavailable');
        } catch { /* Read-only recovery remains pending for the next Core tick. */ }
      }
    }
    // A followup POST can outlive its first canonical ACK read. Reconcile only
    // its persisted exact evidence; this path cannot draft, click or resend.
    for (const pending of this.#repository.listPendingPublicAcknowledgements(8)) {
      try {
        await this.#kernel.recoverAck(
          pending.taskId, pending.clientId, pending.attemptId);
      } catch {
        try {
          this.#repository.recordObservationDeferred(pending.taskId, pending.clientId,
            'public-exact-ack-reconciliation-unavailable');
        } catch { /* Read-only recovery remains pending for the next Core tick. */ }
      }
    }
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
        const observed = await this.#kernel.probeFinal({
          taskId: pending.taskId, clientId: pending.clientId,
          attemptId: pending.attemptId, resultId: 'public-final:' + pending.attemptId,
          completeTask: true,
        });
        if (observed.kind === 'pending' &&
            (observed.reason === 'backend-assistant-missing' ||
              observed.reason === 'backend-assistant-not-final')) {
          this.#scheduleFreshFinalReview(pending.taskId, pending.clientId,
            pending.attemptId, now);
        }
        if (observed.kind !== 'exact_final' &&
            (observed.reason === 'backend-http-429' ||
              observed.reason === 'backend-conversation-probe-paced') &&
            this.#requestAgentReview &&
            this.#repository.getTask(pending.taskId, pending.clientId).state === 'working' &&
            this.#hasPersistentReadLimit(pending.taskId, pending.clientId,
              pending.attemptId, now)) {
          await this.#requestAgentReview({
            taskId: pending.taskId, clientId: pending.clientId,
            attemptId: pending.attemptId, cause: 'persistent_backend_read_throttle',
          });
        }
      } catch {
        try {
          this.#repository.recordObservationDeferred(pending.taskId, pending.clientId,
            'public-exact-final-observation-unavailable');
        } catch { /* Do not convert read failure into task completion. */ }
      }
    }
    // New-root page preparation is bounded to one Task and runs AFTER due
    // sends and canonical FINAL observations: navigation cannot starve a due
    // continuation or consume an initial attempt.
    if (this.#preparePublicTask) {
      try { await this.#preparePublicTask(); }
      catch { deferred++; }
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
    if (full.task.cancelRequested || full.task.state !== 'working' ||
        full.task.pendingDecisionId !== null) return;
    const approved = full.timers.map(timer => parseContext(timer.contextJson))
      .find(context => context !== null);
    if (!approved) return;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (!latest) return;
    if (latest.state === 'acknowledged' && latest.acknowledgedAt !== null &&
        !full.results.some(result => result.attemptId === latest.attemptId)) {
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

  #rearmReadReview(
    timer: TimerRecord, clientId: string, context: ContinuationContext, now: string,
    nextCheckAt?: string | null,
  ): void {
    const nowMs = Date.parse(now);
    const requestedMs = Date.parse(nextCheckAt ?? '');
    const nextMs = Math.max(nowMs + CONTINUATION_READ_RETRY_MIN_MS,
      Number.isFinite(requestedMs) ? requestedMs : 0);
    const full = this.#repository.getFullTask(timer.taskId, clientId);
    const alreadyEarlier = full.timers.some(existing => existing.kind === TIMER_KIND &&
      existing.status === 'pending' &&
      parseContext(existing.contextJson)?.sourceAttemptId === context.sourceAttemptId &&
      Date.parse(existing.dueAt) <= nextMs);
    if (alreadyEarlier) return;
    this.#repository.scheduleTimer({
      taskId: timer.taskId, clientId,
      timerId: 'continuation-read-review:' + context.sourceAttemptId + ':' + nextMs,
      kind: TIMER_KIND, dueAt: new Date(nextMs).toISOString(),
      contextJson: JSON.stringify(context),
    });
  }

  #scheduleFreshFinalReview(
    taskId: string, clientId: string, attemptId: string, now: string,
  ): void {
    const full = this.#repository.getFullTask(taskId, clientId);
    if (full.task.cancelRequested || full.task.state !== 'working' ||
        full.task.pendingDecisionId !== null ||
        full.results.some(result => result.attemptId === attemptId)) return;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (latest?.attemptId !== attemptId) return;
    const fired = full.timers.filter(timer => timer.kind === TIMER_KIND &&
      timer.status === 'fired' &&
      parseContext(timer.contextJson)?.sourceAttemptId === attemptId).at(-1);
    if (!fired) return;
    const context = parseContext(fired.contextJson);
    if (!context) return;
    // The observer result never authorizes a POST. It only restores a prompt
    // read-only review after an older Core stretched a transient pacing race to
    // a full continuation interval; #handle performs another exact fresh read.
    this.#rearmReadReview(fired, clientId, context, now, now);
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

  /** An extended 429 is not evidence of an absent answer. The actual 429
   * opens blocked review slot one; four further twenty-minute boundaries
   * must pass before the fifth blocked slot creates durable agent review.
   * Identical pacing events are deduplicated and are not backend requests,
   * so elapsed review slots—not event or probe count—define the threshold.
   */
  #hasPersistentReadLimit(
    taskId: string, clientId: string, attemptId: string, now: string,
  ): boolean {
    const full = this.#repository.getFullTask(taskId, clientId);
    const events = full.events;
    // A resolved, read-only agent review starts a new throttle observation
    // epoch. The decision.resolved event is atomically journaled with the
    // decision receipt, so a Core crash cannot resurrect an old streak.
    const releasedReviewIds = new Set<string>();
    for (const decision of full.decisions) {
      if (decision.status !== 'resolved' || decision.resolutionJson === null) continue;
      try {
        const envelope = JSON.parse(decision.contextJson) as {
          attemptId?: unknown; packet?: { reason?: unknown };
        };
        const resolution = JSON.parse(decision.resolutionJson) as { kind?: unknown };
        if (envelope.attemptId === attemptId &&
            envelope.packet?.reason === 'canonical-final-rate-limit-persistent' &&
            resolution.kind === 'read_only_refresh') {
          releasedReviewIds.add(decision.decisionId);
        }
      } catch { /* An invalid historical receipt cannot clear rate-limit evidence. */ }
    }
    const prefix = 'final:' + attemptId + ':';
    let first429At: number | null = null;
    for (let index = events.length - 1; index >= 0; index--) {
      const entry = events[index]!;
      if (entry.event.type === 'decision.resolved' &&
          releasedReviewIds.has(entry.event.decisionId)) break;
      if (entry.event.type !== 'observation.deferred' ||
          !entry.event.reason.startsWith(prefix)) continue;
      const reason = entry.event.reason.slice(prefix.length);
      if (reason === 'pending:backend-http-429' ||
          reason === 'unavailable:backend-http-429') {
        first429At = Date.parse(entry.createdAt);
      } else if (reason !== 'pending:backend-conversation-probe-paced' &&
          reason !== 'unavailable:backend-conversation-probe-paced') {
        break;
      }
    }
    return first429At !== null && Number.isFinite(first429At) &&
      Date.parse(now) - first429At >= PERSISTENT_READ_LIMIT_AGENT_REVIEW_DELAY_MS;
  }

  async #handle(timer: TimerRecord, now: string): Promise<'attempted' | 'deferred' | 'ignored'> {
    const clientId = this.#repository.dispatchClientId(timer.taskId);
    const context = parseContext(timer.contextJson);
    if (!clientId || !context) return 'ignored';
    const full = this.#repository.getFullTask(timer.taskId, clientId);
    if (full.task.cancelRequested ||
        ['completed', 'failed', 'canceled'].includes(full.task.state)) return 'ignored';
    const source = full.attempts.find(attempt => attempt.attemptId === context.sourceAttemptId);
    if (!source || source.state !== 'acknowledged' || source.externalTurnId === null) {
      this.#repository.recordObservationDeferred(timer.taskId, clientId,
        'managed-continuation-source-ack-unverified');
      this.#rearmReview(timer, clientId, context, now);
      return 'deferred';
    }
    const continuationId = 'managed-continuation:' + source.attemptId;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (latest?.attemptId !== source.attemptId &&
        latest?.attemptId !== continuationId) return 'ignored';
    if (full.task.state !== 'working' || full.task.pendingDecisionId !== null) {
      // An agent decision holds the continuation; it must not keep a timer
      // alive or create new work while the Task is awaiting judgment.
      return 'ignored';
    }
    // An already correlated FINAL ends the automatic policy. Do not create
    // another turn merely because a timer was scheduled by older code.
    if (full.results.some(result => result.attemptId === source.attemptId)) {
      this.#repository.recordObservationDeferred(timer.taskId, clientId,
        'managed-continuation-source-final-already-recorded');
      return 'ignored';
    }
    // At the due, check the exact source answer BEFORE trying a new send.
    // A transport/read failure is not evidence of no answer.
    const observed = await this.#kernel.probeFinal({
      taskId: timer.taskId, clientId, attemptId: source.attemptId,
      resultId: 'public-final:' + source.attemptId, completeTask: true,
    });
    if (observed.kind === 'exact_final') return 'ignored';
    // Retry-After, paced GETs and unknown transport are NOT verified absence
    // of an answer. Only a fresh canonical conversation view can justify a
    // Continue. A later foreign user turn requires agent judgment instead.
    if (observed.kind === 'pending' &&
        observed.reason === 'backend-next-user-turn-before-final') {
      if (this.#requestAgentReview) {
        try {
          await this.#requestAgentReview({
            taskId: timer.taskId, clientId, attemptId: source.attemptId,
          });
          return 'deferred';
        } catch { /* Durable review unavailable: hold without a new send. */ }
      }
      this.#rearmReview(timer, clientId, context, now);
      return 'deferred';
    }
    if ((observed.reason === 'backend-http-429' ||
          observed.reason === 'backend-conversation-probe-paced') &&
        this.#requestAgentReview &&
        this.#hasPersistentReadLimit(timer.taskId, clientId, source.attemptId, now)) {
      try {
        await this.#requestAgentReview({
          taskId: timer.taskId, clientId, attemptId: source.attemptId,
          cause: 'persistent_backend_read_throttle',
        });
        return 'deferred';
      } catch { /* Unavailable handoff never licenses a speculative POST. */ }
    }
    if (observed.reason === 'backend-conversation-probe-paced') {
      this.#rearmReadReview(timer, clientId, context, now, observed.nextCheckAt);
      return 'deferred';
    }
    if (observed.kind !== 'pending' ||
        (observed.reason !== 'backend-assistant-missing' &&
          observed.reason !== 'backend-assistant-not-final')) {
      this.#rearmReview(timer, clientId, context, now);
      return 'deferred';
    }
    // An unanswered, already approved Continue is repeated lack of progress.
    // No second automatic send may be inferred from the same approval. Core
    // raises a durable agent-first packet; if that cannot be persisted, hold
    // the exact Task and retry the review without submitting anything.
    if (source.kind === 'continuation') {
      this.#repository.recordObservationDeferred(timer.taskId, clientId,
        'managed-continuation-agent-review-required');
      if (this.#requestAgentReview) {
        try {
          await this.#requestAgentReview({
            taskId: timer.taskId, clientId, attemptId: source.attemptId,
          });
          return 'deferred';
        } catch { /* Failed durable handoff is not permission to resend. */ }
      }
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
      if (this.#requestAgentReview) {
        try {
          await this.#requestAgentReview({
            taskId: timer.taskId, clientId, attemptId: continuationId,
          });
          return 'deferred';
        } catch { /* A lost binding must not trigger an unowned send. */ }
      }
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
      // The canonical answer is absent, but the current UI/lease was not
      // safely sendable. Do not silently defer the user's stuck work for
      // another 20 minutes; hand immutable evidence to the agent.
      this.#repository.recordObservationDeferred(timer.taskId, clientId,
        'managed-continuation-safe-send-agent-review-required');
      if (this.#requestAgentReview) {
        try {
          await this.#requestAgentReview({
            taskId: timer.taskId, clientId, attemptId: continuationId,
          });
          return 'deferred';
        } catch { /* A failed handoff is never permission to send. */ }
      }
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
