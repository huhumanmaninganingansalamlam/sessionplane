import type { ContinuationServices } from './continuation-services.ts';
import { CONTINUATION_INTERVAL_MS, CONTINUATION_TIMER_KIND, parseContinuationPolicy } from './continuation-policy.ts';
import type { ContinuationPolicy } from './continuation-policy.ts';
import { armFromAck, rearmReadReview, rearmReview, hasPersistentReadLimit } from './continuation-timers.ts';
import { readContinuationSnapshot } from './continuation-snapshot.ts';
import { planContinuationStep } from './continuation-planner.ts';
import type { ContinuationPlan } from './continuation-planner.ts';
import type { TimerRecord } from '../../storage/kernel/create-kernel-stores.ts';

export function activateContinuation(services: ContinuationServices, input: {
    taskId: string; clientId: string; sourceAttemptId: string;
    approvalRef: string; message: string; agentReviewAfterMs?: number;
  }): TimerRecord {
    if (input.approvalRef.trim().length === 0 || input.approvalRef.length > 512 ||
        input.message.trim().length === 0 || input.message.length > 4_096 ||
        (input.agentReviewAfterMs !== undefined &&
          (!Number.isSafeInteger(input.agentReviewAfterMs) ||
           input.agentReviewAfterMs < CONTINUATION_INTERVAL_MS))) {
      throw new Error('Explicit bounded continuation approval and message required');
    }
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
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
    const slot = services.repository.projects.getConversationSlot(
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
    const existingPending = full.timers.find(timer => {
      if (timer.kind !== CONTINUATION_TIMER_KIND || timer.status !== 'pending') return false;
      const context = parseContinuationPolicy(timer.contextJson);
      return context?.sourceAttemptId === source.attemptId &&
        context.approvalRef === input.approvalRef && context.message === input.message;
    });
    if (existingPending) return existingPending;
    const prior = full.timers.filter(timer => timer.kind === CONTINUATION_TIMER_KIND)
      .map(timer => parseContinuationPolicy(timer.contextJson))
      .filter((value): value is ContinuationPolicy => value !== null)
      .filter(context => context.approvalRef === input.approvalRef &&
        context.message === input.message).at(-1);
    return armFromAck(services, full, input.clientId, source, {
      contract: 'approved_continuation_v1',
      approvalRef: input.approvalRef,
      intervalMs: CONTINUATION_INTERVAL_MS,
      message: input.message,
      sourceAttemptId: source.attemptId,
      stagnationSince: prior?.stagnationSince ?? source.acknowledgedAt,
      ...(input.agentReviewAfterMs === undefined ? {} : {
        agentReviewAfterMs: input.agentReviewAfterMs,
      }),
    });
  }

export function resumeAfterAgentDecision(services: ContinuationServices, input: {
    taskId: string; clientId: string; attemptId: string; mode: 'wait' | 'resume';
  }): TimerRecord {
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    if (full.task.cancelRequested || full.task.state !== 'working' ||
        full.task.pendingDecisionId !== null) {
      throw new Error('Agent continuation resume requires the exact working Task');
    }
    const attempt = full.attempts.find(row => row.attemptId === input.attemptId);
    const latest = full.attempts.filter(row => row.kind !== 'stop').at(-1);
    if (!attempt || latest?.attemptId !== attempt.attemptId ||
        attempt.kind !== 'continuation' || attempt.state !== 'acknowledged' ||
        attempt.acknowledgedAt === null ||
        full.results.some(result => result.attemptId === attempt.attemptId)) {
      throw new Error('Agent continuation resume requires the current unanswered ACK');
    }
    const context = full.timers.filter(timer => timer.kind === CONTINUATION_TIMER_KIND)
      .map(timer => parseContinuationPolicy(timer.contextJson))
      .filter((value): value is ContinuationPolicy => value !== null)
      .at(-1);
    if (!context) throw new Error('Approved continuation policy is unavailable');
    const now = services.now().toISOString();
    const dueAt = input.mode === 'resume' ? now
      : new Date(Date.parse(now) + context.intervalMs).toISOString();
    const next: ContinuationPolicy = {
      ...context, sourceAttemptId: attempt.attemptId,
      ...(input.mode === 'resume' ? { stagnationSince: now } : {}),
    };
    return services.repository.timers.scheduleTaskTimer({
      taskId: input.taskId, clientId: input.clientId,
      timerId: `continuation-agent-${input.mode}:${attempt.attemptId}:${Date.parse(dueAt)}`,
      kind: CONTINUATION_TIMER_KIND, dueAt, contextJson: JSON.stringify(next),
    });
  }

export type ContinuationDueOutcome = 'attempted' | 'deferred' | 'ignored';
export type ContinuationReviewOutcome = { kind: 'requested' } |
  { kind: 'unavailable'; reason: 'no_delegate' | 'agent_review_unavailable' };

export async function requestContinuationAgentReview(
  services: ContinuationServices,
  input: { taskId: string; clientId: string; attemptId: string;
    cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress' },
): Promise<ContinuationReviewOutcome> {
  if (!services.requestAgentReview) return { kind: 'unavailable', reason: 'no_delegate' };
  try {
    await services.requestAgentReview(input);
    return { kind: 'requested' };
  } catch {
    return { kind: 'unavailable', reason: 'agent_review_unavailable' };
  }
}

export function scheduleContinuationRead(
  services: ContinuationServices, timer: TimerRecord, clientId: string,
  policy: ContinuationPolicy, now: string, nextCheckAt?: string | null,
): void {
  rearmReadReview(services, timer, clientId, policy, now, nextCheckAt);
}

export function planContinuationAttempt(
  services: ContinuationServices,
  input: { readonly taskId: string; readonly clientId: string; readonly attemptId: string;
    readonly turnKey: string; readonly message: string },
): void {
  services.repository.attempts.planAttempt({
    taskId: input.taskId, clientId: input.clientId, attemptId: input.attemptId,
    kind: 'continuation', turnKey: input.turnKey, content: input.message,
  });
}

export async function dispatchContinuationAttempt(
  services: ContinuationServices, timer: TimerRecord, clientId: string,
  policy: ContinuationPolicy, now: string, attemptId: string,
): Promise<ContinuationDueOutcome> {
  try {
    await services.bindAttempt({
      taskId: timer.taskId, clientId, attemptId,
      sourceAttemptId: policy.sourceAttemptId,
    });
  } catch {
    services.repository.tasks.recordObservationDeferred(timer.taskId, clientId,
      'managed-continuation-owned-binding-unavailable');
    const review = await requestContinuationAgentReview(services, {
      taskId: timer.taskId, clientId, attemptId,
    });
    if (review.kind !== 'requested') rearmReview(services, timer, clientId, policy, now);
    return 'deferred';
  }
  const state = await services.kernel.dispatch(timer.taskId, clientId, attemptId);
  const current = services.repository.tasks.readTaskAggregate(timer.taskId, clientId);
  const attempt = current.attempts.find(row => row.attemptId === attemptId);
  if (attempt?.state === 'acknowledged') {
    armFromAck(services, current, clientId, attempt, policy);
    return 'attempted';
  }
  if (attempt?.state === 'planned' &&
      !state.cancelRequested && state.state !== 'completed') {
    services.repository.tasks.recordObservationDeferred(timer.taskId, clientId,
      'managed-continuation-safe-send-agent-review-required');
    const review = await requestContinuationAgentReview(services, {
      taskId: timer.taskId, clientId, attemptId,
    });
    if (review.kind !== 'requested') rearmReview(services, timer, clientId, policy, now);
    return 'deferred';
  }
  return attempt?.state === 'uncertain' ? 'attempted' : 'ignored';
}

/** Side effects are dispatched solely from the pure send/no-send plan. */
export async function applyContinuationPlan(
  services: ContinuationServices, timer: TimerRecord, clientId: string,
  policy: ContinuationPolicy, now: string, plan: ContinuationPlan,
): Promise<ContinuationDueOutcome> {
  switch (plan.kind) {
    case 'complete_from_final':
    case 'ignore_terminal_or_stale':
      return 'ignored';
    case 'defer_for_streaming':
      scheduleContinuationRead(services, timer, clientId, policy, now, now);
      return 'deferred';
    case 'defer_for_read_fence':
      scheduleContinuationRead(services, timer, clientId, policy, now, plan.nextCheckAt);
      return 'deferred';
    case 'defer_for_unavailable_observation':
      if (plan.reason === 'source_ack_unverified') {
        services.repository.tasks.recordObservationDeferred(timer.taskId, clientId,
          'managed-continuation-source-ack-unverified');
      }
      rearmReview(services, timer, clientId, policy, now);
      return 'deferred';
    case 'request_agent_review': {
      if (plan.reason === 'no_progress_policy_reached') {
        services.repository.tasks.recordObservationDeferred(timer.taskId, clientId,
          'managed-continuation-no-progress-policy-reached');
      }
      const review = await requestContinuationAgentReview(services, {
        taskId: timer.taskId, clientId, attemptId: plan.sourceAttemptId,
        ...(plan.cause ? { cause: plan.cause } : {}),
      });
      if (review.kind !== 'requested') rearmReview(services, timer, clientId, policy, now);
      return 'deferred';
    }
    case 'plan_attempt':
      planContinuationAttempt(services, {
        taskId: timer.taskId, clientId,
        attemptId: plan.attemptId, turnKey: plan.turnKey, message: plan.message,
      });
      return await dispatchContinuationAttempt(services, timer, clientId, policy, now, plan.attemptId);
    case 'dispatch_planned_attempt':
      return await dispatchContinuationAttempt(services, timer, clientId, policy, now, plan.attemptId);
  }
}

/** Exact FINAL observation happens before the planner may authorize another
 * Attempt. Unavailable reads, streaming and 429 cannot license a POST.
 */
export async function executeDueContinuationTimer(
  services: ContinuationServices, timer: TimerRecord, now: string,
): Promise<ContinuationDueOutcome> {
  const clientId = services.repository.tasks.findDispatchClientId(timer.taskId);
  const policy = parseContinuationPolicy(timer.contextJson);
  if (!clientId || !policy) return 'ignored';
  const full = services.repository.tasks.readTaskAggregate(timer.taskId, clientId);
  const snapshot = readContinuationSnapshot(full, clientId, policy);
  const { source, latest } = snapshot;
  if (snapshot.cancelRequested || ['completed', 'failed', 'canceled'].includes(snapshot.taskState) ||
      snapshot.taskState !== 'working' || snapshot.pendingDecisionId !== null) return 'ignored';
  if (!source || source.state !== 'acknowledged' || source.externalTurnId === null) {
    return await applyContinuationPlan(services, timer, clientId, policy, now,
      planContinuationStep(snapshot, { kind: 'unavailable', reason: 'source-ack-unverified' }, now));
  }
  const continuationId = snapshot.successor?.attemptId ?? (source.kind === 'initial'
    ? 'managed-continuation:' + source.attemptId
    : 'managed-continuation:' + timer.taskId + ':' + (source.sequence + 1));
  if (!latest || (latest.attemptId !== source.attemptId && latest.attemptId !== continuationId)) {
    return 'ignored';
  }
  if (snapshot.sourceHasFinal) {
    services.repository.tasks.recordObservationDeferred(timer.taskId, clientId,
      'managed-continuation-source-final-already-recorded');
    return 'ignored';
  }
  const observed = await services.kernel.probeFinal({
    taskId: timer.taskId, clientId, attemptId: source.attemptId,
    resultId: 'public-final:' + source.attemptId, completeTask: true, readPriority: 'due',
  });
  const reason = observed.kind === 'exact_final' ? null : observed.reason;
  const readLimitPolicyReached = (reason === 'backend-http-429' ||
    reason === 'backend-conversation-probe-paced') &&
    policy.agentReviewAfterMs !== undefined && Boolean(services.requestAgentReview) &&
    hasPersistentReadLimit(services, timer.taskId, clientId, source.attemptId,
      now, policy.agentReviewAfterMs);
  const plan = planContinuationStep(snapshot, observed, now, { readLimitPolicyReached });
  return await applyContinuationPlan(services, timer, clientId, policy, now, plan);
}
