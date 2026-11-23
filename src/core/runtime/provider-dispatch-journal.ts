import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import type { ChatGptSemanticAdapterOptions } from '../../providers/chatgpt/semantic/semantic-types.ts';
import type { createRootDispatchPageResolver } from './page-lease.ts';

/** Exact POST records are provenance, not ACK. The caller must still prove
 * the canonical submitted turn before committing a result or another send.
 */
export function createChatGptDispatchJournalPorts(
  repository: Pick<KernelStores, 'tasks' | 'attempts'>,
  exactRootDispatchPage: ReturnType<typeof createRootDispatchPageResolver>,
): Pick<ChatGptSemanticAdapterOptions, 'onDispatchObserved' | 'onRootDispatchObserved'> {
  return {
      onDispatchObserved: ({ context, attemptId, evidence }) => {
        const clientId = repository.tasks.findDispatchClientId(context.taskId);
        if (!clientId) throw new Error('Dispatch task owner unavailable');
        repository.attempts.recordDispatchEvidence({ taskId: context.taskId, clientId, attemptId, evidence });
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
        repository.attempts.recordRootDispatchEvidence({
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
  };
}
