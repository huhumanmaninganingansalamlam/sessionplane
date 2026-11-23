import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import type { ExactSendIntent } from '../durable-task-kernel.ts';
import type { SemanticDispatchJournal } from '../semantic-exact-task-port.ts';
import type { SemanticDecisionGateway } from '../semantic-decision-gateway.ts';
import type { createRootPageCandidateReader } from './root-page-recovery.ts';

/** Exact POST provenance; a journal read is never a substitute for canonical ACK. */
export function createSemanticTaskJournal(
  repository: Pick<KernelStores, 'attempts'>,
  rootPageCandidate: ReturnType<typeof createRootPageCandidateReader>,
): SemanticDispatchJournal {
  return {
    record: (intent, evidence) => repository.attempts.recordDispatchEvidence({
      taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId, evidence,
    }),
    read: query => repository.attempts.getDispatchEvidence({
      taskId: query.taskId, clientId: query.clientId, attemptId: query.attemptId,
    }),
    readRoot: query => {
      const root = repository.attempts.getRootDispatchEvidence({
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
  };
}

/** An unready external mutation becomes an exact, durable Decision, never a
 * guessed browser selector or a client-owned retry.
 */
export function createTaskDecisionReview(
  decisionGateway: Pick<SemanticDecisionGateway, 'inspect'>,
): (intent: ExactSendIntent) => Promise<void> {
  return async intent => {
    await decisionGateway.inspect({
      taskId: intent.taskId, clientId: intent.clientId, attemptId: intent.attemptId,
    });
  };
}
