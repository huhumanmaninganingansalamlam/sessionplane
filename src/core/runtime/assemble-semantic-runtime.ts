import { TaskResumeBinding, createTaskResumeHandler } from './wire-task-resume.ts';
import { assembleProviderRuntime } from './assemble-provider-runtime.ts';
import { assembleDecisionRuntime } from './assemble-decision-runtime.ts';
import { assembleTaskRuntime } from './assemble-task-runtime.ts';
import { assembleContinuationRuntime } from './assemble-continuation-runtime.ts';
import { createAttemptSessionBinder, createExactContextResolver } from './attempt-context.ts';
import { createActiveTaskReader, createExactLeaseGuard, createRootDispatchPageResolver, createRootTransitionGuard } from './page-lease.ts';
import { createAttemptAuthorizationGuard, createDecisionAuthorizationGuard } from './authorization.ts';
import { createRootPageCandidateReader, createRootRecoveryPageResolver, createRootAttemptBinder } from './root-page-recovery.ts';
import { createKernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import { SemanticTaskArtifactReader } from '../semantic-task-artifact-reader.ts';

import type { SemanticRuntimeDependencies, SemanticRuntimeServices } from './runtime-types.ts';

export function assembleSemanticRuntime(input: SemanticRuntimeDependencies): SemanticRuntimeServices {
  const repository = createKernelStores(input.database);
  const bindAttemptSession = createAttemptSessionBinder(input, repository);
  const activeTask = createActiveTaskReader(input, repository);
  const isExactLease = createExactLeaseGuard(input, repository, activeTask);
  const exactRootDispatchPage = createRootDispatchPageResolver(input, repository);
  const isRootDispatchTransition = createRootTransitionGuard(input, repository, exactRootDispatchPage);
  const resolveContext = createExactContextResolver(input, repository, isExactLease);
  const authorizedAttempt = createAttemptAuthorizationGuard(input, repository);
  // A resolved decision, not provider DOM, authorizes model/question effects.
  // Consume it durably before a potentially irreversible click.
  const authorizedDecision = createDecisionAuthorizationGuard(input, repository, isExactLease);
  const rootPageCandidate = createRootPageCandidateReader(input, repository);
  const resolveRootRecoveryPage = createRootRecoveryPageResolver(input, repository, rootPageCandidate);

  const bindRootAttempt = createRootAttemptBinder(input, repository, rootPageCandidate);
  const { providers, chatGptProvider } = assembleProviderRuntime(input, repository, isExactLease, exactRootDispatchPage, isRootDispatchTransition, authorizedAttempt, authorizedDecision, resolveRootRecoveryPage);
  // Profile-local SQLite retains backend GET cooldowns after an owner restart.
  // Auth tokens and conversation payloads always remain ephemeral.

  const resumeBinding = new TaskResumeBinding();
  const { decisionGateway } = assembleDecisionRuntime(repository, providers, resolveContext, (input) => resumeBinding.run(input));
  const { durableTaskKernel } = assembleTaskRuntime(repository, chatGptProvider, resolveContext, rootPageCandidate, decisionGateway);

  const { managedContinuation } = assembleContinuationRuntime(input, repository, durableTaskKernel, decisionGateway, bindAttemptSession, bindRootAttempt);

  resumeBinding.bind(createTaskResumeHandler({ repository, kernel: durableTaskKernel, managedContinuation }));
  const artifactReader = new SemanticTaskArtifactReader({ repository, providers });
  return { providers, repository, kernel: durableTaskKernel, managedContinuation,
    decisionGateway, artifactReader, bindAttemptSession };
}
