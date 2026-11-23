import { CoreMaintenance } from './core/maintenance.ts';
import { EventRepository } from './storage/event-repository.ts';
import { SessionRepository } from './storage/session-repository.ts';
import { TeamRepository } from './storage/team-repository.ts';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BrowserOwner } from './browser/browser-owner.ts';
import { PageMutationMutex } from './browser/page-mutex.ts';
import { PageRegistry } from './browser/page-registry.ts';
import { prepareRuntimeDirectories, resolveConfig, type SessionPlaneConfig } from './config.ts';
import { getSystemHealth } from './core/health.ts';
import { TeamDirectory } from './core/team-directory.ts';
import { createLogger, type Logger } from './logging.ts';
import { RpcRouter } from './rpc/router.ts';
import { RpcServer } from './rpc/server.ts';
import { registerBrowserMethods } from './rpc/methods/browser.ts';
import { assembleBrowserRpcPort } from './core/runtime/assemble-browser-rpc.ts';
import { registerTaskMethods } from './rpc/methods/task.ts';
import { PublicTaskAdmissionService } from './core/public-task-admission.ts';
import { ActorScheduler } from './scheduler/actor-scheduler.ts';
import { ProbeCoordinator } from './scheduler/probe-coordinator.ts';
import { SessionPlaneDatabase } from './storage/database.ts';
import { PageBindingRepository } from './storage/page-binding-repository.ts';
import { ReceiptRepository } from './storage/receipt-repository.ts';
import { ProbeBudgetRepository } from './storage/probe-budget-repository.ts';
import { RuntimeMetrics } from './telemetry/metrics.ts';
import { createSemanticCoreRuntime, restoreSemanticPageBindings, type SemanticCoreRuntime } from './core/semantic-core-runtime.ts';
import type { DurableTaskKernel } from './core/durable-task-kernel.ts';
import type { SemanticTaskArtifactReader } from './core/semantic-task-artifact-reader.ts';
import type { SemanticProviderRegistry } from './providers/semantic-provider-registry.ts';
import type { KernelStores } from './storage/kernel/create-kernel-stores.ts';
import { z } from 'zod';

export interface CoreService {
  readonly maintenance: CoreMaintenance;
  readonly config: SessionPlaneConfig;
  readonly database: SessionPlaneDatabase;
  readonly rpcServer: RpcServer;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly pageMutationMutex: PageMutationMutex;
  readonly teamDirectory: TeamDirectory;
  readonly receipts: ReceiptRepository;
  readonly actorScheduler: ActorScheduler;
  readonly probeCoordinator: ProbeCoordinator;
  readonly metrics: RuntimeMetrics;
  readonly pageBindings: PageBindingRepository;
  readonly semanticProviders: SemanticProviderRegistry;
  readonly semanticTaskRepository: KernelStores;
  readonly semanticTaskKernel: DurableTaskKernel;
  readonly semanticTaskArtifactReader: SemanticTaskArtifactReader;
  readonly semanticDecisionGateway: SemanticCoreRuntime['decisionGateway'];
  readonly semanticManagedContinuation: SemanticCoreRuntime['managedContinuation'];
  readonly semanticTaskBindAttemptSession: SemanticCoreRuntime['bindAttemptSession'];
  readonly startedAt: Date;
  restartBrowser(): Promise<Readonly<Record<string, unknown>>>;
  close(): Promise<void>;
}

export interface StartCoreOptions {
  readonly handoverExit?: () => never;
  readonly config?: SessionPlaneConfig;
  readonly logger?: Logger;
  readonly startBrowser?: boolean;
  readonly browserHeadless?: boolean;
}

