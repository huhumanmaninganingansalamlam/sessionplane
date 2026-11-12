import { createHash } from 'node:crypto';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { OwnedPageIdentity } from '../browser/owned-page-lifecycle.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../providers/chatgpt/backend-recovery.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import { ChatGptSemanticAdapter, chatGptBackendJsonClient } from '../providers/chatgpt/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { SemanticTaskContext } from '../providers/semantic-adapter.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { TaskKernelRepository, type AttemptSessionBindingRecord } from '../storage/task-kernel-repository.ts';
import { DurableTaskKernel, type ExactSendIntent } from './durable-task-kernel.ts';
import { SemanticDecisionGateway } from './semantic-decision-gateway.ts';
import { ManagedContinuationService } from './managed-continuation.ts';
import { PublicTaskPreparationService } from './public-task-preparation.ts';
import { SemanticExactTaskPort } from './semantic-exact-task-port.ts';
import type { TeamDirectory } from './team-directory.ts';

export interface SemanticCoreRuntime {
  readonly providers: SemanticProviderRegistry;
  readonly repository: TaskKernelRepository;
  readonly kernel: DurableTaskKernel;
  readonly decisionGateway: SemanticDecisionGateway;
  readonly managedContinuation: ManagedContinuationService;
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
  /** Existing Core actor scheduler; never create a second session executor. */
  readonly actorScheduler?: ActorScheduler;
  readonly teamDirectory: TeamDirectory;
  readonly pageMutationMutex: PageMutationMutex;
  readonly enabledProviders: readonly string[];
  readonly chatgptUrl: string;
  readonly backendClientProvider?: () => BackendJsonClient | Promise<BackendJsonClient>;
  readonly backendRecovery?: ChatGptBackendRecovery;
  /** Deterministic backend pacing clock for isolated recovery tests. */
  readonly backendRecoveryNow?: () => Date;
  /** Dedicated deterministic due clock for isolated Core timer tests. */
  readonly continuationNow?: () => Date;
  readonly canRunContinuation?: () => boolean;
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
    // A new conversation has no provider ID until its FIRST POST. The
    // reserved root page still has exact Task/session/generation ownership,
    // but is usable solely for pre-send model/login decisions.
    const owner = repository.dispatchClientId(identity.taskId);
    if (owner) {
      try {
        const current = repository.getTask(identity.taskId, owner);
        const slot = repository.getSlot(identity.projectId, identity.slotId, owner);
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
    let candidate: OwnedPageIdentity | null = matches.length === 1 ? {
      projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
      taskId: intent.taskId, pageKey: matches[0]!.pageKey,
      targetId: matches[0]!.targetId!, bindingEpoch: matches[0]!.bindingEpoch,
    } : null;
    const evidence = repository.getDispatchEvidence({
      taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId,
    });
    const full = repository.getFullTask(intent.taskId, intent.clientId);
    const attempt = full.attempts.find(row => row.attemptId === intent.attemptId);
    if (candidate === null && activeSlot && intent.providerConversationId === null &&
        attempt?.kind === 'initial' && attempt.state === 'planned') {
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
      } catch { /* A missing root is preparation, never a send. */ }
    }
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
      ...(repository.publicModelIntent(intent.projectId, intent.clientId)
        ? { requiredModel: repository.publicModelIntent(intent.projectId, intent.clientId) } : {}),
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
  const kernel = new DurableTaskKernel(repository, ports);
  const publicPreparation = input.actorScheduler
    ? new PublicTaskPreparationService({
        repository, teams: input.teamDirectory, scheduler: input.actorScheduler,
        browserOwner: input.browserOwner, pages: input.pageRegistry,
        chatgptUrl: input.chatgptUrl,
      })
    : null;
  const managedContinuation = new ManagedContinuationService({
    repository, kernel,
    ...(input.continuationNow ? { now: input.continuationNow } : {}),
    ...(input.canRunContinuation ? { canRun: input.canRunContinuation } : {}),
    ...(publicPreparation ? { preparePublicTask: async () => {
      const prepared = await publicPreparation.prepareNext();
      if (prepared.kind !== 'prepared' || prepared.taskId === null) return;
      const clientId = repository.dispatchClientId(prepared.taskId);
      if (!clientId) return;
      const full = repository.getFullTask(prepared.taskId, clientId);
      const initial = full.attempts.find(a => a.kind === 'initial' && a.state === 'planned');
      const requested = repository.publicModelIntent(full.task.projectId, clientId);
      if (initial && requested) {
        await decisionGateway.verifyModelIntent({
          taskId: full.task.taskId, clientId, attemptId: initial.attemptId,
          modelIntent: requested,
        });
      }
    } } : {}),
    inspectModelIntent: async ({ taskId, clientId, attemptId, modelIntent }) =>
      await decisionGateway.verifyModelIntent({ taskId, clientId, attemptId, modelIntent }),
    bindInitialAttempt: ({ taskId, clientId, attemptId }) => {
      const task = repository.getTask(taskId, clientId);
      const slot = repository.getSlot(task.projectId, task.slotId, clientId);
      if (slot.activeTaskId !== taskId || slot.providerConversationId === null ||
          slot.revision !== task.slotRevision) {
        throw new Error('Public initial Task has no verified active conversation');
      }
      const session = input.teamDirectory.getCurrentSession(task.projectId, task.slotId);
      if (session.conversationId !== slot.providerConversationId ||
          session.pageKey === null || session.generation < 1) {
        throw new Error('Public initial has no owned current session generation');
      }
      bindAttemptSession({
        taskId, clientId, attemptId, sessionId: session.sessionId,
        generation: session.generation, conversationId: slot.providerConversationId,
      });
    },
    bindAttempt: ({ taskId, clientId, attemptId, sourceAttemptId }) => {
      const prior = repository.getAttemptSessionBinding({
        taskId, clientId, attemptId: sourceAttemptId,
      });
      if (!prior) throw new Error('Managed continuation has no exact source session binding');
      bindAttemptSession({
        taskId, clientId, attemptId, sessionId: prior.sessionId,
        generation: prior.generation, conversationId: prior.conversationId,
      });
    },
  });
  return { providers, repository, kernel, managedContinuation,
    decisionGateway, bindAttemptSession };
}
