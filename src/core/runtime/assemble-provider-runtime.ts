import { createChatGptDispatchJournalPorts } from './provider-dispatch-journal.ts';

import { createExactLeaseGuard, createRootDispatchPageResolver, createRootTransitionGuard } from "../runtime/page-lease.ts";
import { createAttemptAuthorizationGuard, createDecisionAuthorizationGuard } from "../runtime/authorization.ts";
import { createRootRecoveryPageResolver } from "../runtime/root-page-recovery.ts";

import { ChatGptBackendRecovery } from '../../providers/chatgpt/backend-recovery.ts';


import { ChatGptSemanticAdapter, chatGptBackendJsonClient } from '../../providers/chatgpt/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../../providers/semantic-provider-registry.ts';


import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';

import type { ProviderRuntimeDependencies, ProviderRuntimeServices } from './runtime-types.ts';

export function assembleProviderRuntime(input: ProviderRuntimeDependencies, repository: KernelStores, isExactLease: ReturnType<typeof createExactLeaseGuard>, exactRootDispatchPage: ReturnType<typeof createRootDispatchPageResolver>, isRootDispatchTransition: ReturnType<typeof createRootTransitionGuard>, authorizedAttempt: ReturnType<typeof createAttemptAuthorizationGuard>, authorizedDecision: ReturnType<typeof createDecisionAuthorizationGuard>, resolveRootRecoveryPage: ReturnType<typeof createRootRecoveryPageResolver>): ProviderRuntimeServices {
const backendOrigin = new URL(input.chatgptUrl).origin;

const backendRecovery = input.backendRecovery ?? new ChatGptBackendRecovery({
    requestTimeoutMs: input.backendRequestTimeoutMs ?? 15_000,
    tokenCacheTtlMs: input.tokenCacheTtlMs ?? 60_000,
    acknowledgementRetryAtMs: repository.pacing.readBackendReadFence('chatgpt', backendOrigin),
    onConversationRetryAtMs: atMs =>
      repository.pacing.extendBackendReadFence('chatgpt', backendOrigin, atMs),
    ...(input.onBackendRateLimit ? { onRateLimitEvidence: input.onBackendRateLimit } : {}),
    ...(input.backendRecoveryNow ? { now: input.backendRecoveryNow } : {}),
  });

const providers = new SemanticProviderRegistry(input.enabledProviders.includes('chatgpt') ? [
    new ChatGptSemanticAdapter({
      backendRecovery,
      isExactLease,
      resolvePage: identity => input.pageRegistry.pageForObservation(identity.pageKey, identity.bindingEpoch),
      resolveRootRecoveryPage,
      pageMutationMutex: input.pageMutationMutex,
      ...(input.rendererRecoveryQuietWindowMs !== undefined
        ? { rendererRecoveryQuietWindowMs: input.rendererRecoveryQuietWindowMs } : {}),
      isAuthorizedAttempt: authorizedAttempt,
      isAuthorizedDecision: authorizedDecision,
      ...createChatGptDispatchJournalPorts(repository, exactRootDispatchPage),
      isRootDispatchTransition,
      backendClientProvider: input.backendClientProvider ?? (() => {
        if (input.browserOwner === null) throw new Error('Owned browser context unavailable');
        return chatGptBackendJsonClient(input.browserOwner.recoveryRequestContext());
      }),
      backendOrigin,
    }),
  ] : []);

const chatGptProvider = providers.resolve('chatgpt', 'conversation');
  return { providers, chatGptProvider };
}
