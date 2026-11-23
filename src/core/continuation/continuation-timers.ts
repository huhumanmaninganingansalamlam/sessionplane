import type { FullTaskRecord, AttemptRecord, TimerRecord } from '../../storage/kernel/create-kernel-stores.ts';
import type { ContinuationServices } from './continuation-services.ts';
import { CONTINUATION_INTERVAL_MS, CONTINUATION_READ_RETRY_MIN_MS,
  CONTINUATION_DUE_READ_RESERVATION_MS, CONTINUATION_TIMER_KIND,
  parseContinuationPolicy, nextContinuationDueAt } from './continuation-policy.ts';
import type { ContinuationPolicy } from './continuation-policy.ts';

export function upcomingDueRead(services: ContinuationServices,
    taskId: string, clientId: string, now: string,
  ): { attemptId: string; dueAt: string } | null {
    const nowMs = Date.parse(now);
    if (!Number.isFinite(nowMs)) return null;
    try {
      const full = services.repository.tasks.readTaskAggregate(taskId, clientId);
      if (full.task.cancelRequested || full.task.state !== 'working' ||
          full.task.pendingDecisionId !== null) return null;
      const candidates = full.timers.flatMap(timer => {
        const context = parseContinuationPolicy(timer.contextJson);
        if (timer.kind !== CONTINUATION_TIMER_KIND || timer.status !== 'pending' || context === null) return [];
        const dueMs = Date.parse(timer.dueAt);
        if (!Number.isFinite(dueMs) || dueMs <= nowMs ||
            dueMs - nowMs > CONTINUATION_DUE_READ_RESERVATION_MS) return [];
        const source = full.attempts.find(row => row.attemptId === context.sourceAttemptId);
        if (source?.state !== 'acknowledged' || source.externalTurnId === null ||
            full.results.some(result => result.attemptId === source.attemptId)) return [];
        return [{ attemptId: source.attemptId, dueAt: timer.dueAt, dueMs }];
      }).sort((left, right) => left.dueMs - right.dueMs);
      return candidates.length === 0 ? null : {
        attemptId: candidates[0]!.attemptId, dueAt: candidates[0]!.dueAt,
      };
    } catch {
      return null;
    }
  }

export function armFromAck(services: ContinuationServices,
    full: FullTaskRecord, clientId: string, source: AttemptRecord,
    approved: ContinuationPolicy,
  ): TimerRecord {
    if (source.acknowledgedAt === null || source.state !== 'acknowledged') {
      throw new Error('No exact ACK for managed due timer');
    }
    const dueAt = nextContinuationDueAt(source.acknowledgedAt, approved.intervalMs);
    return services.repository.timers.scheduleTaskTimer({
      taskId: full.task.taskId, clientId,
      timerId: 'continuation-due:' + source.attemptId,
      kind: CONTINUATION_TIMER_KIND, dueAt,
      contextJson: JSON.stringify({ ...approved, sourceAttemptId: source.attemptId,
        stagnationSince: approved.stagnationSince ?? source.acknowledgedAt }),
    });
  }

export function reconcileOwner(services: ContinuationServices, taskId: string, clientId: string, now: string): void {
    const full = services.repository.tasks.readTaskAggregate(taskId, clientId);
    if (full.task.cancelRequested || full.task.state !== 'working' ||
        full.task.pendingDecisionId !== null) return;
    const approved = full.timers.map(timer => parseContinuationPolicy(timer.contextJson))
      .find(context => context !== null);
    if (!approved) return;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (!latest) return;
    if (latest.state === 'acknowledged' && latest.acknowledgedAt !== null &&
        !full.results.some(result => result.attemptId === latest.attemptId)) {
      armFromAck(services, full, clientId, latest, approved);
    }
    // Recover a claimed due timer after a crash before planning or rearming.
    // Skip missed slots rather than issuing a burst of historical Continue.
    const sourceTimer = full.timers.filter(timer => timer.kind === CONTINUATION_TIMER_KIND &&
      parseContinuationPolicy(timer.contextJson)?.sourceAttemptId ===
        (latest.kind === 'continuation' && latest.state === 'planned'
          ? full.attempts.find(row => row.sequence === latest.sequence - 1)?.attemptId
          : latest.attemptId)).at(-1);
    if (sourceTimer?.status === 'fired' &&
        !full.timers.some(timer => timer.status === 'pending' && timer.kind === CONTINUATION_TIMER_KIND &&
          parseContinuationPolicy(timer.contextJson)?.sourceAttemptId ===
          parseContinuationPolicy(sourceTimer.contextJson)?.sourceAttemptId)) {
      const context = parseContinuationPolicy(sourceTimer.contextJson);
      if (context && (latest.state === 'planned' || latest.state === 'acknowledged')) {
        rearmReview(services, sourceTimer, clientId, context, now);
      }
    }
  }

