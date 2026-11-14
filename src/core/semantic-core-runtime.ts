import { createHash } from 'node:crypto';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { OwnedPageIdentity } from '../browser/owned-page-lifecycle.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import { ChatGptBackendRecovery, type BackendJsonClient,
  type BackendRateLimitEvidence } from '../providers/chatgpt/backend-recovery.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import { ChatGptSemanticAdapter, chatGptBackendJsonClient } from '../providers/chatgpt/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { SemanticTaskContext } from '../providers/semantic-adapter.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { TaskKernelRepository, type AttemptSessionBindingRecord } from '../storage/task-kernel-repository.ts';
import type { PageBindingRepository } from '../storage/page-binding-repository.ts';
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


/**
 * Re-associate only retained native Chrome targets belonging to active public
 * Tasks after Core adoption. Never create/navigate a page, repeat a POST, or
 * restore legacy observation/submission workers. A missing, ambiguous or
 * foreign target remains unbound and awaits an agent decision.
 */
export async function restoreSemanticPageBindings(input: {
  readonly repository: TaskKernelRepository;
  readonly teamDirectory: TeamDirectory;
  readonly pageRegistry: PageRegistry;
  readonly pageBindings: PageBindingRepository;
  readonly actorScheduler: ActorScheduler;
  readonly chatgptUrl: string;
}): Promise<{ scanned: number; rebound: number; held: number }> {
  const owners = input.repository.listCurrentPublicPageOwners();
  const providerOrigin = new URL(input.chatgptUrl).origin;
  let rebound = 0;
  let held = 0;
  for (const owner of owners) {
    try {
      const session = input.teamDirectory.getCurrentSession(owner.projectId, owner.slotId);
      if (session.teamId !== owner.projectId || session.roleKey !== owner.slotId ||
          session.provider !== 'chatgpt' || session.generation < 1 ||
          session.pageKey === null ||
          session.conversationId !== owner.providerConversationId) {
        held++;
        continue;
      }
      const persisted = input.pageBindings.get(session.pageKey);
      if (!persisted || persisted.targetId === null ||
          persisted.sessionId !== session.sessionId ||
          persisted.generation !== session.generation ||
          (session.conversationId !== null &&
            persisted.conversationId !== session.conversationId)) {
        held++;
        continue;
      }
      const candidates = input.pageRegistry.listBindings({ includeClosed: false })
        .filter(binding => binding.targetId === persisted.targetId);
      if (candidates.length !== 1) {
        held++;
        continue;
      }
      const page = input.pageRegistry.refreshPage(candidates[0]!.pageKey);
      if (page.state !== 'unbound' || page.sessionId !== null ||
          page.generation !== null || page.targetId !== persisted.targetId) {
        // Idempotent when this Core already restored the same exact generation.
        if (page.sessionId === session.sessionId &&
            page.generation === session.generation &&
            page.pageKey === session.pageKey &&
            page.conversationId === session.conversationId &&
            (page.state === 'owned' || page.state === 'reserved')) {
          rebound++;
          continue;
        }
        held++;
        continue;
      }
      const url = new URL(page.url);
      if (session.conversationId !== null) {
        if (page.conversationId !== session.conversationId ||
            input.pageRegistry.findByConversation(session.conversationId).length !== 1 ||
            url.origin !== providerOrigin ||
            url.pathname !== `/c/${encodeURIComponent(session.conversationId)}` ||
            url.search !== '' || url.hash !== '') {
          held++;
          continue;
        }
        input.pageRegistry.bindPage(page.pageKey, {
          sessionId: session.sessionId, generation: session.generation,
          conversationId: session.conversationId,
        });
      } else if (page.conversationId === null &&
          (page.url === 'about:blank' ||
            (url.origin === providerOrigin && url.pathname === '/' &&
              url.search === '' && url.hash === ''))) {
        input.pageRegistry.reservePage(page.pageKey, {
          sessionId: session.sessionId, generation: session.generation,
          conversationId: null,
        });
      } else if (page.conversationId !== null &&
          url.origin === providerOrigin &&
          url.pathname === `/c/${encodeURIComponent(page.conversationId)}` &&
          url.search === '' && url.hash === '') {
        // A root POST may have navigated to a conversation before exact ACK.
        // Retain target identity for read-only canonical reconciliation only.
        input.pageRegistry.reserveUnknownConversationCandidate(page.pageKey, {
          sessionId: session.sessionId, generation: session.generation,
          targetId: persisted.targetId,
        });
      } else {
        held++;
        continue;
      }
      await input.actorScheduler.updateGeneration(session.sessionId, session.generation,
        { pageKey: page.pageKey }, 'semantic.restart-exact-target-rebound');
      rebound++;
    } catch {
      // Missing or stale identity must fail closed, never become a new POST.
      held++;
    }
  }
  return { scanned: owners.length, rebound, held };
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
  readonly backendRequestTimeoutMs?: number;
  readonly tokenCacheTtlMs?: number;
  readonly onBackendRateLimit?: (evidence: BackendRateLimitEvidence) => void;
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
        task.slotRevision !== identity.slotRevision || task.cancelRequested ||
        !['working', 'agent_input_required', 'uncertain'].includes(task.state) ||
        slot.activeTaskId !== identity.taskId || slot.revision !== identity.slotRevision ||
        slot.providerKey !== 'chatgpt' || slot.providerConversationId === null) return null;
      const full = repository.getFullTask(identity.taskId, clientId);
      const unresolved = full.attempts.filter(attempt =>
        attempt.kind !== 'stop' && attempt.state !== 'failed_before_dispatch' &&
        !full.results.some(result => result.attemptId === attempt.attemptId));
      const latest = unresolved.at(-1);
      if (!latest || unresolved.length > 2) return null;
      if (unresolved.length === 2) {
        // A timed Continue is valid precisely because the first ACK still has
        // NO FINAL. Both outstanding turns must own the same exact generation;
        // never adopt another Task, session, page or unverified POST.
        const source = unresolved[0]!;
        if (source.state !== 'acknowledged' || source.externalTurnId === null ||
            latest.kind !== 'continuation' || latest.sequence !== source.sequence + 1) return null;
        const earlier = repository.getAttemptSessionBinding({
          taskId: identity.taskId, clientId, attemptId: source.attemptId,
        });
        const following = repository.getAttemptSessionBinding({
          taskId: identity.taskId, clientId, attemptId: latest.attemptId,
        });
        if (!earlier || !following ||
            earlier.sessionId !== following.sessionId ||
            earlier.generation !== following.generation ||
            earlier.conversationId !== following.conversationId) return null;
      }
      const sessionBinding = repository.getAttemptSessionBinding({
        taskId: identity.taskId, clientId, attemptId: latest.attemptId,
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
    const clientId = repository.dispatchClientId(context.taskId);
    if (!clientId) return null;
    try {
      const full = repository.getFullTask(context.taskId, clientId);
      const task = full.task;
      const attempt = full.attempts.find(row => row.attemptId === attemptId);
      const slot = repository.getSlot(context.projectId, context.slotId, clientId);
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
  const isRootDispatchTransition = (owner: {
    context: SemanticTaskContext; attemptId: string; lease: OwnedPageIdentity;
  }): boolean => {
    const exact = exactRootDispatchPage(owner);
    if (!exact?.conversationId) return false;
    try {
      const root = repository.getRootPost({
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
      } catch { /* A missing root is preparation, never a send. */ }
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
        const precedingEvidence = repository.getDispatchEvidence({
          taskId: intent.taskId, clientId: intent.clientId, attemptId: previous.attemptId,
        });
        const precedingBinding = repository.getAttemptSessionBinding({
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
    purpose: 'open_model_chooser' | 'close_model_chooser' |
      'choose_model' | 'choose_reasoning_effort' | 'answer_question' | 'retry';
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
  const rootPageCandidate = (owner: {
    taskId: string; clientId: string; attemptId: string;
  }, expectedConversationId: string | null = null) => {
    const root = repository.getRootPost(owner);
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
  const bindRootAttempt = async (owner: {
    taskId: string; clientId: string; attemptId: string;
  }): Promise<void> => {
    if (!input.actorScheduler) throw new Error('Root ACK actor scheduler unavailable');
    const full = repository.getFullTask(owner.taskId, owner.clientId);
    const attempt = full.attempts.find(row => row.attemptId === owner.attemptId);
    const root = repository.getRootPost(owner);
    if (!attempt || attempt.state !== 'acknowledged' || attempt.externalTurnId === null ||
        !root?.canonicalConversationId) {
      throw new Error('Canonical root ACK is not durable');
    }
    const task = full.task;
    const slot = repository.getSlot(task.projectId, task.slotId, owner.clientId);
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
  const backendOrigin = new URL(input.chatgptUrl).origin;
  // Profile-local SQLite retains backend GET cooldowns after an owner restart.
  // Auth tokens and conversation payloads always remain ephemeral.
  const backendRecovery = input.backendRecovery ?? new ChatGptBackendRecovery({
    requestTimeoutMs: input.backendRequestTimeoutMs ?? 15_000,
    tokenCacheTtlMs: input.tokenCacheTtlMs ?? 60_000,
    acknowledgementRetryAtMs: repository.backendReadNotBeforeMs('chatgpt', backendOrigin),
    onConversationRetryAtMs: atMs =>
      repository.extendBackendReadNotBeforeMs('chatgpt', backendOrigin, atMs),
    ...(input.onBackendRateLimit ? { onRateLimitEvidence: input.onBackendRateLimit } : {}),
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
      onRootDispatchObserved: ({ context, attemptId, evidence }) => {
        const lease = context.pageLease;
        if (lease === null) throw new Error('Root dispatch page lease unavailable');
        const exact = exactRootDispatchPage({ context, attemptId, lease });
        if (!exact || (evidence.requestConversationId !== null &&
            exact.conversationId !== null &&
            evidence.requestConversationId !== exact.conversationId)) {
          throw new Error('Root dispatch left the exact prepared session generation');
        }
        repository.recordRootPost({
          taskId: context.taskId, clientId: exact.clientId, attemptId,
          evidence: {
            sessionId: exact.session.sessionId, generation: exact.session.generation,
            pageKey: exact.binding.pageKey, targetId: lease.targetId,
            bindingEpoch: lease.bindingEpoch,
            messageId: evidence.messageId, parentMessageId: evidence.parentMessageId,
            textHash: evidence.textHash, observedAt: evidence.observedAt,
            requestConversationId: evidence.requestConversationId,
          },
        });
      },
      isRootDispatchTransition,
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
      readRoot: query => {
        const root = repository.getRootPost({
          taskId: query.taskId, clientId: query.clientId, attemptId: query.attemptId,
        });
        return root === null ? null : {
          requestConversationId: root.requestConversationId,
          messageId: root.messageId, parentMessageId: root.parentMessageId,
          textHash: root.textHash, observedAt: root.observedAt,
          observationCount: root.observationCount, ambiguous: root.ambiguous,
        };
      },
      resolveRootCandidate: query => rootPageCandidate({
        taskId: query.taskId, clientId: query.clientId, attemptId: query.attemptId,
      })?.conversationId ?? null,
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
    requestAgentReview: async ({ taskId, clientId, attemptId }) => {
      await decisionGateway.requireNoProgressReview({ taskId, clientId, attemptId });
    },
    ...(input.actorScheduler ? { bindRootAttempt } : {}),
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
