import type { AttemptKind, DecisionAudience, TaskEvent, TaskProjection } from '../../domain/durable-task.ts';

export interface ProjectRecord {
  readonly projectId: string;
  readonly projectKey: string;
  readonly displayName: string;
}
export interface SlotRecord {
  readonly projectId: string;
  readonly slotId: string;
  readonly roleKey: string;
  readonly providerKey: string;
  readonly providerConversationId: string | null;
  readonly revision: number;
  readonly activeTaskId: string | null;
}
export interface SlotBindingRecord {
  readonly projectId: string;
  readonly slotId: string;
  readonly revision: number;
  readonly providerKey: string;
  readonly providerConversationId: string | null;
}
export interface TaskRecord extends TaskProjection {
  readonly taskId: string;
  readonly projectId: string;
  readonly slotId: string;
  readonly slotRevision: number;
  readonly clientId: string;
  readonly requestId: string;
  readonly originalPrompt: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type AttemptState =
  | 'planned' | 'dispatched' | 'acknowledged' | 'uncertain' | 'failed_before_dispatch';
export interface AttemptRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly kind: AttemptKind;
  readonly turnKey: string;
  readonly content: string;
  readonly state: AttemptState;
  readonly externalTurnId: string | null;
  readonly dispatchedAt: string | null;
  readonly acknowledgedAt: string | null;
}
/** Durable, bounded POST provenance. The prompt body remains only in the
 * existing attempt record; evidence stores its hash and exact message edges.
 */
export interface AttemptSessionBindingRecord {
  readonly attemptId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly conversationId: string;
  readonly boundAt: string;
}
export interface DispatchEvidenceRecord {
  readonly conversationId: string;
  readonly messageId: string;
  readonly parentMessageId: string;
  readonly textHash: string;
  readonly observedAt: string;
}
/** The unique first POST before the provider creates/binds its conversation. */
export interface RootDispatchEvidenceRecord {
  readonly sessionId: string;
  readonly generation: number;
  readonly pageKey: string;
  readonly targetId: string;
  readonly bindingEpoch: number;
  readonly observationCount: number;
  readonly ambiguous: boolean;
  readonly messageId: string;
  readonly parentMessageId: string;
  readonly textHash: string;
  readonly observedAt: string;
  readonly requestConversationId: string | null;
  readonly canonicalConversationId: string | null;
}
export interface DecisionRecord {
  readonly decisionId: string;
  readonly taskId: string;
  readonly audience: DecisionAudience;
  readonly contextJson: string;
  readonly status: 'pending' | 'resolved' | 'superseded';
  readonly resolutionJson: string | null;
  readonly actionConsumed: boolean;
}
export interface TimerRecord {
  readonly timerId: string;
  readonly taskId: string;
  readonly kind: string;
  readonly dueAt: string;
  readonly contextJson: string;
  readonly status: 'pending' | 'fired' | 'canceled';
}
export interface ResultRecord {
  readonly resultId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly externalTurnId: string;
  readonly answerText: string;
  readonly completesTask: boolean;
  readonly observedAt: string;
}
export interface TaskEventRecord {
  readonly taskRevision: number;
  readonly event: TaskEvent;
  readonly createdAt: string;
}
export interface FullTaskRecord {
  readonly task: TaskRecord;
  readonly attempts: readonly AttemptRecord[];
  readonly decisions: readonly DecisionRecord[];
  readonly timers: readonly TimerRecord[];
  readonly results: readonly ResultRecord[];
  readonly events: readonly TaskEventRecord[];
}

