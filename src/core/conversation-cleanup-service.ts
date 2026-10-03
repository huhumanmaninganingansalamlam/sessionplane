import { KeyedMutex } from '../scheduler/keyed-mutex.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import type { TeamDirectory } from './team-directory.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { ProviderAdapterRegistry } from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { EventRepository } from '../storage/event-repository.ts';
import { ReceiptRepository, hashCanonical } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import { TeamRepository } from '../storage/team-repository.ts';
import type { StopService } from './stop-service.ts';
import { isProviderUrl } from '../browser/page-binding.ts';

export interface ConversationDeleteInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly conversationId: string;
  readonly outputsRetrieved: true;
}

export interface ReplacementCleanup {
  predecessorSessionId: string | null;
  predecessorGeneration: number | null;
  conversationId: string | null;
  deletionRequestId: string | null;
  deletionReceipt: { clientId: string; requestId: string; status: string } | null;
  outcome: 'confirmed' | 'refused' | 'uncertain' | 'not-attempted' | 'unknown';
  errorCode: string | null;
}

type ReplacementResult = SessionSnapshot & { cleanup: ReplacementCleanup };

export class ConversationCleanupService {
  readonly #replacements = new KeyedMutex();
  readonly #options: {
    database: SessionPlaneDatabase; scheduler: ActorScheduler; adapters: ProviderAdapterRegistry;
    pageMutex: PageMutationMutex; registry: PageRegistry;
    directory: TeamDirectory; onDeleted: (sessionId: string) => void;
  };

  constructor(options: {
    database: SessionPlaneDatabase; scheduler: ActorScheduler; adapters: ProviderAdapterRegistry;
    pageMutex: PageMutationMutex; registry: PageRegistry;
    directory: TeamDirectory; onDeleted: (sessionId: string) => void;
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
          } catch (error) { cleanup.providerError = cleanupErrorCode(error); }
        }
        Object.assign(cleanup, await this.#closeSessionPages(current));
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
          // Historical receipts do not establish cleanup, and must never retry it.
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
        await this.#closeSessionPages(previous);
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
      if (binding.sessionId !== session.sessionId && !isUnboundConversation(binding)) continue;
      try {
        await pageMutex.runExclusive(binding.pageKey, async () => {
          const current = registry.refreshPage(binding.pageKey);
          const page = current.sessionId === session.sessionId
            ? registry.requireSessionPage(binding.pageKey, { sessionId: session.sessionId,
                generation: session.generation, conversationId: session.conversationId })
            : isUnboundConversation(current) ? registry.pageForObservation(binding.pageKey, current.bindingEpoch) : null;
          if (page === null) return;
          await page.close();
          result.closedPages += 1;
        });
      } catch (error) { result.pageErrors.push(cleanupErrorCode(error)); }
    }
    return result;
  }

  async delete(input: ConversationDeleteInput, options: { replacement?: boolean } = {}) {
    const { database, scheduler, adapters, pageMutex, registry } = this.#options;
    const sessions = new SessionRepository(database.raw);
    const receipts = new ReceiptRepository(database);
    const requestHash = hashCanonical({ method: 'session.delete', payload: {
      sessionId: input.sessionId, generation: input.generation,
      conversationId: input.conversationId, outputsRetrieved: input.outputsRetrieved,
      ...(options.replacement ? { replacement: true } : {}),
    } });
    const actor = scheduler.actorFor(input.sessionId);
    return await actor.enqueue(async () =>
      await pageMutex.runExclusive('delete-conversation:' + input.conversationId, async () => {
        const receipt = receipts.get(input.clientId, input.requestId);
        if (receipt !== null) {
          if (receipt.method !== 'session.delete' || receipt.requestHash !== requestHash) {
            throw new SessionPlaneDomainError('input.idempotency-conflict', 'Deletion request payload changed');
          }
          if (receipt.status === 'complete') return JSON.parse(receipt.resultJson) as DeletionResult;
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
          if (prior.status === 'complete') return previous;
        }
        if (!input.outputsRetrieved || (!options.replacement && !session.terminal) ||
            sessions.conversationCleanupBlocker(input.sessionId, input.conversationId, options.replacement === true)) {
          throw new SessionPlaneDomainError('session.cleanup-not-ready', 'Conversation has active, unresolved or shared work; retrieve completed outputs before deletion');
        }
        const adapter = adapters.require(session.provider);
        if (adapter.openDeletion === undefined) {
          throw new SessionPlaneDomainError('capability.unsupported', 'Provider conversation deletion is unavailable');
        }
        const operation = await adapter.openDeletion({ session, generation: input.generation });
        const result: DeletionResult = {
          requestOk: false, sessionId: input.sessionId, generation: input.generation,
          conversationId: input.conversationId, deleted: false, errorCode: 'provider.deletion-unknown',
        };
        const record = (status: 'attempted' | 'complete') => receipts.record({
          clientId: prior?.clientId ?? input.clientId, requestId: prior?.requestId ?? input.requestId,
          method: 'session.delete', requestHash: prior?.requestHash ?? requestHash, status, result,
        });
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
              payload: { conversationId: input.conversationId }, createdAt: timestamp,
            });
            record('complete');
          });
          this.#options.onDeleted(input.sessionId);
          actor.publish(sessions.getSnapshot(input.sessionId)!,
            new EventRepository(database.raw).latestSequenceForSession(input.sessionId));
          await this.#closeSessionPages(session);
          return result;
        } finally {
          // Closing a temporary Page cannot change the durable provider outcome.
          await operation.close().catch(() => {});
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
}

interface TeamDeletionResult {
  requestOk: boolean;
  teamId: string;
  deleted: boolean;
  sessions: Array<{ sessionId: string; providerDeleted: boolean; providerError: string | null;
    stopError: string | null; closedPages: number; pageErrors: string[] }>;
}

function cleanupErrorCode(error: unknown): string {
  return error !== null && typeof error === 'object' && 'errorCode' in error
    ? String(error.errorCode) : 'browser.unavailable';
}
