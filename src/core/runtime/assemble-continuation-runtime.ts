import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import type { DurableTaskKernel } from '../durable-task-kernel.ts';
import type { SemanticDecisionGateway } from '../semantic-decision-gateway.ts';
import { ManagedContinuationService } from '../managed-continuation.ts';
import type { ContinuationRuntimeDependencies } from './runtime-types.ts';
import type { createAttemptSessionBinder } from './attempt-context.ts';
import type { createRootAttemptBinder } from './root-page-recovery.ts';
import { createContinuationCommandPorts } from './continuation-command-ports.ts';

/** Compose exactly one Core-owned continuation service with durable command ports. */
export function assembleContinuationRuntime(
  input: ContinuationRuntimeDependencies,
  repository: KernelStores,
  kernel: DurableTaskKernel,
  decisionGateway: SemanticDecisionGateway,
  bindAttemptSession: ReturnType<typeof createAttemptSessionBinder>,
  bindRootAttempt: ReturnType<typeof createRootAttemptBinder>,
) {
  const commands = createContinuationCommandPorts(
    input, repository, decisionGateway, bindAttemptSession, bindRootAttempt);
  const managedContinuation = new ManagedContinuationService({
    repository, kernel,
    ...(input.continuationNow ? { now: input.continuationNow } : {}),
    ...(input.canRunContinuation ? { canRun: input.canRunContinuation } : {}),
    ...commands,
  });
  return { managedContinuation };
}
