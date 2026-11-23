import { assembleSemanticRuntime } from './runtime/assemble-semantic-runtime.ts';
import type { SemanticRuntimeDependencies, SemanticRuntimeServices } from './runtime/runtime-types.ts';
import type { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { KernelStores, AttemptSessionBindingRecord } from '../storage/kernel/create-kernel-stores.ts';
import type { DurableTaskKernel } from './durable-task-kernel.ts';
import type { SemanticDecisionGateway } from './semantic-decision-gateway.ts';
import type { SemanticTaskArtifactReader } from './semantic-task-artifact-reader.ts';
import type { ManagedContinuationService } from './managed-continuation.ts';
export { restoreSemanticPageBindings } from './runtime/restore-exact-pages.ts';

export type SemanticCoreRuntime = SemanticRuntimeServices;

/** One Core-owned composition root; no second browser, DB writer or send loop. */
export function createSemanticCoreRuntime(input: SemanticRuntimeDependencies): SemanticCoreRuntime {
  return assembleSemanticRuntime(input);
}