export async function startCore(options: StartCoreOptions = {}): Promise<CoreService> {
  const config = options.config ?? resolveConfig();
  prepareRuntimeDirectories(config);
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const database = SessionPlaneDatabase.open(config.databasePath);
  const startedAt = new Date();
  const maintenance = new CoreMaintenance();
  const router = new RpcRouter(maintenance);
  const metrics = new RuntimeMetrics();
  const pageRegistry = new PageRegistry({ metrics });
  const pageBindings = new PageBindingRepository(database.raw);
  const unsubscribePageBindings = pageRegistry.subscribe((binding) => {
    maintenance.callback(() => pageBindings.upsert(binding));
  });
  const pageMutationMutex = new PageMutationMutex();
  const actorScheduler = new ActorScheduler(database);
  const sessions = new SessionRepository(database.raw);
  const teamDirectory = new TeamDirectory({
    database,
    sessions,
    teams: new TeamRepository(database.raw),
    events: new EventRepository(database.raw),
  }, {
    enabledProviders: config.enabledProviders,
    onSessionChanged: (sessionId) => actorScheduler.refreshSession(sessionId),
  });
  const receipts = new ReceiptRepository(database);
  const browserOwner = assembleBrowserOwner({
    enabled: options.startBrowser !== false,
    headless: options.browserHeadless ?? config.browserHeadless,
    config, pageRegistry, pageBindings, sessions, teamDirectory,
  });

  try {
    await browserOwner?.start();
    // Create browser session actors only when an active public Task needs them.
    // Archived nonterminal histories remain durable in SQLite, not live idle actors.
  } catch (error) {
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }

  const { providers: semanticProviders, repository: semanticTaskRepository,
    kernel: semanticTaskKernel,
    artifactReader: semanticTaskArtifactReader,
    decisionGateway: semanticDecisionGateway,
    managedContinuation: semanticManagedContinuation,
    bindAttemptSession: semanticTaskBindAttemptSession } = createSemanticCoreRuntime({
    database, browserOwner, pageRegistry, pageBindings, teamDirectory, actorScheduler, pageMutationMutex,
    enabledProviders: config.enabledProviders, chatgptUrl: config.chatgptUrl,
    backendRequestTimeoutMs: config.backendRequestTimeoutMs,
    tokenCacheTtlMs: config.tokenCacheTtlMs,
    onBackendRateLimit: evidence => logger.warn('semantic.backend.rate-limit-observed', {
      status: evidence.status, method: evidence.method,
      endpointCategory: evidence.endpointCategory, receivedAt: evidence.receivedAt,
      retryAfterSource: evidence.retryAfterSource,
      retryAfterDurationMs: evidence.retryAfterDurationMs,
    }),
    canRunContinuation: () => !maintenance.paused,
  });
  // Reconcile only attempts which irreversibly entered dispatch before the
  // previous Core died. A missing ACK is uncertain, never permission to send.
  const interruptedSemantic = semanticTaskRepository.attempts.recoverInterruptedDispatches();
  if (interruptedSemantic > 0) {
    logger.warn('semantic.dispatch.recovered_uncertain', { attempts: interruptedSemantic });
  }
  const probeCoordinator = new ProbeCoordinator({
    database,
    successIntervalMs: config.probeSuccessIntervalMs,
    min429BackoffMs: config.probeMin429BackoffMs,
    max429BackoffMs: config.probeMax429BackoffMs,
    metrics,
  });
  const rebindSemanticPages = async () => restoreSemanticPageBindings({
    repository: semanticTaskRepository, teamDirectory, pageRegistry, pageBindings,
    actorScheduler, chatgptUrl: config.chatgptUrl,
  });
  try {
    if (browserOwner !== null) {
      const report = await rebindSemanticPages();
      if (report.scanned > 0) logger.info('semantic.page-rebind', report);
    }
  } catch (error) {
    await browserOwner?.close();
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }
  registerSystemMethods({
    router, receipts, probeCoordinator, config, database, startedAt, browserOwner,
    pageRegistry, actorScheduler, metrics, maintenance, pageMutationMutex,
    handoverExit: options.handoverExit,
  });
  registerBrowserMethods(router, assembleBrowserRpcPort({
    browserOwner,
    pageRegistry,
    loginUrl: config.chatgptUrl,
    profileDir: config.profileDir,
    recoverBrowser: () => restartBrowser(),
  }));
  registerTaskMethods(router, {
    repository: semanticTaskRepository, gateway: semanticDecisionGateway,
    admission: new PublicTaskAdmissionService({
      database, repository: semanticTaskRepository, teamDirectory,
    }),
  });

  const rpcServer = new RpcServer({
    socketPath: config.socketPath,
    maxLineBytes: config.rpcMaxLineBytes,
    router,
    logger,
  });

  try {
    await rpcServer.listen();
  } catch (error) {
    await browserOwner?.close();
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }

  let closed = false;
  let browserRecovery: Promise<Readonly<Record<string, unknown>>> | null = null;
  const restartBrowser = (): Promise<Readonly<Record<string, unknown>>> => {
    if (browserRecovery !== null) return browserRecovery;
    browserRecovery = (async () => {
      if (browserOwner === null) throw new Error('Browser owner is disabled');
      const browser = await browserOwner.restart();
      const report = await rebindSemanticPages();
      return { browser, recovery: report };
    })().finally(() => {
      browserRecovery = null;
    });
    return browserRecovery;
  };
  const browserRecoveryTimer = browserOwner === null ? null : setInterval(() => {
    if (closed || browserRecovery !== null || maintenance.paused) return;
    const state = browserOwner.status.state;
    // A disconnect is a new recovery event. A failed launch is an error, not
    // another disconnect: retrying it on every tick churns processes/profiles.
    // Keep the original failure visible until explicit browser recovery.
    if (state !== 'disconnected') return;
    const release = maintenance.enter();
    if (!release) return;
    logger.warn('browser.disconnected', { state });
    void restartBrowser()
      .then(({ recovery }) => logger.info('browser.recovered', { recovery }))
      .catch((error: unknown) =>
        logger.error('browser.recovery-failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      ).finally(release);
  }, 5_000);
  browserRecoveryTimer?.unref();
  semanticManagedContinuation.start();
  return {
    maintenance,
    config,
    database,
    rpcServer,
    browserOwner,
    pageRegistry,
    pageMutationMutex,
    teamDirectory,
    receipts,
    actorScheduler,
    probeCoordinator,
    metrics,
    pageBindings,
    semanticProviders,
    semanticTaskRepository,
    semanticTaskKernel,
    semanticTaskArtifactReader,
    semanticDecisionGateway,
    semanticManagedContinuation,
    semanticTaskBindAttemptSession,
    startedAt,
    async restartBrowser(): Promise<Readonly<Record<string, unknown>>> {
      return await restartBrowser();
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await semanticManagedContinuation.close();
      maintenance.resume();
      if (browserRecoveryTimer !== null) clearInterval(browserRecoveryTimer);
      await browserRecovery?.catch(() => undefined);
      await rpcServer.close();
      await browserOwner?.close();
      actorScheduler.close();
      unsubscribePageBindings();
      metrics.close();
      database.close();
    },
  };
}


function assembleBrowserOwner(options: {
  readonly enabled: boolean;
  readonly headless: boolean;
  readonly config: SessionPlaneConfig;
  readonly pageRegistry: PageRegistry;
  readonly pageBindings: PageBindingRepository;
  readonly sessions: SessionRepository;
  readonly teamDirectory: TeamDirectory;
}): BrowserOwner | null {
  if (!options.enabled) return null;
  const { config, pageRegistry, pageBindings, sessions, teamDirectory } = options;
  return new BrowserOwner({
    profileDir: config.profileDir,
    scopeProfileByBrowser: config.browserScopedProfile,
    pageRegistry,
    headless: options.headless,
    persistentMetrics: config.browserMetrics,
    browserPreference: config.browserPreference,
    browserExecutable: config.browserExecutable,
    launchTimeoutMs: config.browserLaunchTimeoutMs,
    resolveTeam: (sessionId, conversationId, targetId) => {
      const session = sessionId ? sessions.getSession(sessionId)
        : conversationId ? sessions.getUniqueConversationSession(conversationId, 'chatgpt') : null;
      const teamId = session?.teamId ??
        (targetId ? pageBindings.uniqueTeamForTarget(targetId) : null);
      if (!teamId) return null;
      const team = teamDirectory.getTeam(teamId);
      return { teamId: team.teamId, title: team.name?.trim() || team.teamId };
    },
  });
}

function registerSystemMethods(options: {
  readonly router: RpcRouter;
  readonly receipts: ReceiptRepository;
  readonly probeCoordinator: ProbeCoordinator;
  readonly config: SessionPlaneConfig;
  readonly database: SessionPlaneDatabase;
  readonly startedAt: Date;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly actorScheduler: ActorScheduler;
  readonly metrics: RuntimeMetrics;
  readonly maintenance: CoreMaintenance;
  readonly pageMutationMutex: PageMutationMutex;
  readonly handoverExit: (() => never) | undefined;
}): void {
  const { router, receipts, probeCoordinator, config, database, startedAt,
    browserOwner, pageRegistry, actorScheduler, metrics, maintenance,
    pageMutationMutex, handoverExit } = options;
  router.register('system.defer_account_cooldown', z.object({
    requestId: z.string().min(1).max(200), observedAt: z.iso.datetime(), until: z.iso.datetime(),
    evidenceRef: z.string().min(1).max(500),
    scope: z.enum(['chatgpt:default', 'chatgpt:conversation-list']).optional(),
  }).strict().refine(input => Date.parse(input.until) >= Date.parse(input.observedAt),
    'Cooldown cannot end before its observed rate-limit signal'), input => receipts.execute({
      clientId: 'operator-account-coordination', requestId: input.requestId,
      method: 'system.defer_account_cooldown', payload: input,
      operation: () => {
        const scope = input.scope ?? 'chatgpt:conversation-list';
        probeCoordinator.defer(scope, input.until);
        const budgets = new ProbeBudgetRepository(database.raw);
        return { deferred: true, scope,
          ui: budgets.get('chatgpt:conversation-load-ui'),
          account: budgets.get('chatgpt:default') };
      },
    }));
  router.register('system.health', z.object({}).strict(), () => ({
    ...getSystemHealth({ config, database, startedAt, browserOwner,
      pageRegistry, actorScheduler, metrics }),
    maintenance: { ...maintenance.status(), durableRecoveryHandover: true },
  }));
  const handoverIdle = () => (browserOwner === null ||
    (browserOwner.status.state === 'ready' && !browserOwner.teamGroupsBusy)) &&
    actorScheduler.totalQueueDepth === 0 && pageMutationMutex.activeCount === 0 &&
    Number(database.raw.prepare("SELECT count(*) AS n FROM outbox WHERE submission_state IN ('submit_attempted','composer_filled')").get()!.n) === 0;
  const ownerSchema = {
    expectedPid: z.literal(process.pid),
    expectedStartedAt: z.literal(startedAt.toISOString()),
  };
  router.register('system.maintenance.quiesce',
    z.object({ ...ownerSchema, token: z.string().uuid().optional() }).strict(),
    input => maintenance.quiesce(input.token, handoverIdle));
  router.register('system.maintenance.prepare', z.object({ ...ownerSchema,
    drainTimeoutMs: z.number().int().min(1).max(10_000).default(5_000),
    leaseMs: z.number().int().min(100).max(60_000).default(30_000),
  }).strict(), input => maintenance.prepare(input.drainTimeoutMs, input.leaseMs, handoverIdle));
  router.register('system.maintenance.resume',
    z.object({ ...ownerSchema, token: z.string().uuid() }).strict(), input => {
      maintenance.resume(input.token);
      return maintenance.status();
    });
  router.register('system.maintenance.commit',
    z.object({ ...ownerSchema, token: z.string().uuid() }).strict(), input =>
      maintenance.commit(input.token, handoverIdle, handoverExit ?? (() => {
        database.close();
        process.exit(0);
      })));
}

export async function serveForever(config: SessionPlaneConfig = resolveConfig()): Promise<void> {
  const logger = createLogger({ level: config.logLevel });
  const service = await startCore({ config, logger });
  logger.info('core.started', {
    pid: process.pid,
    databasePath: config.databasePath,
    socketPath: config.socketPath,
  });

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      logger.info('core.stopping', { signal });
      service.close().then(resolve, reject);
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  const config = resolveConfig({
    stateDir: path.join(homedir(), '.local', 'state', 'sessionplane'),
  });
  serveForever(config).catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
