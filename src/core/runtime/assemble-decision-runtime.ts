import { createExactContextResolver } from "../runtime/attempt-context.ts";

import { SemanticProviderRegistry } from '../../providers/semantic-provider-registry.ts';


import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';


import { SemanticDecisionGateway } from '../semantic-decision-gateway.ts';

import type { ResumeTaskHandler } from "./wire-task-resume.ts";

export function assembleDecisionRuntime(repository: KernelStores, providers: SemanticProviderRegistry, resolveContext: ReturnType<typeof createExactContextResolver>, resumeTask: ResumeTaskHandler) {
const decisionGateway = new SemanticDecisionGateway({
    repository, providers, resolveContext,
    onTaskResumed: input => resumeTask(input),
  });
  return { decisionGateway };
}
