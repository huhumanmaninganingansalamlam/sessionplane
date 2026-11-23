

import type { OwnedPageIdentity } from '../../browser/owned-page-lifecycle.ts';

import type { SemanticTaskContext } from '../../providers/semantic-adapter.ts';

import type { KernelStores, AttemptSessionBindingRecord } from '../../storage/kernel/create-kernel-stores.ts';

import type { ExactSendIntent } from '../durable-task-kernel.ts';

import type { SemanticRuntimeDependencies } from './runtime-types.ts';
import type { createExactLeaseGuard } from "./page-lease.ts";

export function createAttemptSessionBinder(input: SemanticRuntimeDependencies, repository: KernelStores) {
const bindAttemptSession = (owner: {
    taskId: string; clientId: string; attemptId: string;
    sessionId: string; generation: number; conversationId: string;
  }): AttemptSessionBindingRecord => {
    const task = repository.tasks.getTask(owner.taskId, owner.clientId);
    const slot = repository.projects.getConversationSlot(task.projectId, task.slotId, owner.clientId);
    const session = input.teamDirectory.getSession(owner.sessionId);
    if (slot.activeTaskId !== task.taskId ||
        task.slotRevision !== slot.revision || slot.providerKey !== 'chatgpt' ||
        session.teamId !== task.projectId || session.roleKey !== task.slotId ||
        session.provider !== 'chatgpt' || session.generation !== owner.generation ||
        session.conversationId !== owner.conversationId || session.pageKey === null ||
        slot.providerConversationId !== owner.conversationId) {
      throw new Error('Attempt does not own this exact ChatGPT session generation');
    }
    const binding = input.pageRegistry.getBinding(session.pageKey);
    if (binding.state !== 'owned' || binding.targetId === null ||
        binding.sessionId !== owner.sessionId ||
        binding.generation !== owner.generation ||
        binding.conversationId !== owner.conversationId ||
        binding.expectedConversationId !== owner.conversationId) {
      throw new Error('Attempt session generation is not bound to one owned page');
    }
    return repository.attempts.bindAttemptSessionGeneration(owner);
  };
  return bindAttemptSession;
}


export function createExactContextResolver(input: SemanticRuntimeDependencies, repository: KernelStores, isExactLease: ReturnType<typeof createExactLeaseGuard>) {
const resolveContext = (intent: ExactSendIntent): SemanticTaskContext => {
    const task = repository.tasks.getTask(intent.taskId, intent.clientId);
    const slot = repository.projects.getConversationSlot(intent.projectId, intent.slotId, intent.clientId);
    const binding = repository.projects.getSlotBindingAtRevision(intent.projectId, intent.slotId,
      intent.slotRevision, intent.clientId);
    if (task.projectId !== intent.projectId || task.slotId !== intent.slotId ||
      task.slotRevision !== intent.slotRevision || binding.providerKey !== 'chatgpt' ||
      binding.providerConversationId !== intent.providerConversationId) {
      throw new Error('Semantic context differs from the immutable task binding');
    }
    // Historical ACK/FINAL must survive cancellation and a slot replacement.
    // Only the still-active exact slot may gain an actionable Page lease.
    const activeSlot = slot.activeTaskId === intent.taskId &&
      slot.revision === intent.slotRevision && slot.providerKey === 'chatgpt' &&
      slot.providerConversationId === intent.providerConversationId;
    const attemptBinding = repository.attempts.getAttemptSessionBinding({
      taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId,
    });
    const matches = !activeSlot || intent.providerConversationId === null ||
      attemptBinding === null ? [] :
      input.pageRegistry.findByConversation(intent.providerConversationId)
        .filter(found => found.state === 'owned' && found.targetId !== null &&
          found.sessionId === attemptBinding.sessionId &&
          found.generation === attemptBinding.generation &&
          found.conversationId === attemptBinding.conversationId);
    let candidate: OwnedPageIdentity | null = matches.length === 1 ? {
      projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
      taskId: intent.taskId, pageKey: matches[0]!.pageKey,
      targetId: matches[0]!.targetId!, bindingEpoch: matches[0]!.bindingEpoch,
    } : null;
    const evidence = repository.attempts.getDispatchEvidence({
      taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId,
    });
    const full = repository.tasks.readTaskAggregate(intent.taskId, intent.clientId);
    const attempt = full.attempts.find(row => row.attemptId === intent.attemptId);
    if (candidate === null && activeSlot && intent.providerConversationId === null &&
        attempt?.kind === 'initial' &&
        ['planned', 'dispatched', 'uncertain'].includes(attempt.state)) {
      try {
        const session = input.teamDirectory.getCurrentSession(intent.projectId, intent.slotId);
        const root = session.pageKey === null ? null :
          input.pageRegistry.getBinding(session.pageKey);
        if (root?.state === 'reserved' && typeof root.targetId === 'string' &&
            root.sessionId === session.sessionId && session.generation > 0 &&
            root.generation === session.generation &&
            root.conversationId === null && root.expectedConversationId === null &&
            session.conversationId === null && session.pageKey !== null &&
            root.pageKey === session.pageKey) {
          candidate = {
            projectId: intent.projectId, slotId: intent.slotId,
            slotRevision: intent.slotRevision, taskId: intent.taskId,
            pageKey: session.pageKey, targetId: root.targetId,
            bindingEpoch: root.bindingEpoch,
          };
        }
      } catch { candidate = null; /* Missing root is preparation, never send authority. */ }
    }
    let submittedUserMessageId = evidence?.messageId ?? null;
    let submittedUserTurnId = attempt?.externalTurnId ?? null;
    if (attempt?.kind === 'continuation' && evidence === null &&
        submittedUserTurnId === null) {
      // The approved Continue answers an unanswered exact ACK. Before the
      // new POST, inspect only its immediately preceding bound user turn;
      // requiring a FINAL here would invert the no-response product contract.
      const previous = full.attempts.find(row =>
        row.sequence === attempt.sequence - 1 && row.kind !== 'stop' &&
        row.state === 'acknowledged' && row.externalTurnId !== null);
      if (previous) {
        const precedingEvidence = repository.attempts.getDispatchEvidence({
          taskId: intent.taskId, clientId: intent.clientId, attemptId: previous.attemptId,
        });
        const precedingBinding = repository.attempts.getAttemptSessionBinding({
          taskId: intent.taskId, clientId: intent.clientId, attemptId: previous.attemptId,
        });
        if (precedingEvidence?.conversationId === intent.providerConversationId &&
            precedingBinding && attemptBinding &&
            precedingBinding.sessionId === attemptBinding.sessionId &&
            precedingBinding.generation === attemptBinding.generation &&
            precedingBinding.conversationId === attemptBinding.conversationId) {
          submittedUserMessageId = precedingEvidence.messageId;
          submittedUserTurnId = previous.externalTurnId;
        }
      }
    }
    return {
      projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
      taskId: intent.taskId, providerConversationId: intent.providerConversationId,
      submittedUserMessageId,
      submittedUserTurnId,
      ...(repository.projects.readPublicModelIntent(intent.projectId, intent.clientId)
        ? { requiredModel: repository.projects.readPublicModelIntent(intent.projectId, intent.clientId) } : {}),
      permissionGrants: repository.tasks.readPublicPermissionGrants(intent.taskId, intent.clientId),
      pageLease: activeSlot && candidate !== null && isExactLease(candidate) ? candidate : null,
    };
  };
  return resolveContext;
}
