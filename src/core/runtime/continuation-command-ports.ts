import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import type { SemanticDecisionGateway } from '../semantic-decision-gateway.ts';
import { PublicTaskPreparationService } from '../public-task-preparation.ts';
import type { SemanticRuntimeDependencies } from './runtime-types.ts';
import type { createAttemptSessionBinder } from './attempt-context.ts';
import type { createRootAttemptBinder } from './root-page-recovery.ts';

/** Existing Core-owned continuation commands. All checks use exact Task,
 * slot, generation, owner and immutable source evidence before any dispatch.
 * Assembly builds these ports but never substitutes a browser-owned loop.
 */
export function createContinuationCommandPorts(input: Pick<SemanticRuntimeDependencies,
  'actorScheduler' | 'teamDirectory' | 'browserOwner' | 'pageRegistry' |
  'pageBindings' | 'chatgptUrl'>,
  repository: Pick<KernelStores, 'projects' | 'tasks' | 'attempts' | 'scans'>,
  decisionGateway: Pick<SemanticDecisionGateway,
    'verifyModelIntent' | 'requireNoProgressReview'>,
  bindAttemptSession: ReturnType<typeof createAttemptSessionBinder>,
  bindRootAttempt: ReturnType<typeof createRootAttemptBinder>,
) {
  const publicPreparation = input.actorScheduler
    ? new PublicTaskPreparationService({
      repository, teams: input.teamDirectory, scheduler: input.actorScheduler,
      browserOwner: input.browserOwner, pages: input.pageRegistry,
      ...(input.pageBindings ? { pageBindings: input.pageBindings } : {}),
      chatgptUrl: input.chatgptUrl,
    }) : null;

  return {
    ...(publicPreparation ? { preparePublicTask: async () => {
      const prepared = await publicPreparation.prepareNext();
      if (prepared.kind !== 'prepared' || prepared.taskId === null) return;
      const clientId = repository.tasks.findDispatchClientId(prepared.taskId);
      if (!clientId) return;
      const full = repository.tasks.readTaskAggregate(prepared.taskId, clientId);
      const initial = full.attempts.find(a => a.kind === 'initial' && a.state === 'planned');
      const requested = repository.projects.readPublicModelIntent(full.task.projectId, clientId);
      if (initial && requested) {
        await decisionGateway.verifyModelIntent({
          taskId: full.task.taskId, clientId, attemptId: initial.attemptId,
          modelIntent: requested,
        });
      }
    } } : {}),
    inspectModelIntent: async ({ taskId, clientId, attemptId, modelIntent }: {
      taskId: string; clientId: string; attemptId: string; modelIntent: string;
    }) => await decisionGateway.verifyModelIntent({ taskId, clientId, attemptId, modelIntent }),
    requestAgentReview: async (cause: {
      taskId: string; clientId: string; attemptId: string;
      cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress';
    }) => { await decisionGateway.requireNoProgressReview(cause); },
    ...(input.actorScheduler ? { bindRootAttempt } : {}),
    bindInitialAttempt: ({ taskId, clientId, attemptId }: {
      taskId: string; clientId: string; attemptId: string;
    }) => {
      const task = repository.tasks.getTask(taskId, clientId);
      const slot = repository.projects.getConversationSlot(task.projectId, task.slotId, clientId);
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
    bindAttempt: ({ taskId, clientId, attemptId, sourceAttemptId }: {
      taskId: string; clientId: string; attemptId: string; sourceAttemptId: string;
    }) => {
      const prior = repository.attempts.getAttemptSessionBinding({
        taskId, clientId, attemptId: sourceAttemptId,
      });
      if (!prior) throw new Error('Managed continuation has no exact source session binding');
      bindAttemptSession({
        taskId, clientId, attemptId, sessionId: prior.sessionId,
        generation: prior.generation, conversationId: prior.conversationId,
      });
    },
  };
}
