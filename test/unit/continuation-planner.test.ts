import assert from 'node:assert/strict';
import test from 'node:test';
import type { AttemptRecord } from '../../src/storage/kernel/create-kernel-stores.ts';
import {
  CONTINUATION_INTERVAL_MS, nextContinuationDueAt,
  parseContinuationPolicy, validateContinuationPolicy,
} from '../../src/core/continuation/continuation-policy.ts';
import type { ContinuationSnapshot } from '../../src/core/continuation/continuation-snapshot.ts';
import { planContinuationStep } from '../../src/core/continuation/continuation-planner.ts';

const ack: AttemptRecord = {
  taskId: 'task', attemptId: 'original', sequence: 1, kind: 'initial',
  turnKey: 'root', content: 'exact prompt', state: 'acknowledged',
  externalTurnId: 'user:1', dispatchedAt: '2026-11-23T00:00:00.000Z',
  acknowledgedAt: '2026-11-23T00:00:00.000Z',
};
const noFinal = { kind: 'pending', reason: 'backend-assistant-missing' } as const;
const now = '2026-11-23T00:20:00.000Z';
const approved: ContinuationSnapshot['policy'] = {
  contract: 'approved_continuation_v1', approvalRef: 'exact-delegation',
  intervalMs: CONTINUATION_INTERVAL_MS, message: '계속', sourceAttemptId: 'original',
  stagnationSince: ack.acknowledgedAt!,
};
function snapshot(partial: Partial<ContinuationSnapshot> = {}): ContinuationSnapshot {
  return {
    taskId: 'task', clientId: 'owner', taskState: 'working',
    cancelRequested: false, pendingDecisionId: null, policy: approved,
    source: ack, latest: ack, successor: null, sourceHasFinal: false,
    ...partial,
  };
}

test('planner is pure and admits new Continue only after fresh exact no-FINAL on the owned ACK', () => {
  const input = snapshot();
  const before = JSON.stringify(input);
  const plan = planContinuationStep(input, noFinal, now);
  assert.deepEqual(plan, {
    kind: 'plan_attempt', sourceAttemptId: 'original', reason: 'fresh_exact_no_final',
    attemptId: 'managed-continuation:original', turnKey: 'managed-after:original', message: '계속',
  });
  assert.equal(JSON.stringify(input), before, 'pure planner mutates no snapshot');
  assert.equal(nextContinuationDueAt(ack.acknowledgedAt!), now);
  assert.throws(() => nextContinuationDueAt(ack.acknowledgedAt!, 5_000), /approved interval/);
});

test('eight semantic plan variants preserve exact source and prohibit unsafe resend', () => {
  const cases = [
    [snapshot(), { kind: 'exact_final', result: { resultId: 'final',
      taskId: 'task', attemptId: 'original', externalTurnId: 'turn',
      answerText: 'exact', completesTask: true, observedAt: now } }, 'complete_from_final'],
    [snapshot(), { kind: 'streaming' }, 'defer_for_streaming'],
    [snapshot(), { kind: 'pending', reason: 'backend-http-429',
      nextCheckAt: '2026-11-23T00:35:00.000Z' }, 'defer_for_read_fence'],
    [snapshot(), { kind: 'unavailable', reason: 'backend-timeout' }, 'defer_for_unavailable_observation'],
    [snapshot(), { kind: 'pending', reason: 'backend-next-user-turn-before-final' }, 'request_agent_review'],
    [snapshot(), noFinal, 'plan_attempt'],
    [snapshot({ successor: { ...ack, attemptId: 'managed-continuation:original',
      state: 'planned', externalTurnId: null, sequence: 2, kind: 'continuation',
      acknowledgedAt: null }, latest: { ...ack, attemptId: 'managed-continuation:original',
      state: 'planned', externalTurnId: null, sequence: 2, kind: 'continuation',
      acknowledgedAt: null } }), noFinal, 'dispatch_planned_attempt'],
    [snapshot({ taskState: 'completed' }), noFinal, 'ignore_terminal_or_stale'],
  ] as const;
  for (const [state, observation, expected] of cases) {
    const plan = planContinuationStep(state, observation, now);
    assert.equal(plan.kind, expected);
    assert.equal(plan.sourceAttemptId, 'original');
  }
});

test('pending decisions, cancellation, unconfirmed ACK and ambiguous POST never license a new attempt', () => {
  assert.equal(planContinuationStep(snapshot({ cancelRequested: true }), noFinal, now).kind,
    'ignore_terminal_or_stale');
  assert.equal(planContinuationStep(snapshot({ pendingDecisionId: 'd' }), noFinal, now).kind,
    'ignore_terminal_or_stale');
  assert.equal(planContinuationStep(snapshot({ source: { ...ack, state: 'uncertain',
    externalTurnId: null } }), noFinal, now).kind, 'defer_for_unavailable_observation');
  assert.equal(planContinuationStep(snapshot({ sourceHasFinal: true }), noFinal, now).kind,
    'ignore_terminal_or_stale');
  const submitted = { ...ack, attemptId: 'managed-continuation:original',
    sequence: 2, kind: 'continuation' as const, state: 'uncertain' as const };
  assert.equal(planContinuationStep(snapshot({ successor: submitted, latest: submitted }), noFinal, now).kind,
    'ignore_terminal_or_stale');
  assert.equal(planContinuationStep(snapshot(), { kind: 'pending', reason: 'backend-http-429' }, now).kind,
    'defer_for_unavailable_observation');
});

test('only explicit stagnation policy requests agent review, and approved resume can plan another due', () => {
  const continued = { ...ack, attemptId: 'continue-2', sequence: 2,
    kind: 'continuation' as const, acknowledgedAt: '2026-11-23T00:00:00.000Z' };
  const state = snapshot({
    source: continued, latest: continued,
    policy: { ...approved, sourceAttemptId: 'continue-2', agentReviewAfterMs: 1_200_000 },
  });
  const noProgress = planContinuationStep(state, noFinal, now);
  assert.equal(noProgress.kind, 'request_agent_review');
  if (noProgress.kind === 'request_agent_review') assert.equal(noProgress.cause, 'repeated_no_progress');
  const resumed = snapshot({ ...state, policy: { ...state.policy, stagnationSince: now } });
  const ready = planContinuationStep(resumed, noFinal, now);
  assert.equal(ready.kind, 'plan_attempt');
  assert.equal(planContinuationStep(state,
    { kind: 'pending', reason: 'backend-http-429' }, now, { readLimitPolicyReached: true }).kind,
    'request_agent_review');
  assert.equal(planContinuationStep(snapshot(),
    { kind: 'pending', reason: 'backend-http-429' }, now, { readLimitPolicyReached: true }).kind,
    'defer_for_unavailable_observation');
});

test('approved persisted timer policy validation is exact and fails closed', () => {
  assert.equal(parseContinuationPolicy(JSON.stringify(approved))?.sourceAttemptId, 'original');
  assert.equal(parseContinuationPolicy('{}'), null);
  assert.equal(parseContinuationPolicy('invalid-json'), null);
  assert.equal(validateContinuationPolicy({ ...approved, intervalMs: 2_000 }), false);
  assert.equal(validateContinuationPolicy({ ...approved, message: '' }), false);
  assert.equal(validateContinuationPolicy({ ...approved, agentReviewAfterMs: 100 }), false);
});
