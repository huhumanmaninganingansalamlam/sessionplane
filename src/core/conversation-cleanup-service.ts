import { KeyedMutex } from '../scheduler/keyed-mutex.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import type { TeamDirectory } from './team-directory.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import { ProviderSubmissionError, type ProviderAdapterRegistry } from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { EventRepository } from '../storage/event-repository.ts';
import { ReceiptRepository, hashCanonical } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import { TeamRepository } from '../storage/team-repository.ts';
import { OutboxRepository } from '../storage/outbox-repository.ts';
import type { StopService } from './stop-service.ts';
import { isProviderUrl } from '../browser/page-binding.ts';

export interface ConversationDeleteInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly conversationId: string;
  readonly outputsRetrieved: true;
  readonly discardRetiredObservation?: { conversationId: string; evidenceRef: string } | undefined;
}

export interface ReplacementCleanup {
  predecessorSessionId: string | null;
  predecessorGeneration: number | null;
  conversationId: string | null;
  deletionRequestId: string | null;
  deletionReceipt: { clientId: string; requestId: string; status: string } | null;
  outcome: 'confirmed' | 'refused' | 'uncertain' | 'not-attempted' | 'unknown' | 'preserved';
  errorCode: string | null;
  pageCleanup?: { closedPages: number; pageErrors: string[] };
}

type ReplacementResult = SessionSnapshot & { cleanup: ReplacementCleanup };

