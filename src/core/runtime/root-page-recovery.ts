

import type { SemanticRootPostEvidence, SemanticTaskContext } from '../../providers/semantic-adapter.ts';

import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';

import type { SemanticRuntimeDependencies } from './runtime-types.ts';


export function createRootPageCandidateReader(input: SemanticRuntimeDependencies, repository: KernelStores) {
const rootPageCandidate = (owner: {
    taskId: string; clientId: string; attemptId: string;
  }, expectedConversationId: string | null = null) => {
    const root = repository.attempts.getRootDispatchEvidence(owner);
    if (!root || root.ambiguous || root.observationCount !== 1) return null;
    const retained = input.pageRegistry.listBindings({ includeClosed: false })
      .filter(binding => binding.targetId === root.targetId);
    if (retained.length !== 1) return null;
    let binding = input.pageRegistry.refreshPage(retained[0]!.pageKey);
    if (binding.targetId !== root.targetId) return null;
    if (binding.state === 'unbound' && binding.sessionId === null &&
        binding.generation === null && binding.conversationId !== null) {
      binding = input.pageRegistry.reserveUnknownConversationCandidate(binding.pageKey, {
        sessionId: root.sessionId, generation: root.generation, targetId: root.targetId,
      });
    }
    if (binding.state === 'identity_lost') {
      binding = input.pageRegistry.unknownConversationCandidate(binding.pageKey, {
        sessionId: root.sessionId, generation: root.generation,
      }).binding;
    } else if (binding.state !== 'owned' || binding.sessionId !== root.sessionId ||
        binding.generation !== root.generation || binding.conversationId === null ||
        binding.expectedConversationId !== binding.conversationId ||
        input.pageRegistry.findByConversation(binding.conversationId).length !== 1) {
      return null;
    }
    const conversationId = binding.conversationId;
    if (conversationId === null || !/^[A-Za-z0-9_-]{1,160}$/.test(conversationId) ||
        (root.requestConversationId !== null &&
          root.requestConversationId !== conversationId) ||
        (expectedConversationId !== null && expectedConversationId !== conversationId)) {
      return null;
    }
    try {
      const url = new URL(binding.url);
      if (url.origin !== new URL(input.chatgptUrl).origin ||
          url.pathname !== `/c/${encodeURIComponent(conversationId)}` ||
          url.search !== '' || url.hash !== '') return null;
    } catch { return null; }
    return { root, binding, conversationId };
  };
  return rootPageCandidate;
}


export function createRootRecoveryPageResolver(input: SemanticRuntimeDependencies, repository: KernelStores, rootPageCandidate: ReturnType<typeof createRootPageCandidateReader>) {
const resolveRootRecoveryPage = (request: {
    context: SemanticTaskContext; conversationId: string; root: SemanticRootPostEvidence;
  }) => {
    const { context, conversationId, root } = request;
    if (context.pageLease !== null || context.providerConversationId !== null ||
        context.submittedUserMessageId !== null || context.submittedUserTurnId !== null) return null;
    const clientId = repository.tasks.findDispatchClientId(context.taskId);
    if (!clientId) return null;
    try {
      const full = repository.tasks.readTaskAggregate(context.taskId, clientId);
      const task = full.task;
      const slot = repository.projects.getConversationSlot(task.projectId, task.slotId, clientId);
      if (task.projectId !== context.projectId || task.slotId !== context.slotId ||
          task.slotRevision !== context.slotRevision || slot.activeTaskId !== task.taskId ||
          slot.revision !== task.slotRevision || slot.providerKey !== 'chatgpt' ||
          slot.providerConversationId !== null) return null;
      const attempts = full.attempts.filter(attempt => {
        if (attempt.kind !== 'initial' || !['dispatched', 'uncertain'].includes(attempt.state)) return false;
        const stored = repository.attempts.getRootDispatchEvidence({
          taskId: context.taskId, clientId, attemptId: attempt.attemptId,
        });
        return stored !== null && !stored.ambiguous && stored.observationCount === 1 &&
          stored.canonicalConversationId === null && stored.messageId === root.messageId &&
          stored.parentMessageId === root.parentMessageId && stored.textHash === root.textHash &&
          stored.observedAt === root.observedAt;
      });
      if (attempts.length !== 1) return null;
      const candidate = rootPageCandidate({
        taskId: context.taskId, clientId, attemptId: attempts[0]!.attemptId,
      }, conversationId);
      if (!candidate || candidate.root.messageId !== root.messageId ||
          candidate.root.parentMessageId !== root.parentMessageId ||
          candidate.root.textHash !== root.textHash || candidate.root.observedAt !== root.observedAt) {
        return null;
      }
      return input.pageRegistry.pageForObservation(
        candidate.binding.pageKey, candidate.binding.bindingEpoch);
    } catch { return null; }
  };
  return resolveRootRecoveryPage;
}


