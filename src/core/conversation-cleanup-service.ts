import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { ProviderAdapterRegistry } from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { EventRepository } from '../storage/event-repository.ts';
import { ReceiptRepository, hashCanonical } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';

export interface ConversationDeleteInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly conversationId: string;
  readonly outputsRetrieved: true;
}

export class ConversationCleanupService {
  readonly #options: {
    database: SessionPlaneDatabase; scheduler: ActorScheduler; adapters: ProviderAdapterRegistry;
    pageMutex: PageMutationMutex; registry: PageRegistry;
  };

  constructor(options: {
    database: SessionPlaneDatabase; scheduler: ActorScheduler; adapters: ProviderAdapterRegistry;
    pageMutex: PageMutationMutex; registry: PageRegistry;
  }) {
    this.#options = options;
  }

  async delete(input: ConversationDeleteInput) {
    const { database, scheduler, adapters, pageMutex, registry } = this.#options;
    const sessions = new SessionRepository(database.raw);
    const receipts = new ReceiptRepository(database);
    const requestHash = hashCanonical({ method: 'session.delete', payload: {
      sessionId: input.sessionId, generation: input.generation,
      conversationId: input.conversationId, outputsRetrieved: input.outputsRetrieved,
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
        if (!input.outputsRetrieved || !session.terminal ||
            sessions.conversationCleanupBlocker(input.sessionId, input.conversationId)) {
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
            sessions.retireDeletedConversation(input.sessionId, timestamp);
            new EventRepository(database.raw).append({
              teamId: session.teamId, roleId: session.roleId, sessionId: session.sessionId,
              generation: session.generation, eventType: 'session.provider-deleted',
              payload: { conversationId: input.conversationId }, createdAt: timestamp,
            });
            record('complete');
          });
          actor.publish(sessions.getSnapshot(input.sessionId)!,
            new EventRepository(database.raw).latestSequenceForSession(input.sessionId));
          if (session.pageKey !== null) {
            try {
              await pageMutex.runExclusive(session.pageKey, async () => {
                const page = registry.requireOwnedPage(session.pageKey!, {
                  sessionId: session.sessionId, generation: session.generation,
                  conversationId: input.conversationId,
                });
                await page.close();
              });
            } catch {
              // Provider acknowledgement and durable deletion are authoritative;
              // a detached or already-closed Page cannot invalidate that result.
            }
          }
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