export class ConversationCleanupService {
  readonly #replacements = new KeyedMutex();
  readonly #options: {
    database: SessionPlaneDatabase; scheduler: ActorScheduler; adapters: ProviderAdapterRegistry;
    pageMutex: PageMutationMutex; registry: PageRegistry;
    directory: TeamDirectory; onDeleted: (sessionId: string) => void;
    closeCrashedPages?: (session: SessionSnapshot, canClose: () => boolean) => Promise<{ closedPages: number; pageErrors: string[] }>;
    isFailedConversationPage?: (pageKey: string, session: SessionSnapshot) => Promise<boolean>;
  };

  constructor(options: {
    database: SessionPlaneDatabase; scheduler: ActorScheduler; adapters: ProviderAdapterRegistry;
    pageMutex: PageMutationMutex; registry: PageRegistry;
    directory: TeamDirectory; onDeleted: (sessionId: string) => void;
    closeCrashedPages?: (session: SessionSnapshot, canClose: () => boolean) => Promise<{ closedPages: number; pageErrors: string[] }>;
    isFailedConversationPage?: (pageKey: string, session: SessionSnapshot) => Promise<boolean>;
  }) {
    this.#options = options;
  }

  async deleteTeam(input: { clientId: string; requestId: string; teamId: string }, stops: StopService) {
    const { database, directory, scheduler, registry } = this.#options;
    const receipts = new ReceiptRepository(database);
    const teams = new TeamRepository(database.raw);
    const sessions = new SessionRepository(database.raw);
    const requestHash = hashCanonical({ method: 'team.delete', payload: { teamId: input.teamId } });
    return await this.#replacements.runExclusive('team:' + input.teamId, async () => {
      const prior = receipts.get(input.clientId, input.requestId);
      if (prior !== null) {
        if (prior.method !== 'team.delete' || prior.requestHash !== requestHash) {
          throw new SessionPlaneDomainError('input.idempotency-conflict', 'Team deletion request payload changed');
        }
        if (prior.status === 'complete') return JSON.parse(prior.resultJson) as TeamDeletionResult;
      }
      directory.getTeam(input.teamId);
      const result: TeamDeletionResult = { requestOk: true, teamId: input.teamId, deleted: false, sessions: [] };
      database.transaction(() => {
        teams.beginDeletion(input.teamId, new Date().toISOString());
        receipts.record({ ...input, method: 'team.delete', requestHash, status: 'attempted', result });
      });
      // Retired roles block new sends/replacements before awaiting any provider work.
      for (const initial of sessions.listSnapshotsForTeam(input.teamId)) {
        const cleanup = { sessionId: initial.sessionId, providerDeleted: false,
          providerError: null as string | null, stopError: null as string | null,
          providerErrorDetails: null as ReturnType<typeof cleanupProviderErrorDetails>,
          closedPages: 0, pageErrors: [] as string[] };
        const requestId = 'team-delete:' + hashCanonical({ requestId: input.requestId, sessionId: initial.sessionId });
        if (!initial.terminal && initial.generation > 0) {
          try {
            await stops.stop({ clientId: input.clientId, requestId: 'stop:' + requestId,
              sessionId: initial.sessionId, expectedGeneration: initial.generation });
          } catch (error) { cleanup.stopError = cleanupErrorCode(error); }
        }
        // Drain current session mutations, retire observation, and wake waiting clients.
        await scheduler.actorFor(initial.sessionId).enqueue(() => {
          sessions.retireDeletedConversation(initial.sessionId, new Date().toISOString());
          this.#options.onDeleted(initial.sessionId);
          scheduler.refreshSession(initial.sessionId);
        });
        const current = sessions.getSnapshot(initial.sessionId)!;
        if (current.conversationId !== null) {
          try {
            const deleted = await this.delete({ clientId: input.clientId, requestId,
              sessionId: current.sessionId, generation: current.generation,
              conversationId: current.conversationId, outputsRetrieved: true }, { replacement: true });
            cleanup.providerDeleted = deleted.deleted;
            cleanup.providerError = deleted.errorCode;
            cleanup.closedPages += deleted.pageCleanup?.closedPages ?? 0;
            cleanup.pageErrors.push(...(deleted.pageCleanup?.pageErrors ?? []));
          } catch (error) {
            cleanup.providerError = cleanupErrorCode(error);
            cleanup.providerErrorDetails = cleanupProviderErrorDetails(error);
          }
        }
        const remainingPages = await this.#closeSessionPages(current);
        cleanup.closedPages += remainingPages.closedPages;
        cleanup.pageErrors = [...new Set([...cleanup.pageErrors, ...remainingPages.pageErrors])];
        // Remove live ownership even if the provider or browser rejected cleanup.
        for (const binding of registry.listBindings({ includeClosed: true })) {
          if (binding.sessionId === current.sessionId) registry.unbindPage(binding.pageKey);
        }
        result.sessions.push(cleanup);
      }
      database.transaction(() => {
        teams.deleteTeam(input.teamId);
        result.deleted = true;
        receipts.record({ ...input, method: 'team.delete', requestHash, status: 'complete', result });
      });
      return result;
    });
  }

  async replace(input: {
    clientId: string; requestId: string; method: string; payload: unknown;
    teamId: string; roleKey: string; provider: string;
    expectedSessionId?: string | null; expectedGeneration?: number;
    preserveConversation?: true | undefined;
  }): Promise<ReplacementResult> {
    const { database, directory, scheduler } = this.#options;
    const receipts = new ReceiptRepository(database);
    const sessions = new SessionRepository(database.raw);
    const requestHash = hashCanonical({ method: input.method, payload: input.payload });
    return await this.#replacements.runExclusive(input.teamId + ':' + input.roleKey, async () => {
      const receipt = receipts.get(input.clientId, input.requestId);
      if (receipt !== null) {
        if (receipt.method !== input.method || receipt.requestHash !== requestHash) {
          throw new SessionPlaneDomainError('input.idempotency-conflict', 'Replacement request payload changed');
        }
        if (receipt.status === 'complete') {
          const result = JSON.parse(receipt.resultJson) as SessionSnapshot & { cleanup?: ReplacementCleanup };
          // Resume only confirmation of this exact attempted deletion. delete()
          // never sends again when its durable attempted receipt exists.
          const pending = result.cleanup;
          if (pending?.outcome === 'uncertain' && pending.predecessorSessionId !== null &&
              pending.predecessorGeneration !== null && pending.conversationId !== null &&
              pending.deletionRequestId !== null && pending.deletionReceipt?.clientId === input.clientId &&
              pending.deletionReceipt.requestId === pending.deletionRequestId && pending.deletionReceipt.status === 'attempted') {
            const deletionReceipt = receipts.get(input.clientId, pending.deletionRequestId);
            const recorded = deletionReceipt?.method === 'session.delete'
              ? JSON.parse(deletionReceipt.resultJson) as DeletionResult : null;
            if (recorded?.sessionId === pending.predecessorSessionId &&
                recorded.generation === pending.predecessorGeneration && recorded.conversationId === pending.conversationId) {
              try {
                const deletion = await this.delete({ clientId: input.clientId, requestId: pending.deletionRequestId,
                  sessionId: pending.predecessorSessionId, generation: pending.predecessorGeneration,
                  conversationId: pending.conversationId, outputsRetrieved: true }, { replacement: true });
                if (deletion.requestOk && deletion.deleted) {
                  pending.outcome = 'confirmed';
                  pending.errorCode = null;
                  pending.deletionReceipt.status = 'complete';
                  if (deletion.pageCleanup !== undefined) pending.pageCleanup = deletion.pageCleanup;
                }
              } catch (error) { pending.errorCode = cleanupErrorCode(error); }
              receipts.record({ clientId: input.clientId, requestId: input.requestId, method: input.method, requestHash, status: 'complete', result });
            }
          }
          // A recorded destructive replacement also owns local tab cleanup when
          // provider deletion failed. Never infer this for preserved/history-only receipts.
          if (result.cleanup?.deletionRequestId != null && result.cleanup.outcome !== 'preserved' &&
              result.cleanup.outcome !== 'unknown' && result.cleanup.predecessorSessionId !== null) {
            const previous = sessions.getSnapshot(result.cleanup.predecessorSessionId);
            if (previous !== null && previous.generation === result.cleanup.predecessorGeneration &&
                previous.conversationId === result.cleanup.conversationId &&
                (result.cleanup.outcome === 'confirmed' || previous.conversationId === null ||
                  !sessions.conversationCleanupBlocker(previous.sessionId, previous.conversationId))) {
              const pages = await this.#closeSessionPages(previous);
              result.cleanup.pageCleanup = { closedPages: (result.cleanup.pageCleanup?.closedPages ?? 0) + pages.closedPages, pageErrors: pages.pageErrors };
              receipts.record({ clientId: input.clientId, requestId: input.requestId, method: input.method, requestHash, status: 'complete', result });
            }
          }
          return { ...result, cleanup: result.cleanup ?? {
            predecessorSessionId: result.predecessorSessionId, predecessorGeneration: null,
            conversationId: null, deletionRequestId: null, deletionReceipt: null,
            outcome: 'unknown', errorCode: 'provider.deletion-unknown',
          } };
        }
      }
      const role = directory.getTeam(input.teamId).roles.find(role => role.roleKey === input.roleKey);
      if (role === undefined || role.roleState !== 'active') {
        throw new SessionPlaneDomainError('input.invalid', 'Replacement requires an active role');
      }
      const previous = role.currentSessionId === null ? null : directory.getSession(role.currentSessionId);
      if (input.expectedSessionId !== undefined &&
          (role.currentSessionId !== input.expectedSessionId ||
           (input.expectedGeneration !== undefined && previous?.generation !== input.expectedGeneration))) {
        throw new SessionPlaneDomainError(
          input.expectedSessionId === null ? 'input.invalid' : 'session.generation-superseded',
          input.expectedSessionId === null ? 'Use a fresh roleRef for an occupied role' : 'Role reference is stale; refresh the team',
        );
      }
      directory.requireEnabledProvider(input.provider);
      const cleanup: ReplacementCleanup = {
        predecessorSessionId: previous?.sessionId ?? null,
        predecessorGeneration: previous?.generation ?? null,
        conversationId: previous?.conversationId ?? null,
        deletionRequestId: null, deletionReceipt: null, outcome: 'not-attempted', errorCode: null,
      };
      if (input.preserveConversation === true) {
        if (previous === null || input.expectedSessionId !== previous.sessionId ||
            input.expectedGeneration !== previous.generation || input.provider !== previous.provider) {
          throw new SessionPlaneDomainError('input.invalid', 'Preserving replacement requires a fresh roleRef and the same provider');
        }
        return await scheduler.actorFor(previous.sessionId).enqueue(() => {
          // Recheck after queued submission work: the roleRef alone is not proof of no send.
          const current = directory.getCurrentSession(input.teamId, input.roleKey);
          const outbox = new OutboxRepository(database).getByGeneration(previous.sessionId, previous.generation);
          if (current.sessionId !== previous.sessionId || current.generation !== previous.generation) {
            throw new SessionPlaneDomainError('session.generation-superseded', 'Role reference changed before preserving replacement');
          }
          if (current.sessionState !== 'submitting' || current.submissionState !== 'prepared' ||
              current.errorCode !== 'provider.preparation-required' || current.promptSubmitted ||
              current.conversationId === null || current.submittedUserMessageId !== null ||
              current.submittedUserTurnId !== null || current.responseMessageId !== null ||
              outbox?.submissionState !== 'prepared' || outbox.promptSubmitted ||
              outbox.errorCode !== 'provider.preparation-required') {
            throw new SessionPlaneDomainError('session.preservation-not-ready',
              'Preserving replacement requires a bound, prepared, provably unsubmitted request; submitted or uncertain work must remain on its original session');
          }
          if (receipts.findConversationDeletion(current.conversationId) !== null) {
            throw new SessionPlaneDomainError('session.cleanup-pending', 'A deletion attempt already exists for this conversation');
          }
          const successor = receipts.execute({ clientId: input.clientId, requestId: input.requestId,
            method: input.method, payload: input.payload, operation: () => {
              // Existing routing retirement keeps generation/outbox payloads and bindings intact.
              const next = directory.createSession({ teamId: input.teamId, roleKey: input.roleKey, provider: input.provider });
              new EventRepository(database.raw).append({ teamId: current.teamId, roleId: current.roleId,
                sessionId: current.sessionId, generation: current.generation, eventType: 'session.replaced',
                payload: { successorSessionId: next.sessionId, preserveConversation: true }, createdAt: new Date().toISOString() });
              return { ...next, cleanup: { ...cleanup, outcome: 'preserved' as const } };
            } });
          scheduler.refreshSession(previous.sessionId);
          return successor;
        });
      }
      if (previous !== null && previous.conversationId !== null) {
        // Replacement makes one best-effort deletion attempt; cleanup cannot block routing.
        cleanup.deletionRequestId = 'replacement-delete:' + input.requestId;
        let deletion: DeletionResult | null = null;
        try {
          deletion = await this.delete({ clientId: input.clientId,
            requestId: cleanup.deletionRequestId,
            sessionId: previous.sessionId, generation: previous.generation,
            conversationId: previous.conversationId, outputsRetrieved: true }, { replacement: true });
        } catch (error) {
          cleanup.errorCode = cleanupErrorCode(error);
        }
        const deletionReceipt = receipts.get(input.clientId, cleanup.deletionRequestId)
          ?? receipts.findConversationDeletion(previous.conversationId);
        if (deletionReceipt !== null) {
          cleanup.deletionReceipt = { clientId: deletionReceipt.clientId,
            requestId: deletionReceipt.requestId, status: deletionReceipt.status };
          const recorded = JSON.parse(deletionReceipt.resultJson) as DeletionResult;
          if (deletionReceipt.method === 'session.delete' &&
              recorded.sessionId === previous.sessionId && recorded.generation === previous.generation &&
              recorded.conversationId === previous.conversationId) {
            deletion = recorded;
          } else {
            cleanup.outcome = 'uncertain';
            cleanup.errorCode = 'session.conversation-mismatch';
          }
        }
        if (deletion !== null) {
          cleanup.outcome = cleanup.deletionReceipt?.status === 'complete' && deletion.requestOk &&
              deletion.deleted && deletion.errorCode === null ? 'confirmed'
            : cleanup.deletionReceipt?.status === 'complete' && deletion.errorCode === 'provider.deletion-rejected'
              ? 'refused' : 'uncertain';
          if (deletion.pageCleanup !== undefined) cleanup.pageCleanup = deletion.pageCleanup;
          cleanup.errorCode = deletion.errorCode ?? (cleanup.outcome === 'uncertain' ? 'provider.deletion-unknown' : null);
        }
      }
      const create = () => receipts.execute({ clientId: input.clientId, requestId: input.requestId,
        method: input.method, payload: input.payload,
        operation: () => {
          const successor = directory.createSession({ teamId: input.teamId, roleKey: input.roleKey, provider: input.provider });
          if (previous !== null) {
            const timestamp = new Date().toISOString();
            sessions.retireDeletedConversation(previous.sessionId, timestamp);
            new EventRepository(database.raw).append({ teamId: previous.teamId, roleId: previous.roleId,
              sessionId: previous.sessionId, generation: previous.generation,
              eventType: 'session.replaced', payload: { successorSessionId: successor.sessionId }, createdAt: timestamp });
          }
          return { ...successor, cleanup };
        },
      });
      if (previous === null) return create();
      return await scheduler.actorFor(previous.sessionId).enqueue(async () => {
        const successor = create();
        scheduler.refreshSession(previous.sessionId);
        this.#options.onDeleted(previous.sessionId);
        if (cleanup.pageCleanup === undefined && (cleanup.outcome === 'confirmed' || previous.conversationId === null ||
            !sessions.conversationCleanupBlocker(previous.sessionId, previous.conversationId))) {
          const pages = await this.#closeSessionPages(previous);
          cleanup.pageCleanup = pages;
        }
        receipts.record({ clientId: input.clientId, requestId: input.requestId, method: input.method, requestHash, status: 'complete', result: successor });
        return successor;
      });
    });
  }

  async #closeSessionPages(session: SessionSnapshot) {
    const { database, registry, pageMutex } = this.#options;
    const sessions = new SessionRepository(database.raw);
    const result = { closedPages: 0, pageErrors: [] as string[] };
    const isUnboundConversation = (binding: ReturnType<PageRegistry['getBinding']>) =>
      binding.state === 'unbound' && binding.sessionId === null && session.conversationId !== null &&
      binding.conversationId === session.conversationId && isProviderUrl(session.provider, binding.url) &&
      !sessions.conversationCleanupBlocker(session.sessionId, session.conversationId, true);
    for (const binding of registry.listBindings({ includeClosed: false })) {
      try {
        const failedNavigation = binding.state === 'unbound' && binding.url === 'chrome-error://chromewebdata/' &&
          await this.#options.isFailedConversationPage?.(binding.pageKey, session) === true;
        if (binding.sessionId !== session.sessionId && !isUnboundConversation(binding) && !failedNavigation) continue;
        await pageMutex.runExclusive(binding.pageKey, async () => {
          if (session.conversationId !== null && sessions.conversationCleanupBlocker(session.sessionId, session.conversationId, true)) {
            throw new SessionPlaneDomainError('session.cleanup-not-ready', 'Conversation now has shared work; preserve its pages');
          }
          const current = registry.refreshPage(binding.pageKey);
          const page = current.sessionId === session.sessionId
            ? registry.requireSessionPage(binding.pageKey, { sessionId: session.sessionId,
                generation: session.generation, conversationId: session.conversationId })
            : isUnboundConversation(current) || (failedNavigation &&
                await this.#options.isFailedConversationPage?.(binding.pageKey, session) === true)
              ? registry.pageForObservation(binding.pageKey, current.bindingEpoch) : null;
          if (page === null) {
            if (failedNavigation) throw new SessionPlaneDomainError('session.page-identity-unverified', 'Failed navigation target changed during cleanup; preserve it');
            return;
          }
          await requireIdleConversationPage(page);
          const final = registry.refreshPage(binding.pageKey);
          if (final.bindingEpoch !== current.bindingEpoch || final.state !== current.state || final.url !== current.url ||
              (failedNavigation && !await this.#options.isFailedConversationPage?.(binding.pageKey, session))) {
            throw new SessionPlaneDomainError('session.page-identity-unverified', 'Page changed during cleanup inspection; preserve it');
          }
          await page.close();
          result.closedPages += 1;
        });
      } catch (error) { result.pageErrors.push(cleanupErrorCode(error)); }
    }
    if (session.conversationId !== null && this.#options.closeCrashedPages !== undefined) {
      try {
        const pages = await this.#options.closeCrashedPages(session, () =>
          !sessions.conversationCleanupBlocker(session.sessionId, session.conversationId!, true));
        result.closedPages += pages.closedPages;
        result.pageErrors.push(...pages.pageErrors);
      } catch (error) { result.pageErrors.push(cleanupErrorCode(error)); }
    }
    return result;
  }


  async #finishPageCleanup(result: DeletionResult): Promise<DeletionResult> {
    if ((!result.deleted || !result.requestOk) && result.pageCleanup === undefined) return result;
    const session = new SessionRepository(this.#options.database.raw).getSnapshot(result.sessionId);
    if (session === null || session.generation !== result.generation || session.conversationId !== result.conversationId) return result;
    const pages = await this.#closeSessionPages(session);
    return { ...result, pageCleanup: { closedPages: (result.pageCleanup?.closedPages ?? 0) + pages.closedPages, pageErrors: pages.pageErrors } };
  }

  async delete(input: ConversationDeleteInput, options: { replacement?: boolean } = {}) {
    const { database, scheduler, adapters, pageMutex, registry } = this.#options;
    const sessions = new SessionRepository(database.raw);
    const receipts = new ReceiptRepository(database);
    const requestHash = hashCanonical({ method: 'session.delete', payload: {
      sessionId: input.sessionId, generation: input.generation,
      conversationId: input.conversationId, outputsRetrieved: input.outputsRetrieved,
      ...(options.replacement ? { replacement: true } : {}),
      ...(input.discardRetiredObservation ? { discardRetiredObservation: input.discardRetiredObservation } : {}),
    } });
    const actor = scheduler.actorFor(input.sessionId);
    return await actor.enqueue(async () =>
      await pageMutex.runExclusive('delete-conversation:' + input.conversationId, async () => {
        const receipt = receipts.get(input.clientId, input.requestId);
        if (receipt !== null) {
          if (receipt.method !== 'session.delete' || receipt.requestHash !== requestHash) {
            throw new SessionPlaneDomainError('input.idempotency-conflict', 'Deletion request payload changed');
          }
          if (receipt.status === 'complete') {
            const result = await this.#finishPageCleanup(JSON.parse(receipt.resultJson) as DeletionResult);
            receipts.record({ clientId: input.clientId, requestId: input.requestId, method: 'session.delete', requestHash, status: 'complete', result });
            return result;
          }
        }
        const session = sessions.getSnapshot(input.sessionId);
        if (session === null || session.generation !== input.generation ||
            session.conversationId !== input.conversationId) {
          throw new SessionPlaneDomainError('session.conversation-mismatch', 'Deletion requires the exact durable conversation and generation');
        }
        const prior = receipt ?? receipts.findConversationDeletion(input.conversationId);
        if (prior !== null) {
          const previous = JSON.parse(prior.resultJson) as DeletionResult;
          if (previous.sessionId !== input.sessionId || previous.generation !== input.generation) {
            throw new SessionPlaneDomainError('session.conversation-mismatch', 'Deletion receipt belongs to another exact generation');
          }
          if (prior.status === 'complete') return await this.#finishPageCleanup(previous);
        }
        const disposal = input.discardRetiredObservation;
        if (disposal && (disposal.conversationId !== session.conversationId ||
            !disposal.evidenceRef.trim() || !sessions.canDiscardRetiredObservation(session.sessionId, session.generation))) {
          throw new SessionPlaneDomainError('session.cleanup-not-ready',
            'Explicit disposal requires the exact conversation, evidence and a retired observation on a displaced or retired role');
        }
        if (!input.outputsRetrieved || (!options.replacement && !session.terminal) ||
            sessions.conversationCleanupBlocker(input.sessionId, input.conversationId, options.replacement === true,
              disposal ? session.generation : null)) {
          throw new SessionPlaneDomainError('session.cleanup-not-ready', 'Conversation has active, unresolved or shared work; retrieve completed outputs before deletion');
        }
        for (const binding of registry.listBindings({ includeClosed: false })) {
          if (binding.sessionId === session.sessionId || (binding.sessionId === null && binding.conversationId === session.conversationId && isProviderUrl(session.provider, binding.url)) ||
              (binding.state === 'unbound' && binding.url === 'chrome-error://chromewebdata/' &&
                await this.#options.isFailedConversationPage?.(binding.pageKey, session))) {
            await pageMutex.runExclusive(binding.pageKey, async () => {
              await requireIdleConversationPage(registry.pageForObservation(binding.pageKey, binding.bindingEpoch));
            });
          }
        }
        const adapter = adapters.require(session.provider);
        if (adapter.openDeletion === undefined) {
          throw new SessionPlaneDomainError('capability.unsupported', 'Provider conversation deletion is unavailable');
        }
        let operation;
        try {
          operation = await adapter.openDeletion({ session, generation: input.generation });
        } catch (error) {
          // Preparation has not attempted a delete; retain the typed provider
          // failure and pacing separately from cleanup of the verified idle page.
          if (error instanceof ProviderSubmissionError) {
            if (options.replacement) throw new SessionPlaneDomainError(error.errorCode, error.message, error.details);
            const pageCleanup = await this.#closeSessionPages(session);
            throw new SessionPlaneDomainError(error.errorCode, error.message, {
              ...(error.details !== null && typeof error.details === 'object' ? error.details : { providerDetails: error.details }),
              sessionId: session.sessionId, generation: session.generation,
              conversationId: session.conversationId, deleted: false, deletionAttempted: prior?.status === 'attempted', pageCleanup,
            });
          }
          throw error;
        }
        const result: DeletionResult = prior !== null ? JSON.parse(prior.resultJson) as DeletionResult : {
          requestOk: false, sessionId: input.sessionId, generation: input.generation,
          conversationId: input.conversationId, deleted: false, errorCode: 'provider.deletion-unknown',
        };
        let recordedStatus: 'attempted' | 'complete' | null = prior?.status === 'attempted' ? 'attempted' : null;
        const record = (status: 'attempted' | 'complete') => {
          recordedStatus = status;
          receipts.record({ clientId: prior?.clientId ?? input.clientId, requestId: prior?.requestId ?? input.requestId,
            method: 'session.delete', requestHash: prior?.requestHash ?? requestHash, status, result });
        };
        try {
          let deleted = operation.alreadyDeleted;
          if (!deleted && prior !== null) return result;
          if (!deleted) {
            record('attempted');
            try { deleted = await operation.deleteOnce(); }
            catch { return result; }
          }
          if (!deleted) {
            result.errorCode = 'provider.deletion-rejected';
            record('complete');
            return result;
          }
          result.requestOk = true;
          result.deleted = true;
          result.errorCode = null;
          database.transaction(() => {
            const timestamp = new Date().toISOString();
            sessions.retireDeletedConversation(input.sessionId, timestamp, options.replacement === true);
            new EventRepository(database.raw).append({
              teamId: session.teamId, roleId: session.roleId, sessionId: session.sessionId,
              generation: session.generation, eventType: 'session.provider-deleted',
              payload: { conversationId: input.conversationId,
                ...(disposal ? { discardedRetiredObservation: disposal, originalGenerationPreserved: true } : {}) }, createdAt: timestamp,
            });
            record('complete');
          });
          this.#options.onDeleted(input.sessionId);
          actor.publish(sessions.getSnapshot(input.sessionId)!,
            new EventRepository(database.raw).latestSequenceForSession(input.sessionId));
          return result;
        } finally {
          // Closing a temporary Page cannot change the durable provider outcome.
          await operation.close().catch(() => {});
          // Replacement/team cleanup owns its separate unresolved-work policy.
          if (!options.replacement || (result.requestOk && result.deleted)) {
            const pages = await this.#closeSessionPages(session);
            result.pageCleanup = { closedPages: (result.pageCleanup?.closedPages ?? 0) + pages.closedPages, pageErrors: pages.pageErrors };
            if (recordedStatus !== null) record(recordedStatus);
          }
        }
      }));
  }
}