export function createRootAttemptBinder(input: SemanticRuntimeDependencies, repository: KernelStores, rootPageCandidate: ReturnType<typeof createRootPageCandidateReader>) {
const bindRootAttempt = async (owner: {
    taskId: string; clientId: string; attemptId: string;
  }): Promise<void> => {
    if (!input.actorScheduler) throw new Error('Root ACK actor scheduler unavailable');
    const full = repository.tasks.readTaskAggregate(owner.taskId, owner.clientId);
    const attempt = full.attempts.find(row => row.attemptId === owner.attemptId);
    const root = repository.attempts.getRootDispatchEvidence(owner);
    if (!attempt || attempt.state !== 'acknowledged' || attempt.externalTurnId === null ||
        !root?.canonicalConversationId) {
      throw new Error('Canonical root ACK is not durable');
    }
    const task = full.task;
    const slot = repository.projects.getConversationSlot(task.projectId, task.slotId, owner.clientId);
    if (slot.activeTaskId !== task.taskId || slot.revision !== task.slotRevision ||
        slot.providerKey !== 'chatgpt' ||
        slot.providerConversationId !== root.canonicalConversationId) {
      throw new Error('Canonical root ACK lost its exact active slot');
    }
    const candidate = rootPageCandidate(owner, root.canonicalConversationId);
    if (!candidate) throw new Error('Canonical root page target is unavailable');
    const owned = candidate.binding.state === 'owned'
      ? candidate.binding
      : input.pageRegistry.bindPage(candidate.binding.pageKey, {
          sessionId: root.sessionId, generation: root.generation,
          conversationId: root.canonicalConversationId,
        });
    if (owned.state !== 'owned' || owned.targetId !== root.targetId ||
        owned.sessionId !== root.sessionId || owned.generation !== root.generation ||
        owned.conversationId !== root.canonicalConversationId ||
        owned.expectedConversationId !== root.canonicalConversationId) {
      throw new Error('Canonical root page ownership could not be established');
    }
    const session = input.teamDirectory.getSession(root.sessionId);
    if (session.teamId !== task.projectId || session.roleKey !== task.slotId ||
        session.provider !== 'chatgpt' || session.generation !== root.generation ||
        (session.conversationId !== null &&
          session.conversationId !== root.canonicalConversationId) ||
        (session.pageKey !== null && session.pageKey !== owned.pageKey) ||
        (session.submittedUserMessageId !== null &&
          session.submittedUserMessageId !== root.messageId) ||
        (session.submittedUserTurnId !== null &&
          session.submittedUserTurnId !== attempt.externalTurnId)) {
      throw new Error('Canonical root ACK conflicts with the current session actor');
    }
    const alreadyBound = session.conversationId === root.canonicalConversationId &&
      session.pageKey === owned.pageKey &&
      session.submittedUserMessageId === root.messageId &&
      session.submittedUserTurnId === attempt.externalTurnId &&
      session.submissionState === 'submitted' && session.promptSubmitted;
    if (alreadyBound) return;
    await input.actorScheduler.updateGeneration(root.sessionId, root.generation, {
      ...(session.terminal ? {} : {
        sessionState: 'submitted' as const,
        providerState: 'generating' as const,
        observationTransport: 'fresh' as const,
      }),
      submissionState: 'submitted', conversationId: root.canonicalConversationId,
      pageKey: owned.pageKey, submittedUserMessageId: root.messageId,
      submittedUserTurnId: attempt.externalTurnId, promptSubmitted: true,
      reason: 'canonical-root-acknowledgement', errorCode: null,
    }, 'public.task.root-acknowledged');
  };
  return bindRootAttempt;
}
