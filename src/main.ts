import { CoreMaintenance } from './core/maintenance.ts';
import { ThinkingFailureRecovery } from './core/thinking-failure-recovery.ts';
import { ConversationLoadRecovery } from './core/conversation-load-recovery.ts';
import { TeamWorkflow } from './core/team-workflow.ts';
import { registerWorkflowMethods } from './rpc/methods/workflow.ts';
import { SessionRepository } from './storage/session-repository.ts';
import { EventRepository } from './storage/event-repository.ts';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';

import { BrowserOwner } from './browser/browser-owner.ts';
import { PageMutationMutex } from './browser/page-mutex.ts';
import { PageRegistry } from './browser/page-registry.ts';
import { prepareRuntimeDirectories, resolveConfig, type SessionPlaneConfig } from './config.ts';
import { getSystemHealth } from './core/health.ts';
import { BrowserControlService } from './core/browser-control-service.ts';
import { ArtifactService } from './core/artifact-service.ts';
import { ObservationService } from './core/observation-service.ts';
import { RecoveryService } from './core/recovery-service.ts';
import { StopService } from './core/stop-service.ts';
import { TeamDirectory } from './core/team-directory.ts';
import { SubmissionService } from './core/submission-service.ts';
import { ConversationCleanupService } from './core/conversation-cleanup-service.ts';
import { SessionUiService } from './core/session-ui-service.ts';
import { createLogger, type Logger } from './logging.ts';
import { RpcRouter } from './rpc/router.ts';
import { RpcServer } from './rpc/server.ts';
import { registerBrowserMethods } from './rpc/methods/browser.ts';
import { registerBrowserControlMethods } from './rpc/methods/browser-control.ts';
import { registerArtifactMethods } from './rpc/methods/artifact.ts';
import { registerSessionMethods } from './rpc/methods/session.ts';
import { registerSessionUiMethods } from './rpc/methods/session-ui.ts';
import { registerSendMethods } from './rpc/methods/send.ts';
import { registerStopMethods } from './rpc/methods/stop.ts';
import { registerTeamMethods } from './rpc/methods/team.ts';
import { registerWaitMethods } from './rpc/methods/wait.ts';
import { ActorScheduler } from './scheduler/actor-scheduler.ts';
import { ProbeCoordinator } from './scheduler/probe-coordinator.ts';
import { SessionPlaneDatabase } from './storage/database.ts';
import { PageBindingRepository } from './storage/page-binding-repository.ts';
import { ReceiptRepository } from './storage/receipt-repository.ts';
import { RuntimeMetrics } from './telemetry/metrics.ts';
import { ChatGptAdapter } from './providers/chatgpt/adapter.ts';
import { GeminiAdapter } from './providers/gemini/adapter.ts';
import { GrokAdapter } from './providers/grok/adapter.ts';
import {
  ProviderAdapterRegistry,
  type ProviderAdapter,
  type ProviderName,
} from './providers/provider-adapter.ts';
import { z } from 'zod';

