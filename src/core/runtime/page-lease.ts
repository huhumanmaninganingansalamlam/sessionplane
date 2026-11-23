

import type { OwnedPageIdentity } from '../../browser/owned-page-lifecycle.ts';

import type { SemanticTaskContext } from '../../providers/semantic-adapter.ts';

import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';

import type { SemanticRuntimeDependencies } from './runtime-types.ts';


export function createActiveTaskReader(input: SemanticRuntimeDependencies, repository: KernelStores) {
const activeTask = (identity: OwnedPageIdentity) => {
    const clientId = repository.tasks.findDispatchClientId(identity.taskId);
    if (!clientId) return null;
    try {
      const task = repository.tasks.getTask(identity.taskId, clientId);
      const slot = repository.projects.getConversationSlot(identity.projectId, identity.slotId, clientId);
      if (task.projectId !== identity.projectId || task.slotId !== identity.slotId ||
        task.slotRevision !== identity.slotRevision || task.cancelRequested ||
        !['working', 'agent_input_required', 'human_input_required', 'uncertain'].includes(task.state) ||
        slot.activeTaskId !== identity.taskId || slot.revision !== identity.slotRevision ||
        slot.providerKey !== 'chatgpt' || slot.providerConversationId === null) return null;
      const full = repository.tasks.readTaskAggregate(identity.taskId, clientId);
      const unresolved = full.attempts.filter(attempt =>
        attempt.kind !== 'stop' && attempt.state !== 'failed_before_dispatch' &&
        !full.results.some(result => result.attemptId === attempt.attemptId));
      const latest = unresolved.at(-1);
      if (!latest) return null;
      // An approved repeated continuation policy can leave several exact ACKs
      // without a FINAL. They are one contiguous turn chain, not competing
      // mutations. Every predecessor must be acknowledged and every turn must
      // retain the same immutable session generation and conversation.
      let chainBinding: ReturnType<typeof repository.attempts.getAttemptSessionBinding> = null;
      for (let index = 0; index < unresolved.length; index += 1) {
        const attempt = unresolved[index]!;
        if (index > 0) {
          const previous = unresolved[index - 1]!;
          if (attempt.kind !== 'continuation' || attempt.sequence !== previous.sequence + 1) return null;
        }
        if (index < unresolved.length - 1 &&
            (attempt.state !== 'acknowledged' || attempt.externalTurnId === null)) return null;
        const bound = repository.attempts.getAttemptSessionBinding({
          taskId: identity.taskId, clientId, attemptId: attempt.attemptId,
        });
        if (!bound) return null;
        if (chainBinding !== null &&
            (chainBinding.sessionId !== bound.sessionId ||
             chainBinding.generation !== bound.generation ||
             chainBinding.conversationId !== bound.conversationId)) return null;
        chainBinding = bound;
      }
      const sessionBinding = repository.attempts.getAttemptSessionBinding({
        taskId: identity.taskId, clientId, attemptId: latest.attemptId,
      });
      if (sessionBinding?.conversationId !== slot.providerConversationId) return null;
      return { clientId, slot, sessionBinding };
    } catch { return null; }
  };
  return activeTask;
}


export function createExactLeaseGuard(input: SemanticRuntimeDependencies, repository: KernelStores, activeTask: ReturnType<typeof createActiveTaskReader>) {
const isExactLease = (identity: OwnedPageIdentity): boolean => {
    // A new conversation has no provider ID until its FIRST POST. The
    // reserved root page still has exact Task/session/generation ownership,
    // but is usable solely for pre-send model/login decisions.
    const owner = repository.tasks.findDispatchClientId(identity.taskId);
    if (owner) {
      try {
        const current = repository.tasks.getTask(identity.taskId, owner);
        const slot = repository.projects.getConversationSlot(identity.projectId, identity.slotId, owner);
        if (current.projectId === identity.projectId &&
            current.slotId === identity.slotId &&
            current.slotRevision === identity.slotRevision &&
            !current.cancelRequested &&
            ['working', 'agent_input_required'].includes(current.state) &&
            slot.activeTaskId === identity.taskId &&
            slot.revision === identity.slotRevision &&
            slot.providerKey === 'chatgpt' && slot.providerConversationId === null) {
          const session = input.teamDirectory.getCurrentSession(identity.projectId, identity.slotId);
          const page = input.pageRegistry.getBinding(identity.pageKey);
          const url = new URL(page.url);
          return session.provider === 'chatgpt' && session.generation > 0 &&
            session.pageKey === page.pageKey && session.conversationId === null &&
            page.state === 'reserved' && page.targetId === identity.targetId &&
            page.bindingEpoch === identity.bindingEpoch &&
            page.sessionId === session.sessionId && page.generation === session.generation &&
            page.conversationId === null && page.expectedConversationId === null &&
            url.origin === new URL(input.chatgptUrl).origin &&
            url.pathname === '/' && url.search === '' && url.hash === '';
        }
      } catch { return false; }
    }
    const task = activeTask(identity);
    if (!task) return false;
    try {
      const binding = input.pageRegistry.getBinding(identity.pageKey);
      if (binding.state !== 'owned' || binding.targetId !== identity.targetId ||
        binding.bindingEpoch !== identity.bindingEpoch ||
        binding.conversationId !== task.slot.providerConversationId ||
        binding.sessionId !== task.sessionBinding.sessionId ||
        binding.generation !== task.sessionBinding.generation) return false;
      const session = input.teamDirectory.getSession(binding.sessionId);
      return session.teamId === identity.projectId && session.roleKey === identity.slotId &&
        session.provider === 'chatgpt' && session.pageKey === binding.pageKey &&
        session.conversationId === binding.conversationId &&
        session.generation === task.sessionBinding.generation;
    } catch { return false; }
  };
  return isExactLease;
}


