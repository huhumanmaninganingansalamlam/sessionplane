import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import type { SemanticProviderResolution } from '../../providers/semantic-provider-registry.ts';
import { DurableTaskKernel } from '../durable-task-kernel.ts';
import { SemanticExactTaskPort } from '../semantic-exact-task-port.ts';
import type { SemanticDecisionGateway } from '../semantic-decision-gateway.ts';
import type { createExactContextResolver } from './attempt-context.ts';
import type { createRootPageCandidateReader } from './root-page-recovery.ts';
import type { TaskRuntimeServices } from './runtime-types.ts';
import { createSemanticTaskJournal, createTaskDecisionReview } from './task-journal-ports.ts';

/** One provider-neutral durable kernel, with optional explicit semantic port. */
export function assembleTaskRuntime(
  repository: KernelStores,
  provider: SemanticProviderResolution,
  resolveContext: ReturnType<typeof createExactContextResolver>,
  rootPageCandidate: ReturnType<typeof createRootPageCandidateReader>,
  decisionGateway: SemanticDecisionGateway,
): TaskRuntimeServices {
  const exactTaskPorts = provider.kind === 'available' ? [new SemanticExactTaskPort({
    adapter: provider.adapter, resolveContext,
    onDecisionRequired: createTaskDecisionReview(decisionGateway),
    dispatchJournal: createSemanticTaskJournal(repository, rootPageCandidate),
  })] : [];
  const durableTaskKernel = new DurableTaskKernel(repository, exactTaskPorts);
  return { durableTaskKernel };
}
