import { pathToFileURL } from 'node:url';

import { BrowserOwner } from './browser/browser-owner.ts';
import { PageMutationMutex } from './browser/page-mutex.ts';
import { PageRegistry } from './browser/page-registry.ts';
import { prepareRuntimeDirectories, resolveConfig, type SessionPlaneConfig } from './config.ts';
import { getSystemHealth } from './core/health.ts';
import { createLogger, type Logger } from './logging.ts';
import { RpcRouter } from './rpc/router.ts';
import { RpcServer } from './rpc/server.ts';
import { registerBrowserMethods } from './rpc/methods/browser.ts';
import { SessionPlaneDatabase } from './storage/database.ts';
import { z } from 'zod';

export interface CoreService {
  readonly config: SessionPlaneConfig;
  readonly database: SessionPlaneDatabase;
  readonly rpcServer: RpcServer;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly pageMutationMutex: PageMutationMutex;
  readonly startedAt: Date;
  close(): Promise<void>;
}

export interface StartCoreOptions {
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
  const router = new RpcRouter();
  const pageRegistry = new PageRegistry();
  const pageMutationMutex = new PageMutationMutex();
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
  } catch (error) {
    database.close();
    throw error;
  }

  router.register('system.health', z.object({}).strict(), () =>
    getSystemHealth({ config, database, startedAt, browserOwner, pageRegistry }),
  );
  registerBrowserMethods(router, {
    browserOwner,
    pageRegistry,
    loginUrl: config.chatgptUrl,
    profileDir: config.profileDir,
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
    startedAt,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await rpcServer.close();
      await browserOwner?.close();
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

