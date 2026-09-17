import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright-core';

import { BrowserOwner } from './browser/browser-owner.ts';
import { PageMutationMutex } from './browser/page-mutex.ts';
import { PageRegistry } from './browser/page-registry.ts';
import { prepareRuntimeDirectories, resolveConfig, type SessionPlaneConfig } from './config.ts';
import { getSystemHealth } from './core/health.ts';
import { ObservationService } from './core/observation-service.ts';
import { RecoveryService } from './core/recovery-service.ts';
import { StopService } from './core/stop-service.ts';
import { TeamDirectory } from './core/team-directory.ts';
import { SubmissionService } from './core/submission-service.ts';
import { createLogger, type Logger } from './logging.ts';
import { RpcRouter } from './rpc/router.ts';
import { RpcServer } from './rpc/server.ts';
import { registerBrowserMethods } from './rpc/methods/browser.ts';
import { registerSessionMethods } from './rpc/methods/session.ts';
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
import {
  ProviderAdapterRegistry,
  type ProviderAdapter,
} from './providers/provider-adapter.ts';
import { z } from 'zod';

export interface CoreService {
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
  readonly providerAdapters: ProviderAdapterRegistry;
  readonly observationService: ObservationService;
  readonly recoveryService: RecoveryService;
  readonly submissionService: SubmissionService;
  readonly stopService: StopService;
  readonly startedAt: Date;
  restartBrowser(): Promise<Readonly<Record<string, unknown>>>;
  close(): Promise<void>;
}

export interface StartCoreOptions {
  readonly config?: SessionPlaneConfig;
  readonly logger?: Logger;
  readonly startBrowser?: boolean;
  readonly browserHeadless?: boolean;
  readonly providerAdapters?: readonly ProviderAdapter[];
  readonly recoveryNavigatePage?: (page: Page, url: string) => Promise<void>;
}

export async function startCore(options: StartCoreOptions = {}): Promise<CoreService> {
  const config = options.config ?? resolveConfig();
  prepareRuntimeDirectories(config);
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  const database = SessionPlaneDatabase.open(config.databasePath);
  const startedAt = new Date();
  const router = new RpcRouter();
  const metrics = new RuntimeMetrics();
  const pageRegistry = new PageRegistry({ metrics });
  const pageBindings = new PageBindingRepository(database.raw);
  const unsubscribePageBindings = pageRegistry.subscribe((binding) => {
    pageBindings.upsert(binding);
  });
  const pageMutationMutex = new PageMutationMutex();
  const teamDirectory = new TeamDirectory(database);
  const receipts = new ReceiptRepository(database);
  const actorScheduler = new ActorScheduler(database);
  const browserOwner =
    options.startBrowser === false
      ? null
      : new BrowserOwner({
          profileDir: config.profileDir,
          pageRegistry,
          headless: options.browserHeadless ?? false,
          launchTimeoutMs: config.browserLaunchTimeoutMs,
        });

  try {
    await browserOwner?.start();
    actorScheduler.restore();
  } catch (error) {
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }

  const providerAdapters = new ProviderAdapterRegistry(
    options.providerAdapters ??
      (browserOwner === null
        ? []
        : [
            new ChatGptAdapter({
              browserOwner,
              pageRegistry,
              loginUrl: config.chatgptUrl,
              acknowledgementTimeoutMs: config.submissionAckTimeoutMs,
              backendRequestTimeoutMs: config.backendRequestTimeoutMs,
              tokenCacheTtlMs: config.tokenCacheTtlMs,
            }),
          ]),
  );
  const probeCoordinator = new ProbeCoordinator({
    database,
    successIntervalMs: config.probeSuccessIntervalMs,
    min429BackoffMs: config.probeMin429BackoffMs,
    max429BackoffMs: config.probeMax429BackoffMs,
    metrics,
  });
  const observationService = new ObservationService({
    database,
    scheduler: actorScheduler,
    adapters: providerAdapters,
    activeSweepMs: config.observationActiveSweepMs,
    quietSweepMs: config.observationQuietSweepMs,
    quietWindowMs: config.observationQuietWindowMs,
    backendRecoveryAfterMs: config.backendRecoveryAfterMs,
    probeCoordinator,
    logger,
    metrics,
  });
  const submissionService = new SubmissionService({
    database,
    directory: teamDirectory,
    scheduler: actorScheduler,
    pageMutex: pageMutationMutex,
    adapters: providerAdapters,
    onSubmitted: (snapshot) => observationService.start(snapshot),
  });
  const stopService = new StopService({
    database,
    directory: teamDirectory,
    scheduler: actorScheduler,
    pageMutex: pageMutationMutex,
    adapters: providerAdapters,
  });
  const recoveryService = new RecoveryService({
    database,
    browserOwner,
    pageRegistry,
    scheduler: actorScheduler,
    observations: observationService,
    chatgptUrl: config.chatgptUrl,
    metrics,
    logger,
    ...(options.recoveryNavigatePage === undefined
      ? {}
      : { navigatePage: options.recoveryNavigatePage }),
  });

  try {
    const recovered = await submissionService.recoverInterruptedSubmissions();
    if (recovered > 0) {
      logger.warn('submission.recovered-ambiguous', { count: recovered });
    }
    await recoveryService.restore();
  } catch (error) {
    await observationService.close();
    await browserOwner?.close();
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }

  router.register('system.health', z.object({}).strict(), () =>
    getSystemHealth({
      config,
      database,
      startedAt,
      browserOwner,
      pageRegistry,
      actorScheduler,
      observationService,
      metrics,
    }),
  );
  registerBrowserMethods(router, {
    browserOwner,
    pageRegistry,
    loginUrl: config.chatgptUrl,
    profileDir: config.profileDir,
  });
  registerTeamMethods(router, teamDirectory, receipts);
  registerSessionMethods(router, teamDirectory, receipts);
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
    await observationService.close();
    await browserOwner?.close();
    actorScheduler.close();
    unsubscribePageBindings();
    metrics.close();
    database.close();
    throw error;
  }

  let closed = false;
  return {
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
    providerAdapters,
    observationService,
    recoveryService,
    submissionService,
    stopService,
    startedAt,
    async restartBrowser(): Promise<Readonly<Record<string, unknown>>> {
      if (browserOwner === null) {
        throw new Error('Browser owner is disabled');
      }
      const browser = await browserOwner.restart();
      const recovery = await recoveryService.restore({ forceObservers: true });
      return { browser, recovery };
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await rpcServer.close();
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
  serveForever().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