export interface CoreService {
  readonly maintenance: CoreMaintenance;
  readonly config: SessionPlaneConfig;
  readonly database: SessionPlaneDatabase;
  readonly rpcServer: RpcServer;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly browserControl: BrowserControlService;
  readonly artifactService: ArtifactService;
  readonly pageMutationMutex: PageMutationMutex;
  readonly teamDirectory: TeamDirectory;
  readonly receipts: ReceiptRepository;
  readonly actorScheduler: ActorScheduler;
  readonly probeCoordinator: ProbeCoordinator;
  readonly metrics: RuntimeMetrics;
  readonly pageBindings: PageBindingRepository;
  readonly providerAdapters: ProviderAdapterRegistry;
  readonly observationService: ObservationService;
  readonly thinkingFailureRecovery: ThinkingFailureRecovery;
  readonly conversationLoadRecovery: ConversationLoadRecovery;
  readonly recoveryService: RecoveryService;
  readonly submissionService: SubmissionService;
  readonly stopService: StopService;
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
  readonly providerAdapters?: readonly ProviderAdapter[];
  readonly recoveryNavigatePage?: (page: Page, url: string) => Promise<void>;
  readonly enableInternalBrowserControlRpc?: boolean;
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
  const teamDirectory = new TeamDirectory(database, {
    enabledProviders: config.enabledProviders,
    onSessionChanged: (sessionId) => actorScheduler.refreshSession(sessionId),
  });
  const receipts = new ReceiptRepository(database);
  const browserOwner =
    options.startBrowser === false
      ? null
      : new BrowserOwner({
          profileDir: config.profileDir,
          scopeProfileByBrowser: config.browserScopedProfile,
          pageRegistry,
          headless: options.browserHeadless ?? config.browserHeadless,
          browserPreference: config.browserPreference,
          browserExecutable: config.browserExecutable,
          launchTimeoutMs: config.browserLaunchTimeoutMs,
        });

  try {
    await browserOwner?.start();
    const restoredRetiredSessions = new SessionRepository(database.raw).restorePendingRetiredSessions(config.enabledProviders);
    if (restoredRetiredSessions > 0) logger.info('recovery.pending-retired-sessions', { count: restoredRetiredSessions });
    actorScheduler.restore();
  } catch (error) {
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }

