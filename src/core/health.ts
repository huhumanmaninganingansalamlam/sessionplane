import { readFileSync } from 'node:fs';
import type { SessionPlaneConfig } from '../config.ts';
import { SESSIONPLANE_VERSION } from '../config.ts';
import { PROVIDERS } from '../providers/provider-adapter.ts';
import type { BrowserOwner } from '../browser/browser-owner.ts';
import { summarizeBrowserHealth } from '../browser/browser-health.ts';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import type { RuntimeMetrics } from '../telemetry/metrics.ts';
import type { ObservationService } from './observation-service.ts';

/** Build identity is embedded by release preflight in dist. The TypeScript
 * source runtime deliberately reports unknown instead of borrowing a stale
 * dist sibling or inventing a package checksum.
 */
function embeddedBuildIdentity(): {
  sourceCommit: string | null;
  sourceTree: string | null;
  sourceState: 'clean' | 'dirty' | 'unavailable';
} {
  try {
    const source = new URL('../build-identity.json', import.meta.url);
    const identity: unknown = JSON.parse(readFileSync(source, 'utf8'));
    if (identity === null || typeof identity !== 'object') throw new Error('Invalid identity');
    const value = identity as Record<string, unknown>;
    if (value.version !== SESSIONPLANE_VERSION || value.schemaVersion !== 1 ||
        !['clean', 'dirty', 'unavailable'].includes(String(value.sourceState))) {
      throw new Error('Mismatched embedded identity');
    }
    const commit = typeof value.sourceCommit === 'string' &&
      /^[0-9a-f]{40}$/.test(value.sourceCommit) ? value.sourceCommit : null;
    const tree = typeof value.sourceTree === 'string' &&
      /^[0-9a-f]{40}$/.test(value.sourceTree) ? value.sourceTree : null;
    if (value.sourceState === 'clean' && (!commit || !tree)) {
      throw new Error('Clean identity lacks source provenance');
    }
    return {
      sourceCommit: commit, sourceTree: tree,
      sourceState: value.sourceState as 'clean' | 'dirty' | 'unavailable',
    };
  } catch {
    return { sourceCommit: null, sourceTree: null, sourceState: 'unavailable' };
  }
}

const embeddedIdentity = embeddedBuildIdentity();

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
    schemaVersion: context.database.schemaVersion,
    sourceCommit: embeddedIdentity.sourceCommit,
    sourceTree: embeddedIdentity.sourceTree,
    sourceState: embeddedIdentity.sourceState,
    // The tarball hash lives in an external verified installation receipt,
    // never inside the tarball; unknown is not a guessed checksum.
    packageSha256: null,
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      startedAt: context.startedAt.toISOString(),
      uptimeSec: Math.max(0, Math.floor((Date.now() - context.startedAt.getTime()) / 1000)),
    },
    socket: {
      path: context.config.socketPath,
    },
    providers: {
      supported: [...PROVIDERS],
      enabled: [...context.config.enabledProviders],
      disabled: PROVIDERS.filter((provider) => !context.config.enabledProviders.includes(provider)),
    },
    database,
    browser: summarizeBrowserHealth(
      context.browserOwner?.status ?? {
        state: 'not_started',
        profileDir: context.config.profileDir,
        headless: false,
        chrome: null,
        transport: null,
        ownership: null,
        browserPid: null,
        debuggingPort: null,
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

