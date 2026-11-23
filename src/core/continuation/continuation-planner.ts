import type { FinalProbeOutcome } from '../durable-task-kernel.ts';
import type { ContinuationSnapshot } from './continuation-snapshot.ts';

export type ContinuationReason =
  | 'terminal_or_canceled' | 'stale_source_turn' | 'agent_decision_pending'
  | 'source_ack_unverified' | 'final_already_recorded' | 'exact_final'
  | 'streaming_in_progress' | 'canonical_read_rate_limited' | 'canonical_read_unavailable'
  | 'no_exact_no_final_evidence' | 'later_foreign_user_turn' | 'read_limit_policy_reached'
  | 'no_progress_policy_reached' | 'dispatch_already_attempted'
  | 'fresh_exact_no_final' | 'existing_planned_attempt';

export type ContinuationPlan =
  | { readonly kind: 'complete_from_final'; readonly sourceAttemptId: string; readonly reason: 'exact_final' }
  | { readonly kind: 'defer_for_streaming'; readonly sourceAttemptId: string; readonly reason: 'streaming_in_progress' }
  | { readonly kind: 'defer_for_read_fence'; readonly sourceAttemptId: string;
      readonly reason: 'canonical_read_rate_limited'; readonly nextCheckAt: string | null }
  | { readonly kind: 'defer_for_unavailable_observation'; readonly sourceAttemptId: string;
      readonly reason: 'source_ack_unverified' | 'canonical_read_unavailable' | 'no_exact_no_final_evidence' }
  | { readonly kind: 'request_agent_review'; readonly sourceAttemptId: string;
      readonly reason: 'later_foreign_user_turn' | 'read_limit_policy_reached' | 'no_progress_policy_reached';
      readonly cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress' }
  | { readonly kind: 'plan_attempt'; readonly sourceAttemptId: string;
      readonly reason: 'fresh_exact_no_final'; readonly attemptId: string; readonly turnKey: string;
      readonly message: string }
  | { readonly kind: 'dispatch_planned_attempt'; readonly sourceAttemptId: string;
      readonly reason: 'existing_planned_attempt'; readonly attemptId: string }
  | { readonly kind: 'ignore_terminal_or_stale'; readonly sourceAttemptId: string;
      readonly reason: 'terminal_or_canceled' | 'stale_source_turn' | 'agent_decision_pending' |
        'final_already_recorded' | 'dispatch_already_attempted' };

export type ContinuationObservation = FinalProbeOutcome | { readonly kind: 'streaming' };
export interface ContinuationPlanningFacts {
  /** Only an explicitly approved agentReviewAfterMs may escalate repeated 429. */
  readonly readLimitPolicyReached?: boolean;
}

/** The only authorization for creating another approved Continue attempt.
 * A read failure or an outstanding external POST can never enter plan_attempt.
 */
export function planContinuationStep(
  snapshot: ContinuationSnapshot, observation: ContinuationObservation, now: string,
  facts: ContinuationPlanningFacts = {},
): ContinuationPlan {
  const { source, latest, successor, sourceHasFinal, policy } = snapshot;
  const sourceAttemptId = policy.sourceAttemptId;
  const ignore = (reason: Extract<ContinuationPlan, { kind: 'ignore_terminal_or_stale' }>['reason']):
    ContinuationPlan => ({ kind: 'ignore_terminal_or_stale', sourceAttemptId, reason });
  if (snapshot.cancelRequested ||
      ['completed', 'failed', 'canceled'].includes(snapshot.taskState)) {
    return ignore('terminal_or_canceled');
  }
  if (snapshot.taskState !== 'working' || snapshot.pendingDecisionId !== null) {
    return ignore('agent_decision_pending');
  }
  if (sourceHasFinal) return ignore('final_already_recorded');
  if (!source || source.state !== 'acknowledged' || source.externalTurnId === null) {
    return { kind: 'defer_for_unavailable_observation', sourceAttemptId,
      reason: 'source_ack_unverified' };
  }
  const nextId = successor?.attemptId ?? (source.kind === 'initial'
    ? 'managed-continuation:' + source.attemptId
    : 'managed-continuation:' + snapshot.taskId + ':' + (source.sequence + 1));
  if (!latest || (latest.attemptId !== source.attemptId && latest.attemptId !== nextId)) {
    return ignore('stale_source_turn');
  }
  if (observation.kind === 'exact_final') {
    return { kind: 'complete_from_final', sourceAttemptId, reason: 'exact_final' };
  }
  if (observation.kind === 'streaming' ||
      (observation.kind === 'pending' && observation.reason === 'provider-streaming')) {
    return { kind: 'defer_for_streaming', sourceAttemptId, reason: 'streaming_in_progress' };
  }
  if (observation.kind === 'pending' &&
      observation.reason === 'backend-next-user-turn-before-final') {
    return { kind: 'request_agent_review', sourceAttemptId, reason: 'later_foreign_user_turn' };
  }
  const reason = observation.reason;
  if ((reason === 'backend-http-429' || reason === 'backend-conversation-probe-paced') &&
      facts.readLimitPolicyReached && policy.agentReviewAfterMs !== undefined) {
    return { kind: 'request_agent_review', sourceAttemptId,
      reason: 'read_limit_policy_reached', cause: 'persistent_backend_read_throttle' };
  }
  if (reason === 'backend-conversation-probe-paced' ||
      (reason === 'backend-http-429' &&
       observation.nextCheckAt != null)) {
    return { kind: 'defer_for_read_fence', sourceAttemptId,
      reason: 'canonical_read_rate_limited', nextCheckAt: observation.nextCheckAt ?? null };
  }
  if (observation.kind !== 'pending' ||
      (reason !== 'backend-assistant-missing' && reason !== 'backend-assistant-not-final')) {
    return { kind: 'defer_for_unavailable_observation', sourceAttemptId,
      reason: observation.kind === 'unavailable' ? 'canonical_read_unavailable' :
        'no_exact_no_final_evidence' };
  }
  const stagnationMs = Date.parse(policy.stagnationSince ?? source.acknowledgedAt ?? '');
  if (source.kind === 'continuation' && policy.agentReviewAfterMs !== undefined &&
      Number.isFinite(stagnationMs) &&
      Date.parse(now) - stagnationMs >= policy.agentReviewAfterMs) {
    return { kind: 'request_agent_review', sourceAttemptId,
      reason: 'no_progress_policy_reached', cause: 'repeated_no_progress' };
  }
  if (latest.attemptId === source.attemptId) {
    return { kind: 'plan_attempt', sourceAttemptId, reason: 'fresh_exact_no_final',
      attemptId: nextId, turnKey: 'managed-after:' + source.attemptId,
      message: policy.message };
  }
  if (latest.state === 'planned' && latest.attemptId === nextId) {
    return { kind: 'dispatch_planned_attempt', sourceAttemptId,
      reason: 'existing_planned_attempt', attemptId: nextId };
  }
  return ignore('dispatch_already_attempted');
}