export function rearmReadReview(services: ContinuationServices,
    timer: TimerRecord, clientId: string, context: ContinuationPolicy, now: string,
    nextCheckAt?: string | null,
  ): void {
    const nowMs = Date.parse(now);
    const requestedMs = Date.parse(nextCheckAt ?? '');
    const nextMs = Math.max(nowMs + CONTINUATION_READ_RETRY_MIN_MS,
      Number.isFinite(requestedMs) ? requestedMs : 0);
    const full = services.repository.tasks.readTaskAggregate(timer.taskId, clientId);
    const alreadyEarlier = full.timers.some(existing => existing.kind === CONTINUATION_TIMER_KIND &&
      existing.status === 'pending' &&
      parseContinuationPolicy(existing.contextJson)?.sourceAttemptId === context.sourceAttemptId &&
      Date.parse(existing.dueAt) <= nextMs);
    if (alreadyEarlier) return;
    services.repository.timers.scheduleTaskTimer({
      taskId: timer.taskId, clientId,
      timerId: 'continuation-read-review:' + context.sourceAttemptId + ':' + nextMs,
      kind: CONTINUATION_TIMER_KIND, dueAt: new Date(nextMs).toISOString(),
      contextJson: JSON.stringify(context),
    });
  }

export function scheduleFreshFinalReview(services: ContinuationServices,
    taskId: string, clientId: string, attemptId: string, now: string,
  ): void {
    const full = services.repository.tasks.readTaskAggregate(taskId, clientId);
    if (full.task.cancelRequested || full.task.state !== 'working' ||
        full.task.pendingDecisionId !== null ||
        full.results.some(result => result.attemptId === attemptId)) return;
    const latest = full.attempts.filter(attempt => attempt.kind !== 'stop').at(-1);
    if (latest?.attemptId !== attemptId) return;
    const fired = full.timers.filter(timer => timer.kind === CONTINUATION_TIMER_KIND &&
      timer.status === 'fired' &&
      parseContinuationPolicy(timer.contextJson)?.sourceAttemptId === attemptId).at(-1);
    if (!fired) return;
    const context = parseContinuationPolicy(fired.contextJson);
    if (!context) return;
    // The observer result never authorizes a POST. It only restores a prompt
    // read-only review after an older Core stretched a transient pacing race to
    // a full continuation interval; #handle performs another exact fresh read.
    rearmReadReview(services, fired, clientId, context, now, now);
  }

export function rearmReview(services: ContinuationServices,
    timer: TimerRecord, clientId: string, context: ContinuationPolicy, now: string,
  ): void {
    const nextMs = Date.parse(timer.dueAt) +
      (Math.floor(Math.max(0, Date.parse(now) - Date.parse(timer.dueAt)) /
        context.intervalMs) + 1) * context.intervalMs;
    services.repository.timers.scheduleTaskTimer({
      taskId: timer.taskId, clientId,
      timerId: 'continuation-review:' + context.sourceAttemptId + ':' + nextMs,
      kind: CONTINUATION_TIMER_KIND,
      dueAt: new Date(nextMs).toISOString(),
      contextJson: JSON.stringify(context),
    });
  }

export function hasPersistentReadLimit(services: ContinuationServices,
    taskId: string, clientId: string, attemptId: string, now: string,
    reviewAfterMs: number,
  ): boolean {
    const full = services.repository.tasks.readTaskAggregate(taskId, clientId);
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
      } catch { continue; }
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
      Date.parse(now) - first429At >= reviewAfterMs;
  }
