import { createHash } from 'node:crypto';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { OwnedPageIdentity } from '../browser/owned-page-lifecycle.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import type { ChatGptBackendRecovery, BackendJsonClient } from '../providers/chatgpt/backend-recovery.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import { ChatGptSemanticAdapter, chatGptBackendJsonClient } from '../providers/chatgpt/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { SemanticTaskContext } from '../providers/semantic-adapter.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { TaskKernelRepository } from '../storage/task-kernel-repository.ts';
import { DurableTaskKernel, type ExactSendIntent } from './durable-task-kernel.ts';
import { SemanticExactTaskPort } from './semantic-exact-task-port.ts';
import type { TeamDirectory } from './team-directory.ts';

export interface SemanticCoreRuntime {
  readonly providers: SemanticProviderRegistry;
  readonly repository: TaskKernelRepository;
  readonly kernel: DurableTaskKernel;
}

/** One journal, browser owner, and page mutex for the new Core path.
 * This assembly never creates another browser/DB writer or registers a
 * competing legacy RPC route.
 */
export function createSemanticCoreRuntime(input: {
  readonly database: SessionPlaneDatabase;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly teamDirectory: TeamDirectory;
  readonly pageMutationMutex: PageMutationMutex;
  readonly enabledProviders: readonly string[];
  readonly chatgptUrl: string;
  readonly backendClientProvider?: () => BackendJsonClient | Promise<BackendJsonClient>;
  readonly backendRecovery?: ChatGptBackendRecovery;
}): SemanticCoreRuntime {
  const repository = new TaskKernelRepository(input.database);
  const activeTask = (identity: OwnedPageIdentity) => {
    const clientId = repository.dispatchClientId(identity.taskId);
    if (!clientId) return null;
    try {
      const task = repository.getTask(identity.taskId, clientId);
      const slot = repository.getSlot(identity.projectId, identity.slotId, clientId);
      if (task.projectId !== identity.projectId || task.slotId !== identity.slotId ||
        task.slotRevision !== identity.slotRevision ||
        slot.activeTaskId !== identity.taskId || slot.revision !== identity.slotRevision ||
        slot.providerKey !== 'chatgpt' || slot.providerConversationId === null) return null;
      return { clientId, slot };
    } catch { return null; }
  };
  const isExactLease = (identity: OwnedPageIdentity): boolean => {
    const task = activeTask(identity);
    if (!task) return false;
    try {
      const binding = input.pageRegistry.getBinding(identity.pageKey);
      if (binding.state !== 'owned' || binding.targetId !== identity.targetId ||
        binding.bindingEpoch !== identity.bindingEpoch ||
        binding.conversationId !== task.slot.providerConversationId ||
        binding.sessionId === null) return false;
      const session = input.teamDirectory.getSession(binding.sessionId);
      return session.teamId === identity.projectId && session.roleKey === identity.slotId &&
        session.provider === 'chatgpt' && session.pageKey === binding.pageKey &&
        session.conversationId === binding.conversationId &&
        session.generation === binding.generation;
    } catch { return false; }
  };
  const resolveContext = (intent: ExactSendIntent): SemanticTaskContext => {
    const task = repository.getTask(intent.taskId, intent.clientId);
    const slot = repository.getSlot(intent.projectId, intent.slotId, intent.clientId);
    const binding = repository.getBindingAtRevision(intent.projectId, intent.slotId,
      intent.slotRevision, intent.clientId);
    if (task.projectId !== intent.projectId || task.slotId !== intent.slotId ||
      task.slotRevision !== intent.slotRevision || slot.activeTaskId !== intent.taskId ||
      slot.revision !== intent.slotRevision || slot.providerKey !== 'chatgpt' ||
      binding.providerConversationId !== intent.providerConversationId ||
      slot.providerConversationId !== intent.providerConversationId) {
      throw new Error('Semantic context differs from the current journaled task');
    }
    const matches = intent.providerConversationId === null ? [] :
      input.pageRegistry.findByConversation(intent.providerConversationId)
        .filter(found => found.state === 'owned' && found.targetId !== null);
    const candidate: OwnedPageIdentity | null = matches.length === 1 ? {
      projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
      taskId: intent.taskId, pageKey: matches[0]!.pageKey,
      targetId: matches[0]!.targetId!, bindingEpoch: matches[0]!.bindingEpoch,
    } : null;
    const evidence = repository.getDispatchEvidence({
      taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId,
    });
    const attempt = repository.getFullTask(intent.taskId, intent.clientId).attempts
      .find(row => row.attemptId === intent.attemptId);
    return {
      projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
      taskId: intent.taskId, providerConversationId: intent.providerConversationId,
      submittedUserMessageId: evidence?.messageId ?? null,
      submittedUserTurnId: attempt?.externalTurnId ?? null,
      pageLease: candidate !== null && isExactLease(candidate) ? candidate : null,
    };
  };
  const authorizedAttempt = (input: {
    context: SemanticTaskContext; purpose: string; attemptId: string;
    contentSha256: string | null;
  }): boolean => {
    const { context, purpose, attemptId, contentSha256 } = input;
    if (!contentSha256 || (purpose !== 'submit' && purpose !== 'continue')) return false;
    const clientId = repository.dispatchClientId(context.taskId);
    if (!clientId) return false;
    try {
      const task = repository.getTask(context.taskId, clientId);
      const slot = repository.getSlot(context.projectId, context.slotId, clientId);
      const attempt = repository.getFullTask(context.taskId, clientId).attempts
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
  const providers = new SemanticProviderRegistry(input.enabledProviders.includes('chatgpt') ? [
    new ChatGptSemanticAdapter({
      ...(input.backendRecovery ? { backendRecovery: input.backendRecovery } : {}),
      isExactLease,
      resolvePage: identity => input.pageRegistry.pageForObservation(identity.pageKey, identity.bindingEpoch),
      pageMutationMutex: input.pageMutationMutex,
      isAuthorizedAttempt: authorizedAttempt,
      onDispatchObserved: ({ context, attemptId, evidence }) => {
        const clientId = repository.dispatchClientId(context.taskId);
        if (!clientId) throw new Error('Dispatch task owner unavailable');
        repository.recordDispatchEvidence({ taskId: context.taskId, clientId, attemptId, evidence });
      },
      backendClientProvider: input.backendClientProvider ?? (() => {
        if (input.browserOwner === null) throw new Error('Owned browser context unavailable');
        return chatGptBackendJsonClient(input.browserOwner.recoveryRequestContext());
      }),
      backendOrigin: new URL(input.chatgptUrl).origin,
    }),
  ] : []);
  const chat = providers.resolve('chatgpt', 'conversation');
  const ports = chat.kind === 'available' ? [new SemanticExactTaskPort({
    adapter: chat.adapter, resolveContext,
    dispatchJournal: {
      record: (intent, evidence) => repository.recordDispatchEvidence({
        taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId, evidence,
      }),
      read: query => repository.getDispatchEvidence({
        taskId: query.taskId, clientId: query.clientId, attemptId: query.attemptId,
      }),
    },
  })] : [];
  return { providers, repository, kernel: new DurableTaskKernel(repository, ports) };
}