export function createRootDispatchPageResolver(input: SemanticRuntimeDependencies, repository: KernelStores) {
const exactRootDispatchPage = (owner: {
    context: SemanticTaskContext; attemptId: string; lease: OwnedPageIdentity;
  }) => {
    const { context, attemptId, lease } = owner;
    if (context.providerConversationId !== null || context.pageLease === null ||
        context.projectId !== lease.projectId || context.slotId !== lease.slotId ||
        context.slotRevision !== lease.slotRevision || context.taskId !== lease.taskId ||
        context.pageLease.pageKey !== lease.pageKey ||
        context.pageLease.targetId !== lease.targetId ||
        context.pageLease.bindingEpoch !== lease.bindingEpoch) return null;
    const clientId = repository.tasks.findDispatchClientId(context.taskId);
    if (!clientId) return null;
    try {
      const full = repository.tasks.readTaskAggregate(context.taskId, clientId);
      const task = full.task;
      const attempt = full.attempts.find(row => row.attemptId === attemptId);
      const slot = repository.projects.getConversationSlot(context.projectId, context.slotId, clientId);
      if (task.projectId !== context.projectId || task.slotId !== context.slotId ||
          task.slotRevision !== context.slotRevision || slot.activeTaskId !== task.taskId ||
          slot.revision !== task.slotRevision || slot.providerKey !== 'chatgpt' ||
          slot.providerConversationId !== null || attempt?.kind !== 'initial' ||
          !['dispatched', 'uncertain', 'acknowledged'].includes(attempt.state)) return null;
      const session = input.teamDirectory.getCurrentSession(context.projectId, context.slotId);
      const binding = input.pageRegistry.refreshPage(lease.pageKey);
      if (session.provider !== 'chatgpt' || session.generation < 1 ||
          session.pageKey !== binding.pageKey || session.conversationId !== null ||
          binding.targetId !== lease.targetId || binding.sessionId !== session.sessionId ||
          binding.generation !== session.generation ||
          binding.expectedConversationId !== null) return null;
      const url = new URL(binding.url);
      const origin = new URL(input.chatgptUrl).origin;
      if (url.origin !== origin || url.search !== '' || url.hash !== '') return null;
      if (binding.state === 'reserved' && binding.bindingEpoch === lease.bindingEpoch &&
          binding.conversationId === null && url.pathname === '/') {
        return { clientId, session, binding, conversationId: null as string | null };
      }
      const conversationId = binding.conversationId;
      if (binding.state !== 'identity_lost' ||
          binding.bindingEpoch !== lease.bindingEpoch + 1 ||
          conversationId === null || !/^[A-Za-z0-9_-]{1,160}$/.test(conversationId) ||
          url.pathname !== `/c/${encodeURIComponent(conversationId)}` ||
          input.pageRegistry.findByConversation(conversationId).length !== 1) return null;
      return { clientId, session, binding, conversationId };
    } catch { return null; }
  };
  return exactRootDispatchPage;
}


export function createRootTransitionGuard(input: SemanticRuntimeDependencies, repository: KernelStores, exactRootDispatchPage: ReturnType<typeof createRootDispatchPageResolver>) {
const isRootDispatchTransition = (owner: {
    context: SemanticTaskContext; attemptId: string; lease: OwnedPageIdentity;
  }): boolean => {
    const exact = exactRootDispatchPage(owner);
    if (!exact?.conversationId) return false;
    try {
      const root = repository.attempts.getRootDispatchEvidence({
        taskId: owner.context.taskId, clientId: exact.clientId,
        attemptId: owner.attemptId,
      });
      return root !== null && !root.ambiguous && root.observationCount === 1 &&
        root.canonicalConversationId === null && root.pageKey === owner.lease.pageKey &&
        root.targetId === owner.lease.targetId &&
        root.bindingEpoch === owner.lease.bindingEpoch &&
        root.sessionId === exact.session.sessionId &&
        root.generation === exact.session.generation &&
        (root.requestConversationId === null ||
          root.requestConversationId === exact.conversationId);
    } catch { return false; }
  };
  return isRootDispatchTransition;
}