interface DeletionResult {
  requestOk: boolean;
  sessionId: string;
  generation: number;
  conversationId: string;
  deleted: boolean;
  errorCode: string | null;
  pageCleanup?: { closedPages: number; pageErrors: string[] };
}

interface TeamDeletionResult {
  requestOk: boolean;
  teamId: string;
  deleted: boolean;
  sessions: Array<{ sessionId: string; providerDeleted: boolean; providerError: string | null;
    providerErrorDetails: ReturnType<typeof cleanupProviderErrorDetails>;
    stopError: string | null; closedPages: number; pageErrors: string[] }>;
}

function cleanupProviderErrorDetails(error: unknown) {
  if (!(error instanceof SessionPlaneDomainError) || error.details === null || typeof error.details !== 'object') return null;
  const { stage, httpStatus, retryAfterMs } = error.details as Record<string, unknown>;
  // Keep only transport diagnostics, never provider bodies or authentication data.
  if ((stage !== 'authentication' && stage !== 'conversation-verification') ||
      typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) return null;
  return { stage, httpStatus, retryAfterMs: typeof retryAfterMs === 'number' &&
    Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : null };
}

function cleanupErrorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'errorCode' in error
    ? String(error.errorCode) : 'browser.unavailable';
}

export async function requireIdleConversationPage(page: import('playwright-core').Page, preservedDraft?: '계속') {
    const unsafe = await page.locator('textarea, [contenteditable="true"]:not(article *, [data-message-author-role] *, [data-chatgpt-search-message-ids] *), input[type="file"], button, [data-testid*="file-pill"], [data-testid*="attachment"]').evaluateAll((elements, allowedDraft) =>
      elements.some(element => {
        if (element instanceof HTMLInputElement && element.type === 'file') return (element.files?.length ?? 0) > 0;
        const testId = element.getAttribute('data-testid') ?? '';
        if (/file-pill|attachment/.test(testId)) {
          const form = element.closest('form');
          return form?.querySelector('textarea, [contenteditable="true"]') != null &&
            element.closest('article, [data-message-author-role], [data-chatgpt-search-message-ids], button, [role="button"]') === null &&
            (element.textContent ?? '').trim().length > 0 &&
            element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        }
        if (element instanceof HTMLButtonElement) return element.getClientRects().length > 0 && (
          /^(?:stop|stop generating|stop streaming|stop response|응답 중지|생성 중지|중지)$/i.test(element.getAttribute('aria-label') ?? '') ||
          element.getAttribute('data-testid') === 'stop-button');
        const text = element instanceof HTMLTextAreaElement ? element.value : (element as HTMLElement).innerText ?? '';
        return text.trim().length > 0 && text !== allowedDraft;
      }), preservedDraft);
    if (unsafe) throw new SessionPlaneDomainError('session.cleanup-not-ready', 'Preserve the page draft or active generation before cleanup');
  }

