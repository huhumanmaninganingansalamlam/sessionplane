import { createHash } from 'node:crypto';

import type { SemanticTaskContext } from '../../providers/semantic-adapter.ts';

import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';

import { parseDecisionEnvelope } from '../decisions/decision-envelope.ts';

import type { SemanticRuntimeDependencies } from './runtime-types.ts';
import type { createExactLeaseGuard } from "./page-lease.ts";

export function sameDecisionContext(expected: SemanticTaskContext, actual: unknown): boolean {
  if (actual === null || typeof actual !== 'object') return false;
  const packet = actual as Partial<SemanticTaskContext>;
  const original = expected.pageLease;
  const retained = packet.pageLease;
  if (!original || !retained || typeof retained !== 'object') return false;
  return packet.projectId === expected.projectId &&
    packet.slotId === expected.slotId && packet.slotRevision === expected.slotRevision &&
    packet.taskId === expected.taskId &&
    packet.providerConversationId === expected.providerConversationId &&
    packet.submittedUserMessageId === expected.submittedUserMessageId &&
    packet.submittedUserTurnId === expected.submittedUserTurnId &&
    retained.projectId === original.projectId &&
    retained.slotId === original.slotId &&
    retained.slotRevision === original.slotRevision &&
    retained.taskId === original.taskId &&
    retained.pageKey === original.pageKey &&
    retained.targetId === original.targetId &&
    retained.bindingEpoch === original.bindingEpoch;
}

export function createAttemptAuthorizationGuard(input: SemanticRuntimeDependencies, repository: KernelStores) {
const authorizedAttempt = (input: {
    context: SemanticTaskContext; purpose: string; attemptId: string;
    contentSha256: string | null;
  }): boolean => {
    const { context, purpose, attemptId, contentSha256 } = input;
    if (!contentSha256 || (purpose !== 'submit' && purpose !== 'continue')) return false;
    const clientId = repository.tasks.findDispatchClientId(context.taskId);
    if (!clientId) return false;
    try {
      const task = repository.tasks.getTask(context.taskId, clientId);
      const slot = repository.projects.getConversationSlot(context.projectId, context.slotId, clientId);
      const attempt = repository.tasks.readTaskAggregate(context.taskId, clientId).attempts
        .find(row => row.attemptId === attemptId);
      return task.projectId === context.projectId && task.slotId === context.slotId &&
        task.slotRevision === context.slotRevision && slot.activeTaskId === context.taskId &&
        slot.revision === context.slotRevision &&
        slot.providerConversationId === context.providerConversationId &&
        attempt?.state === 'dispatched' &&
        attempt.kind === (purpose === 'submit' ? 'initial' : 'continuation') &&
        createHash('sha256').update(attempt.content.replaceAll('\r\n', '\n')).digest('hex') === contentSha256;
    } catch { return false; }
  };
  return authorizedAttempt;
}


export function createDecisionAuthorizationGuard(input: SemanticRuntimeDependencies, repository: KernelStores, isExactLease: ReturnType<typeof createExactLeaseGuard>) {
const authorizedDecision = (approval: {
    context: SemanticTaskContext;
    purpose: 'open_model_chooser' | 'close_model_chooser' |
      'choose_model' | 'choose_reasoning_effort' | 'answer_question' |
      'grant_permission' | 'decline_permission' | 'activate_control' |
      'set_control_value' | 'retry';
    decisionId: string; snapshotId: string; actionRef: string;
    evidenceHash: string; input: string | null;
  }): boolean => {
    const { context } = approval;
    if (!context.pageLease || !isExactLease(context.pageLease)) return false;
    const clientId = repository.tasks.findDispatchClientId(context.taskId);
    if (!clientId) return false;
    try {
      const full = repository.tasks.readTaskAggregate(context.taskId, clientId);
      if (full.task.cancelRequested ||
          full.task.state === 'completed' || full.task.state === 'failed' ||
          full.task.state === 'canceled') return false;
      const row = full.decisions.find(entry => entry.decisionId === approval.decisionId);
      if (!row || row.status !== 'resolved' || row.actionConsumed ||
          row.resolutionJson === null) return false;
      // The provider's one-shot authorization uses the same versioned
      // Decision contract as the agent gateway. A historical v1 action is
      // never executable after migration, even if its raw JSON still exists.
      const envelope = parseDecisionEnvelope(row.contextJson);
      if (envelope.schemaVersion !== 2) return false;
      const resolution: unknown = JSON.parse(row.resolutionJson);
      if (!resolution || typeof resolution !== 'object' ||
          Array.isArray(resolution)) return false;
      const receipt = resolution as Record<string, unknown>;
      const storedAction = envelope.actions.find(candidate =>
        candidate.purpose === approval.purpose &&
        candidate.snapshotId === approval.snapshotId &&
        candidate.actionRef === approval.actionRef &&
        candidate.evidenceHash === approval.evidenceHash);
      if (!sameDecisionContext(context, envelope.context) || !storedAction ||
          receipt.kind !== 'semantic_action' ||
          receipt.actionRef !== approval.actionRef ||
          receipt.input !== approval.input) return false;
      return repository.decisions.consumeDecisionAction(context.taskId, clientId, approval.decisionId);
    } catch { return false; }
  };
  return authorizedDecision;
}