  const configuredAdapters =
    options.providerAdapters ??
    (browserOwner === null
      ? []
      : [
          new ChatGptAdapter({
            onBackendRateLimit: ({ session, generation }, evidence) => {
              maintenance.callback(() => new EventRepository(database.raw).append({ teamId: session.teamId, roleId: session.roleId,
                sessionId: session.sessionId, generation, eventType: 'provider.backend-rate-limit-observed',
                createdAt: evidence.receivedAt, payload: { ...evidence,
                  policyScope: `chatgpt:conversation-detail:${session.conversationId}`,
                  serverScope: evidence.headers['ratelimit-scope'] ?? evidence.headers['x-ratelimit-scope'] ?? 'unverified' } }));
            },
            pageMutex: pageMutationMutex,
            canRestoreLatestPosition: ({ session, generation }) => {
              const current = teamDirectory.getSession(session.sessionId);
              const completedAnswer = session.terminal && current.sessionState === 'complete' &&
                current.errorCode === null && session.responseMessageId !== null &&
                current.responseMessageId === session.responseMessageId;
              return current.generation === generation && (!current.terminal || completedAnswer) && current.promptSubmitted &&
                current.pageKey === session.pageKey && current.conversationId === session.conversationId &&
                current.submittedUserMessageId === session.submittedUserMessageId &&
                current.submittedUserTurnId === session.submittedUserTurnId &&
                !receipts.hasFocusedGeneration(session.sessionId, generation);
            },
            browserOwner,
            pageRegistry,
            loginUrl: config.chatgptUrl,
            acknowledgementTimeoutMs: config.submissionAckTimeoutMs,
            backendRequestTimeoutMs: config.backendRequestTimeoutMs,
            tokenCacheTtlMs: config.tokenCacheTtlMs,
          }),
          new GeminiAdapter({
            browserOwner,
            pageRegistry,
            loginUrl: config.geminiUrl,
            acknowledgementTimeoutMs: config.submissionAckTimeoutMs,
          }),
          new GrokAdapter({
            browserOwner,
            pageRegistry,
            loginUrl: config.grokUrl,
            acknowledgementTimeoutMs: config.submissionAckTimeoutMs,
          }),
        ]);
  const providerAdapters = new ProviderAdapterRegistry(
    configuredAdapters.filter((adapter) =>
      config.enabledProviders.includes(adapter.provider as ProviderName),
    ),
  );
  const probeCoordinator = new ProbeCoordinator({
    database,
    successIntervalMs: config.probeSuccessIntervalMs,
    min429BackoffMs: config.probeMin429BackoffMs,
    max429BackoffMs: config.probeMax429BackoffMs,
    metrics,
  });
  let thinkingFailureRecovery: ThinkingFailureRecovery | null = null;
  const observationService = new ObservationService({
    maintenance,
    onActionableAlert: async (snapshot, signal) => { await thinkingFailureRecovery?.observe(snapshot, signal); },
    database,
    scheduler: actorScheduler,
    adapters: providerAdapters,
    activeSweepMs: config.observationActiveSweepMs,
    quietSweepMs: config.observationQuietSweepMs,
    quietWindowMs: config.observationQuietWindowMs,
    backendRecoveryAfterMs: config.backendRecoveryAfterMs,
    observationTimeoutMs: config.backendRequestTimeoutMs,
    probeCoordinator,
    logger,
    metrics,
  });
  let recoveryService: RecoveryService | null = null;
  const submissionService = new SubmissionService({
    database,
    directory: teamDirectory,
    scheduler: actorScheduler,
    pageMutex: pageMutationMutex,
    adapters: providerAdapters,
    maxUploadFileBytes: config.maxUploadFileBytes,
    uploadsEnabled: config.uploadsEnabled,
    beforeFailureContinuation: async (snapshot, continuation) => {
      if (!thinkingFailureRecovery) throw new Error('Thinking-failure validation is unavailable');
      await thinkingFailureRecovery.validateContinuation(snapshot, continuation);
    },
    beforeAuthorizedResend: async (current, original, prompt, beforeDispatch) => {
      await ui.verifyAuthorizedResend(current, original, prompt, beforeDispatch);
      // Explicit duplicate-risk approval preserves the unresolved original.
      // Recovery GET pacing remains with its observer; it does not gate this UI dispatch.
    },
    reserveResendPage: (original, successor) => ui.reserveResendPage(original, successor),
    onSubmitted: (snapshot) => observationService.start(snapshot),
    onSubmissionUnknown: (snapshot) =>
      recoveryService?.watchAcknowledgementRecovery(snapshot),
  });
  const stopService = new StopService({
    database,
    directory: teamDirectory,
    scheduler: actorScheduler,
    pageMutex: pageMutationMutex,
    adapters: providerAdapters,
  });
  const recovery = new RecoveryService({
    maintenance,
    database,
    browserOwner,
    pageRegistry,
    scheduler: actorScheduler,
    observations: observationService,
    adapters: providerAdapters,
    submissions: submissionService,
    chatgptUrl: config.chatgptUrl,
    geminiUrl: config.geminiUrl,
    grokUrl: config.grokUrl,
    metrics,
    logger,
    acknowledgementRetryMs: config.observationActiveSweepMs,
    ...(options.recoveryNavigatePage === undefined
      ? {}
      : { navigatePage: options.recoveryNavigatePage }),
  });
  recoveryService = recovery;
  const browserControl = new BrowserControlService({
    browserOwner,
    pageRegistry,
    uploadsEnabled: config.uploadsEnabled,
    onStarted: async () => await recovery.restore({ forceObservers: true }),
  });
  const artifactService = new ArtifactService({
    database,
    directory: teamDirectory,
    adapters: providerAdapters,
    artifactDir: config.artifactDir,
    maxArtifactFileBytes: config.maxArtifactFileBytes,
    ...(browserOwner === null ? {} : { ensurePage: (sessionId: string, generation: number) => recovery.ensurePage(sessionId, generation) }),
  });

  try {
    const preSubmitRecovered = await submissionService.recoverInterruptedPreSubmissions();
    if (preSubmitRecovered > 0) {
      logger.warn('submission.recovered-pre-submit', { count: preSubmitRecovered });
    }
    const reconciled = await submissionService.reconcileOutboxDiagnostics();
    if (reconciled > 0) {
      logger.warn('submission.reconciled-diagnostics', { count: reconciled });
    }
    const recovered = await submissionService.recoverInterruptedSubmissions();
    if (recovered > 0) {
      logger.warn('submission.recovered-ambiguous', { count: recovered });
    }
    await recovery.restore();
  } catch (error) {
    await recovery.close();
    await observationService.close();
    await browserOwner?.close();
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }

