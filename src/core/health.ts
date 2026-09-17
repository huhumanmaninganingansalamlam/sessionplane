import type { SessionPlaneConfig } from '../config.ts';
import { SESSIONPLANE_VERSION } from '../config.ts';
import type { BrowserOwner } from '../browser/browser-owner.ts';
import { summarizeBrowserHealth } from '../browser/browser-health.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import type { RuntimeMetrics } from '../telemetry/metrics.ts';
import type { ObservationService } from './observation-service.ts';

export interface HealthContext {
  readonly config: SessionPlaneConfig;
  readonly database: SessionPlaneDatabase;
  readonly startedAt: Date;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly actorScheduler: ActorScheduler;
  readonly observationService: ObservationService;
  readonly metrics: RuntimeMetrics;
}

export function getSystemHealth(context: HealthContext): Readonly<Record<string, unknown>> {
  const database = context.database.health();
  return {
    requestOk: true,
    service: 'sessionplane',
    version: SESSIONPLANE_VERSION,
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      startedAt: context.startedAt.toISOString(),
      uptimeSec: Math.max(0, Math.floor((Date.now() - context.startedAt.getTime()) / 1000)),
    },
    socket: {
      path: context.config.socketPath,
    },
    database,
    browser: summarizeBrowserHealth(
      context.browserOwner?.status ?? {
        state: 'not_started',
        profileDir: context.config.profileDir,
        headless: false,
        chrome: null,
        lastError: null,
      },
      context.pageRegistry.listBindings(),
    ),
    metrics: context.metrics.snapshot({
      sessionActorCount: context.actorScheduler.actorCount,
      sessionActorQueueDepth: context.actorScheduler.totalQueueDepth,
      waitSubscriberCount: context.actorScheduler.totalSubscriberCount,
      observerCount: context.observationService.observerCount,
    }),
  };
}

