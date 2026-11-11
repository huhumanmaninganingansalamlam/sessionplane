import { createHash } from 'node:crypto';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { OwnedPageIdentity } from '../browser/owned-page-lifecycle.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../providers/chatgpt/backend-recovery.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import { ChatGptSemanticAdapter, chatGptBackendJsonClient } from '../providers/chatgpt/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { SemanticTaskContext } from '../providers/semantic-adapter.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { TaskKernelRepository, type AttemptSessionBindingRecord } from '../storage/task-kernel-repository.ts';
import { DurableTaskKernel, type ExactSendIntent } from './durable-task-kernel.ts';
import { SemanticDecisionGateway } from './semantic-decision-gateway.ts';
import { SemanticExactTaskPort } from './semantic-exact-task-port.ts';
import type { TeamDirectory } from './team-directory.ts';

export interface SemanticCoreRuntime {
  readonly providers: SemanticProviderRegistry;
  readonly repository: TaskKernelRepository;
  readonly kernel: DurableTaskKernel;
  readonly decisionGateway: SemanticDecisionGateway;
  readonly bindAttemptSession: (input: {
    taskId: string; clientId: string; attemptId: string;
    sessionId: string; generation: number; conversationId: string;
  }) => AttemptSessionBindingRecord;
}