  const conversationLoadRecovery = new ConversationLoadRecovery({ maintenance, database, registry: pageRegistry,
    pageMutex: pageMutationMutex, scheduler: actorScheduler, probes: probeCoordinator,
    chatgptUrl: config.chatgptUrl });
  router.register('system.defer_account_cooldown', z.object({
    requestId: z.string().min(1).max(200), observedAt: z.iso.datetime(), until: z.iso.datetime(),
    evidenceRef: z.string().min(1).max(500),
    scope: z.enum(['chatgpt:default', 'chatgpt:conversation-list']).optional(),
  }).strict().refine(input => Date.parse(input.until) >= Date.parse(input.observedAt),
    'Cooldown cannot end before its observed rate-limit signal'), input => receipts.execute({
      clientId: 'operator-account-coordination', requestId: input.requestId,
      method: 'system.defer_account_cooldown', payload: input,
      operation: () => {
        probeCoordinator.defer(input.scope ?? 'chatgpt:conversation-list', input.until);
        return { deferred: true, scope: input.scope ?? 'chatgpt:conversation-list', ...conversationLoadRecovery.repository.pacing() };
      },
    }));
  router.register('system.health', z.object({}).strict(), () =>
    ({ ...getSystemHealth({
      config,
      database,
      startedAt,
      browserOwner,
      pageRegistry,
      actorScheduler,
      observationService,
      metrics,
    }), conversationLoadRecovery: conversationLoadRecovery.status(), maintenance: maintenance.status() }),
  );
  const handoverIdle = () => (browserOwner === null || browserOwner.status.state === 'ready') && actorScheduler.totalQueueDepth === 0 && pageMutationMutex.activeCount === 0 &&
    Number(database.raw.prepare("SELECT count(*) AS n FROM outbox WHERE submission_state IN ('submit_attempted','composer_filled')").get()!.n) === 0 &&
    Number(database.raw.prepare("SELECT count(*) AS n FROM outbox o JOIN generations g ON g.session_id=o.session_id AND g.generation=o.generation WHERE json_extract(o.payload_json,'$.thinkingFailureRecovery')=1 AND g.completed_at IS NULL").get()!.n) === 0;
  const ownerSchema = { expectedPid: z.literal(process.pid), expectedStartedAt: z.literal(startedAt.toISOString()) };
  router.register('system.maintenance.prepare', z.object({ ...ownerSchema,
    drainTimeoutMs: z.number().int().min(1).max(10_000).default(5_000),
    leaseMs: z.number().int().min(100).max(60_000).default(30_000),
  }).strict(), input => maintenance.prepare(input.drainTimeoutMs, input.leaseMs, handoverIdle));
  router.register('system.maintenance.resume', z.object({ ...ownerSchema, token: z.string().uuid() }).strict(), input => {
    maintenance.resume(input.token); return maintenance.status();
  });
  router.register('system.maintenance.commit', z.object({ ...ownerSchema, token: z.string().uuid() }).strict(), input =>
    maintenance.commit(input.token, handoverIdle, options.handoverExit ?? (() => {
      // Synchronous commit: no callback can write between the lease check and exit.
      // Do not call service.close(): it closes the still-generating Chrome.
      database.close();
      process.exit(0);
    })));
  registerBrowserMethods(router, {
    browserOwner,
    pageRegistry,
    loginUrl: config.chatgptUrl,
    profileDir: config.profileDir,
  });
  if (options.enableInternalBrowserControlRpc === true) {
    registerBrowserControlMethods(router, browserControl);
  }
  registerArtifactMethods(router, artifactService);
  const cleanup = new ConversationCleanupService({
    directory: teamDirectory, onDeleted: sessionId => recovery.forgetSession(sessionId),
    database, scheduler: actorScheduler, adapters: providerAdapters,
    pageMutex: pageMutationMutex, registry: pageRegistry,
  });
  registerSessionMethods(router, teamDirectory, receipts, cleanup);
  const ui = new SessionUiService({
    submissions: submissionService,
    registry: pageRegistry,
    chatgptUrl: config.chatgptUrl,
    quietWindowMs: config.observationQuietWindowMs,
  });
  thinkingFailureRecovery = new ThinkingFailureRecovery({ maintenance, database, submissions: submissionService, ui });
  registerSessionUiMethods(router, ui);
  registerTeamMethods(router, teamDirectory, receipts, cleanup, stopService);
  registerWorkflowMethods(router, new TeamWorkflow({
    database, directory: teamDirectory, receipts, submissions: submissionService, ui,
    scheduler: actorScheduler, artifacts: artifactService, stops: stopService, cleanup,
    pageMutex: pageMutationMutex,
    enabledProviders: config.enabledProviders,
    retireObservation: sessionId => recovery.forgetSession(sessionId),
    ensurePage: (sessionId, generation, options) => recovery.ensurePage(sessionId, generation, options),
  }));
  registerSendMethods(router, submissionService);
  registerStopMethods(router, stopService);
  registerWaitMethods(router, teamDirectory, actorScheduler);

