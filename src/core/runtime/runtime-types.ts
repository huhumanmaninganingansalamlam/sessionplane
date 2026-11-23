
import type { BrowserOwner } from '../../browser/browser-owner.ts';

import type { PageMutationMutex } from '../../browser/page-mutex.ts';
import type { ChatGptBackendRecovery } from '../../providers/chatgpt/backend-recovery.ts';
import type { BackendJsonClient, BackendRateLimitEvidence } from '../../providers/chatgpt/backend-recovery.ts';
import type { PageRegistry } from '../../browser/page-registry.ts';
import type { ActorScheduler } from '../../scheduler/actor-scheduler.ts';

import type { SessionPlaneDatabase } from '../../storage/database.ts';

import type { PageBindingRepository } from '../../storage/page-binding-repository.ts';

import type { TeamDirectory } from '../team-directory.ts';

export type SemanticRuntimeDependencies = {
  readonly database: SessionPlaneDatabase;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly pageBindings?: PageBindingRepository;
  /** Existing Core actor scheduler; never create a second session executor. */
  readonly actorScheduler?: ActorScheduler;
  readonly teamDirectory: TeamDirectory;
  readonly pageMutationMutex: PageMutationMutex;
  readonly enabledProviders: readonly string[];
  readonly chatgptUrl: string;
  readonly backendClientProvider?: () => BackendJsonClient | Promise<BackendJsonClient>;
  readonly backendRecovery?: ChatGptBackendRecovery;
  readonly backendRequestTimeoutMs?: number;
  readonly tokenCacheTtlMs?: number;
  readonly onBackendRateLimit?: (evidence: BackendRateLimitEvidence) => void;
  /** Deterministic backend pacing clock for isolated recovery tests. */
  readonly backendRecoveryNow?: () => Date;
  /** Exact rendered FINAL quiet window; production uses the adapter default. */
  readonly rendererRecoveryQuietWindowMs?: number;
  /** Dedicated deterministic due clock for isolated Core timer tests. */
  readonly continuationNow?: () => Date;
  readonly canRunContinuation?: () => boolean;
};

/** Minimal concrete inputs allowed at the provider composition boundary.
 * Provider registration is explicit, never a generic runtime plugin factory.
 */
export type ProviderRuntimeDependencies = Pick<SemanticRuntimeDependencies,
  'browserOwner' | 'pageRegistry' | 'pageMutationMutex' | 'enabledProviders' |
  'chatgptUrl' | 'backendClientProvider' | 'backendRecovery' |
  'backendRequestTimeoutMs' | 'tokenCacheTtlMs' | 'onBackendRateLimit' |
  'backendRecoveryNow' | 'rendererRecoveryQuietWindowMs'>;

export type ContinuationRuntimeDependencies = Pick<SemanticRuntimeDependencies,
  'actorScheduler' | 'teamDirectory' | 'browserOwner' | 'pageRegistry' |
  'pageBindings' | 'chatgptUrl' | 'continuationNow' | 'canRunContinuation'>;

import type { SemanticProviderRegistry, SemanticProviderResolution } from '../../providers/semantic-provider-registry.ts';
import type { DurableTaskKernel } from '../durable-task-kernel.ts';
import type { KernelStores, AttemptSessionBindingRecord } from '../../storage/kernel/create-kernel-stores.ts';
import type { SemanticDecisionGateway } from '../semantic-decision-gateway.ts';
import type { SemanticTaskArtifactReader } from '../semantic-task-artifact-reader.ts';
import type { ManagedContinuationService } from '../managed-continuation.ts';

export interface ProviderRuntimeServices {
  readonly providers: SemanticProviderRegistry;
  readonly chatGptProvider: SemanticProviderResolution;
}
export interface TaskRuntimeServices {
  readonly durableTaskKernel: DurableTaskKernel;
}
export interface SemanticRuntimeServices {
  readonly providers: SemanticProviderRegistry;
  readonly repository: KernelStores;
  readonly kernel: DurableTaskKernel;
  readonly decisionGateway: SemanticDecisionGateway;
  readonly artifactReader: SemanticTaskArtifactReader;
  readonly managedContinuation: ManagedContinuationService;
  readonly bindAttemptSession: (input: {
    taskId: string; clientId: string; attemptId: string;
    sessionId: string; generation: number; conversationId: string;
  }) => AttemptSessionBindingRecord;
}