/** Decision packets carry exact Task and UI snapshot identity, not a selector. */
function sameDecisionContext(expected: SemanticTaskContext, actual: unknown): boolean {
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
  /** Deterministic backend pacing clock for isolated recovery tests. */
  readonly backendRecoveryNow?: () => Date;
}): SemanticCoreRuntime {
  const repository = new TaskKernelRepository(input.database);
  const bindAttemptSession = (owner: {
    taskId: string; clientId: string; attemptId: string;
    sessionId: string; generation: number; conversationId: string;
  }): AttemptSessionBindingRecord => {
    const task = repository.getTask(owner.taskId, owner.clientId);
    const slot = repository.getSlot(task.projectId, task.slotId, owner.clientId);
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
    return repository.bindAttemptSession(owner);
  };
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
      const full = repository.getFullTask(identity.taskId, clientId);
      const unresolved = full.attempts.filter(attempt =>
        attempt.kind !== 'stop' && attempt.state !== 'failed_before_dispatch' &&
        !full.results.some(result => result.attemptId === attempt.attemptId));
      if (unresolved.length !== 1) return null;
      const sessionBinding = repository.getAttemptSessionBinding({
        taskId: identity.taskId, clientId, attemptId: unresolved[0]!.attemptId,
      });
      if (sessionBinding?.conversationId !== slot.providerConversationId) return null;
      return { clientId, slot, sessionBinding };
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
        binding.sessionId !== task.sessionBinding.sessionId ||
        binding.generation !== task.sessionBinding.generation) return false;
      const session = input.teamDirectory.getSession(binding.sessionId);
      return session.teamId === identity.projectId && session.roleKey === identity.slotId &&
        session.provider === 'chatgpt' && session.pageKey === binding.pageKey &&
        session.conversationId === binding.conversationId &&
        session.generation === task.sessionBinding.generation;
    } catch { return false; }
  };
  const resolveContext = (intent: ExactSendIntent): SemanticTaskContext => {
    const task = repository.getTask(intent.taskId, intent.clientId);
    const slot = repository.getSlot(intent.projectId, intent.slotId, intent.clientId);
    const binding = repository.getBindingAtRevision(intent.projectId, intent.slotId,
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
    const attemptBinding = repository.getAttemptSessionBinding({
      taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId,
    });
    const matches = !activeSlot || intent.providerConversationId === null ||
      attemptBinding === null ? [] :
      input.pageRegistry.findByConversation(intent.providerConversationId)
        .filter(found => found.state === 'owned' && found.targetId !== null &&
          found.sessionId === attemptBinding.sessionId &&
          found.generation === attemptBinding.generation &&
          found.conversationId === attemptBinding.conversationId);
    const candidate: OwnedPageIdentity | null = matches.length === 1 ? {
      projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
      taskId: intent.taskId, pageKey: matches[0]!.pageKey,
      targetId: matches[0]!.targetId!, bindingEpoch: matches[0]!.bindingEpoch,
    } : null;
    const evidence = repository.getDispatchEvidence({
      taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId,
    });
    const full = repository.getFullTask(intent.taskId, intent.clientId);
    const attempt = full.attempts.find(row => row.attemptId === intent.attemptId);
    let submittedUserMessageId = evidence?.messageId ?? null;
    let submittedUserTurnId = attempt?.externalTurnId ?? null;
    if (attempt?.kind === 'continuation' && evidence === null &&
        submittedUserTurnId === null) {
      // Before this continuation has its own POST, bind observation to the
      // nearest earlier ACK with a recorded exact FINAL, never an arbitrary
      // mounted user turn. After POST, current attempt evidence takes over.
      const previous = [...full.attempts].reverse().find(row =>
        row.sequence < attempt.sequence && row.kind !== 'stop' &&
        row.state === 'acknowledged' && row.externalTurnId !== null &&
        full.results.some(result => result.attemptId === row.attemptId &&
          result.externalTurnId === row.externalTurnId));
      if (previous) {
        const precedingEvidence = repository.getDispatchEvidence({
          taskId: intent.taskId, clientId: intent.clientId, attemptId: previous.attemptId,
        });
        if (precedingEvidence?.conversationId === intent.providerConversationId) {
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
      pageLease: activeSlot && candidate !== null && isExactLease(candidate) ? candidate : null,
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
  // A resolved decision, not provider DOM, authorizes model/question effects.
  // Consume it durably before a potentially irreversible click.
  const authorizedDecision = (approval: {
    context: SemanticTaskContext;
    purpose: 'open_model_chooser' | 'choose_model' | 'answer_question' | 'retry';
    decisionId: string; snapshotId: string; actionRef: string;
    evidenceHash: string; input: string | null;
  }): boolean => {
    const { context } = approval;
    if (!context.pageLease || !isExactLease(context.pageLease)) return false;
    const clientId = repository.dispatchClientId(context.taskId);
    if (!clientId) return false;
    try {
      const full = repository.getFullTask(context.taskId, clientId);
      if (full.task.cancelRequested ||
          full.task.state === 'completed' || full.task.state === 'failed' ||
          full.task.state === 'canceled') return false;
      const row = full.decisions.find(entry => entry.decisionId === approval.decisionId);
      if (!row || row.status !== 'resolved' || row.actionConsumed ||
          row.resolutionJson === null) return false;
      const envelope = JSON.parse(row.contextJson);
      const resolution = JSON.parse(row.resolutionJson);
      if (envelope?.kind !== 'semantic_action' ||
          !sameDecisionContext(context, envelope.context) ||
          envelope.purpose !== approval.purpose ||
          envelope.snapshotId !== approval.snapshotId ||
          envelope.actionRef !== approval.actionRef ||
          envelope.evidenceHash !== approval.evidenceHash ||
          resolution?.kind !== 'semantic_action' ||
          resolution.input !== approval.input) return false;
      return repository.consumeDecisionAction(context.taskId, clientId, approval.decisionId);
    } catch { return false; }
  };
  const backendOrigin = new URL(input.chatgptUrl).origin;
  // Profile-local SQLite retains backend GET cooldowns after an owner restart.
  // Auth tokens and conversation payloads always remain ephemeral.
  const backendRecovery = input.backendRecovery ?? new ChatGptBackendRecovery({
    requestTimeoutMs: 15_000, tokenCacheTtlMs: 60_000,
    acknowledgementRetryAtMs: repository.backendReadNotBeforeMs('chatgpt', backendOrigin),
    onConversationRetryAtMs: atMs =>
      repository.extendBackendReadNotBeforeMs('chatgpt', backendOrigin, atMs),
    ...(input.backendRecoveryNow ? { now: input.backendRecoveryNow } : {}),
  });
  const providers = new SemanticProviderRegistry(input.enabledProviders.includes('chatgpt') ? [
    new ChatGptSemanticAdapter({
      backendRecovery,
      isExactLease,
      resolvePage: identity => input.pageRegistry.pageForObservation(identity.pageKey, identity.bindingEpoch),
      pageMutationMutex: input.pageMutationMutex,
      isAuthorizedAttempt: authorizedAttempt,
      isAuthorizedDecision: authorizedDecision,
      onDispatchObserved: ({ context, attemptId, evidence }) => {
        const clientId = repository.dispatchClientId(context.taskId);
        if (!clientId) throw new Error('Dispatch task owner unavailable');
        repository.recordDispatchEvidence({ taskId: context.taskId, clientId, attemptId, evidence });
      },
      backendClientProvider: input.backendClientProvider ?? (() => {
        if (input.browserOwner === null) throw new Error('Owned browser context unavailable');
        return chatGptBackendJsonClient(input.browserOwner.recoveryRequestContext());
      }),
      backendOrigin,
    }),
  ] : []);
  const chat = providers.resolve('chatgpt', 'conversation');
  const decisionGateway = new SemanticDecisionGateway({
    repository, providers, resolveContext,
  });
  const ports = chat.kind === 'available' ? [new SemanticExactTaskPort({
    adapter: chat.adapter, resolveContext,
    onDecisionRequired: async intent => {
      await decisionGateway.inspect({
        taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId,
      });
    },
    dispatchJournal: {
      record: (intent, evidence) => repository.recordDispatchEvidence({
        taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId, evidence,
      }),
      read: query => repository.getDispatchEvidence({
        taskId: query.taskId, clientId: query.clientId, attemptId: query.attemptId,
      }),
    },
  })] : [];
  return { providers, repository, kernel: new DurableTaskKernel(repository, ports),
    decisionGateway, bindAttemptSession };
}
