import type { AttemptRecord, FullTaskRecord } from '../../storage/kernel/create-kernel-stores.ts';
import type { ContinuationPolicy } from './continuation-policy.ts';

export interface ContinuationSnapshot {
  readonly taskId: string;
  readonly clientId: string;
  readonly taskState: FullTaskRecord['task']['state'];
  readonly cancelRequested: boolean;
  readonly pendingDecisionId: string | null;
  readonly source: AttemptRecord | null;
  readonly latest: AttemptRecord | null;
  readonly successor: AttemptRecord | null;
  readonly sourceHasFinal: boolean;
  readonly policy: ContinuationPolicy;
}

/** Pure projection from one committed exact Task. Browser/client state is not authority. */
export function readContinuationSnapshot(
  full: FullTaskRecord, clientId: string, policy: ContinuationPolicy,
): ContinuationSnapshot {
  const source = full.attempts.find(a => a.attemptId === policy.sourceAttemptId) ?? null;
  const successor = source
    ? full.attempts.find(a => a.kind === 'continuation' && a.sequence === source.sequence + 1) ?? null
    : null;
  return {
    taskId: full.task.taskId, clientId, taskState: full.task.state,
    cancelRequested: full.task.cancelRequested,
    pendingDecisionId: full.task.pendingDecisionId,
    source, successor,
    latest: full.attempts.filter(a => a.kind !== 'stop').at(-1) ?? null,
    sourceHasFinal: full.results.some(r => r.attemptId === policy.sourceAttemptId),
    policy,
  };
}