  const rpcServer = new RpcServer({
    socketPath: config.socketPath,
    maxLineBytes: config.rpcMaxLineBytes,
    router,
    logger,
  });

  try {
    await rpcServer.listen();
  } catch (error) {
    await recovery.close();
    await thinkingFailureRecovery.close();
    await observationService.close();
    await browserOwner?.close();
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }

  thinkingFailureRecovery.restore();
  if (browserOwner && config.enabledProviders.includes('chatgpt')) conversationLoadRecovery.start();
  let closed = false;
  let browserRecovery: Promise<Readonly<Record<string, unknown>>> | null = null;
  const restartBrowser = (): Promise<Readonly<Record<string, unknown>>> => {
    if (browserRecovery !== null) return browserRecovery;
    browserRecovery = (async () => {
      if (browserOwner === null) throw new Error('Browser owner is disabled');
      const browser = await browserOwner.restart();
      const report = await recovery.restore({ forceObservers: true });
      return { browser, recovery: report };
    })().finally(() => {
      browserRecovery = null;
    });
    return browserRecovery;
  };
  const browserRecoveryTimer = browserOwner === null ? null : setInterval(() => {
    if (closed || browserRecovery !== null || maintenance.paused) return;
    const state = browserOwner.status.state;
    if (state !== 'disconnected' && state !== 'error') return;
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
  return {
    maintenance,
    config,
    database,
    rpcServer,
    browserOwner,
    pageRegistry,
    browserControl,
    artifactService,
    pageMutationMutex,
    teamDirectory,
    receipts,
    actorScheduler,
    probeCoordinator,
    metrics,
    pageBindings,
    providerAdapters,
    observationService,
    thinkingFailureRecovery,
    conversationLoadRecovery,
    recoveryService: recovery,
    submissionService,
    stopService,
    startedAt,
    async restartBrowser(): Promise<Readonly<Record<string, unknown>>> {
      return await restartBrowser();
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      maintenance.resume();
      if (browserRecoveryTimer !== null) clearInterval(browserRecoveryTimer);
      await browserRecovery?.catch(() => undefined);
      await rpcServer.close();
      await conversationLoadRecovery.close();
      await recovery.close();
      await thinkingFailureRecovery?.close();
      await observationService.close();
      await browserOwner?.close();
      actorScheduler.close();
      unsubscribePageBindings();
      metrics.close();
      database.close();
    },
  };
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
