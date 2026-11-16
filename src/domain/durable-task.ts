/**
 * Provider-neutral public Task projection. This reducer owns state meanings;
 * SQLite persists its events and projection together in one transaction.
 * Provider UI labels, transport failures and browser lifecycle are not states.
 */
export const TASK_STATES = [
  'working',
  'agent_input_required',
  'human_input_required',
  'uncertain',
  'completed',
  'failed',
  'canceled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type AttemptKind = 'initial' | 'continuation' | 'stop';
export type DecisionAudience = 'agent' | 'human';

export interface TaskProjection {
  readonly state: TaskState;
  readonly cancelRequested: boolean;
  readonly pendingDecisionId: string | null;
}

export type TaskEvent =
  | { readonly type: 'attempt.planned'; readonly attemptId: string; readonly kind: AttemptKind }
  | { readonly type: 'attempt.dispatched'; readonly attemptId: string; readonly kind: AttemptKind }
  | { readonly type: 'attempt.dispatch_evidence_recorded'; readonly attemptId: string }
  | { readonly type: 'attempt.root_post_recorded'; readonly attemptId: string }
  | { readonly type: 'attempt.acknowledged'; readonly attemptId: string; readonly kind: AttemptKind }
  | { readonly type: 'attempt.uncertain'; readonly attemptId: string; readonly reason: string }
  | { readonly type: 'attempt.failed_before_dispatch'; readonly attemptId: string; readonly reason: string }
  | { readonly type: 'decision.required'; readonly decisionId: string; readonly audience: DecisionAudience }
  | { readonly type: 'decision.resolved'; readonly decisionId: string }
  | { readonly type: 'decision.action_consumed'; readonly decisionId: string }
  | { readonly type: 'decision.outcome_recorded'; readonly decisionId: string }
  | { readonly type: 'turn.final'; readonly attemptId: string; readonly completeTask: boolean }
  | { readonly type: 'cancel.requested' }
  | { readonly type: 'cancel.confirmed' }
  | { readonly type: 'task.failed'; readonly code: string }
  | { readonly type: 'timer.scheduled'; readonly timerId: string }
  | { readonly type: 'timer.fired'; readonly timerId: string }
  | { readonly type: 'observation.deferred'; readonly reason: string };

export const INITIAL_TASK_PROJECTION: TaskProjection = Object.freeze({
  state: 'working',
  cancelRequested: false,
  pendingDecisionId: null,
});

export function isTaskTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}

function invalid(state: TaskState, event: TaskEvent): never {
  throw new Error(`Invalid task transition: ${state} + ${event.type}`);
}

export function reduceTaskProjection(
  current: TaskProjection,
  event: TaskEvent,
): TaskProjection {
  const { state, cancelRequested, pendingDecisionId } = current;

  switch (event.type) {
    case 'attempt.planned':
    case 'attempt.dispatched': {
      if (event.kind === 'stop') {
        if (!cancelRequested || isTaskTerminal(state)) invalid(state, event);
      } else if (state !== 'working' || cancelRequested) {
        invalid(state, event);
      }
      return current;
    }
    case 'attempt.acknowledged':
      // An ACK for an old attempt is evidence, not permission to resume a
      // canceled task or issue a continuation after cancellation intent.
      if (cancelRequested || isTaskTerminal(state) || event.kind === 'stop') return current;
      return state === 'uncertain' ? { ...current, state: 'working' } : current;
    case 'attempt.uncertain':
      return isTaskTerminal(state) ? current : { ...current, state: 'uncertain' };
    case 'attempt.failed_before_dispatch':
      return current;
    case 'decision.required':
      if (state !== 'working' || cancelRequested || pendingDecisionId !== null) invalid(state, event);
      return {
        ...current,
        state: event.audience === 'agent' ? 'agent_input_required' : 'human_input_required',
        pendingDecisionId: event.decisionId,
      };
    case 'decision.resolved':
      if (pendingDecisionId !== event.decisionId || cancelRequested ||
        (state !== 'agent_input_required' && state !== 'human_input_required')) invalid(state, event);
      return { ...current, state: 'working', pendingDecisionId: null };
    case 'turn.final':
      // A late exact FINAL may be recorded after cancellation, but must never
      // resurrect the policy, enqueue a continuation, or erase uncertainty.
      if (cancelRequested || isTaskTerminal(state)) return current;
      if (state === 'agent_input_required' || state === 'human_input_required') {
        // A decision pauses new mutations, never exact result observation.
        // A terminal FINAL supersedes either waiting audience; a nonterminal
        // result must not orphan the durable pending decision.
        if (!event.completeTask) invalid(state, event);
        return { ...current, state: 'completed', pendingDecisionId: null };
      }
      if (state !== 'working' && state !== 'uncertain') invalid(state, event);
      return { ...current, state: event.completeTask ? 'completed' : 'working' };
    case 'cancel.requested':
      if (isTaskTerminal(state) || cancelRequested) invalid(state, event);
      return { state: 'uncertain', cancelRequested: true, pendingDecisionId: null };
    case 'cancel.confirmed':
      if (!cancelRequested || state !== 'uncertain') invalid(state, event);
      return { ...current, state: 'canceled' };
    case 'task.failed':
      // Ambiguous provider mutations cannot be reclassified as failure.
      if (state === 'uncertain' || isTaskTerminal(state) || cancelRequested) invalid(state, event);
      return { ...current, state: 'failed', pendingDecisionId: null };
    case 'timer.scheduled':
    case 'timer.fired':
    case 'decision.action_consumed':
    case 'decision.outcome_recorded':
    case 'attempt.dispatch_evidence_recorded':
    case 'attempt.root_post_recorded':
    case 'observation.deferred':
      return current;
  }
}
