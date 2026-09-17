import type { Page } from 'playwright-core';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import { PageRegistryError, type PageRegistry } from '../browser/page-registry.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import type { Logger } from '../logging.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import type { RuntimeMetrics } from '../telemetry/metrics.ts';
import type { ObservationService } from './observation-service.ts';

export interface RestartRecoveryReport {
  readonly scanned: number;
  readonly rebound: number;
  readonly opened: number;
  readonly conflicts: number;
  readonly unavailable: number;
  readonly observersStarted: number;
  readonly durationMs: number;
}

export interface RecoveryServiceOptions {
  readonly database: SessionPlaneDatabase;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly scheduler: ActorScheduler;
  readonly observations: ObservationService;
  readonly chatgptUrl: string;
  readonly metrics?: RuntimeMetrics;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly navigatePage?: (page: Page, url: string) => Promise<void>;
}

export class RecoveryService {
  readonly #browserOwner: BrowserOwner | null;
  readonly #pageRegistry: PageRegistry;
  readonly #scheduler: ActorScheduler;
  readonly #observations: ObservationService;
  readonly #sessions: SessionRepository;
  readonly #chatgptUrl: string;
  readonly #metrics: RuntimeMetrics | null;
  readonly #logger: Logger | null;
  readonly #now: () => Date;
  readonly #navigatePage: (page: Page, url: string) => Promise<void>;
  #tail: Promise<RestartRecoveryReport> = Promise.resolve(emptyReport());

  constructor(options: RecoveryServiceOptions) {
    this.#browserOwner = options.browserOwner;
    this.#pageRegistry = options.pageRegistry;
    this.#scheduler = options.scheduler;
    this.#observations = options.observations;
    this.#sessions = new SessionRepository(options.database.raw);
    this.#chatgptUrl = options.chatgptUrl;
    this.#metrics = options.metrics ?? null;
    this.#logger = options.logger ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#navigatePage =
      options.navigatePage ??
      (async (page, url) => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      });
  }

  restore(options: { readonly forceObservers?: boolean } = {}): Promise<RestartRecoveryReport> {
    const operation = this.#tail.then(async () => await this.#restore(options));
    this.#tail = operation.catch(() => emptyReport());
    return operation;
  }

  async #restore(options: {
    readonly forceObservers?: boolean;
  }): Promise<RestartRecoveryReport> {
    const startedAtMs = this.#now().getTime();
    let rebound = 0;
    let opened = 0;
    let conflicts = 0;
    let unavailable = 0;
    let observersStarted = 0;
    const snapshots = this.#sessions.listRecoverableSnapshots();

    for (const original of snapshots) {
      if (options.forceObservers === true) {
        this.#observations.stop(original.sessionId, original.generation);
      }
      let snapshot = original;
      if (this.#browserOwner !== null && snapshot.conversationId !== null) {
        const reconciled = await this.#reconcilePage(snapshot);
        snapshot = reconciled.snapshot;
        rebound += reconciled.rebound ? 1 : 0;
        opened += reconciled.opened ? 1 : 0;
        conflicts += reconciled.conflict ? 1 : 0;
        unavailable += reconciled.unavailable ? 1 : 0;
      }
      if (isObservationReady(snapshot)) {
        this.#observations.start(snapshot, { force: options.forceObservers === true });
        observersStarted += 1;
      }
    }

    const durationMs = Math.max(0, this.#now().getTime() - startedAtMs);
    this.#metrics?.observe('restart_recovery_latency_ms', durationMs);
    const report: RestartRecoveryReport = {
      scanned: snapshots.length,
      rebound,
      opened,
      conflicts,
      unavailable,
      observersStarted,
      durationMs,
    };
    this.#logger?.info('recovery.completed', { ...report });
    return report;
  }

  async #reconcilePage(snapshot: SessionSnapshot): Promise<{
    readonly snapshot: SessionSnapshot;
    readonly rebound: boolean;
    readonly opened: boolean;
    readonly conflict: boolean;
    readonly unavailable: boolean;
  }> {
    const conversationId = snapshot.conversationId;
    if (conversationId === null) {
      return result(snapshot);
    }
    const matches = this.#pageRegistry.findByConversation(conversationId);
    if (matches.length > 1) {
      const updated = await this.#recordPageState(snapshot, {
        pageKey: null,
        observationTransport: 'stale',
        reason: 'duplicate-conversation-pages',
        errorCode: 'session.page-identity-unverified',
      }, 'generation.restart-page-conflict');
      return result(updated, { conflict: true });
    }

    if (matches.length === 1) {
      const match = matches[0];
      if (match === undefined) {
        return result(snapshot, { unavailable: true });
      }
      try {
        this.#pageRegistry.bindPage(match.pageKey, {
          sessionId: snapshot.sessionId,
          generation: snapshot.generation,
          conversationId,
        });
        const updated = await this.#recordPageState(snapshot, {
          pageKey: match.pageKey,
          observationTransport: 'fresh',
          reason: 'restart-page-rebound',
          errorCode: null,
        }, 'generation.restart-page-rebound');
        return result(updated, { rebound: true });
      } catch (error) {
        return await this.#recordUnavailable(snapshot, classifyPageFailure(error));
      }
    }

    if (this.#browserOwner === null) {
      return result(snapshot, { unavailable: true });
    }
    try {
      const created = await this.#browserOwner.createPage();
      this.#pageRegistry.reservePage(created.binding.pageKey, {
        sessionId: snapshot.sessionId,
        generation: snapshot.generation,
        conversationId: null,
      });
      const target = new URL(`/c/${encodeURIComponent(conversationId)}`, this.#chatgptUrl).href;
      await this.#navigatePage(created.page, target);
      this.#pageRegistry.refreshPage(created.binding.pageKey);
      this.#pageRegistry.bindPage(created.binding.pageKey, {
        sessionId: snapshot.sessionId,
        generation: snapshot.generation,
        conversationId,
      });
      const updated = await this.#recordPageState(snapshot, {
        pageKey: created.binding.pageKey,
        observationTransport: 'fresh',
        reason: 'restart-page-opened',
        errorCode: null,
      }, 'generation.restart-page-opened');
      return result(updated, { opened: true, rebound: true });
    } catch (error) {
      return await this.#recordUnavailable(snapshot, classifyPageFailure(error));
    }
  }

  async #recordUnavailable(
    snapshot: SessionSnapshot,
    reason: string,
  ): Promise<{
    readonly snapshot: SessionSnapshot;
    readonly rebound: boolean;
    readonly opened: boolean;
    readonly conflict: boolean;
    readonly unavailable: boolean;
  }> {
    const updated = await this.#recordPageState(snapshot, {
      pageKey: null,
      observationTransport: 'unavailable',
      reason,
      errorCode: 'session.page-identity-unverified',
    }, 'generation.restart-page-unavailable');
    return result(updated, { unavailable: true });
  }

  async #recordPageState(
    snapshot: SessionSnapshot,
    update: {
      readonly pageKey: string | null;
      readonly observationTransport: 'fresh' | 'stale' | 'unavailable';
      readonly reason: string;
      readonly errorCode: string | null;
    },
    eventType: string,
  ): Promise<SessionSnapshot> {
    if (
      snapshot.pageKey === update.pageKey &&
      snapshot.observationTransport === update.observationTransport &&
      snapshot.reason === update.reason &&
      snapshot.errorCode === update.errorCode
    ) {
      return snapshot;
    }
    return await this.#scheduler.updateGeneration(
      snapshot.sessionId,
      snapshot.generation,
      update,
      eventType,
    );
  }
}

function isObservationReady(snapshot: SessionSnapshot): boolean {
  return (
    !snapshot.terminal &&
    snapshot.pageKey !== null &&
    snapshot.conversationId !== null &&
    (snapshot.submittedUserMessageId !== null || snapshot.submittedUserTurnId !== null)
  );
}

function classifyPageFailure(error: unknown): string {
  if (error instanceof PageRegistryError) {
    return error.errorCode === 'session.conversation-mismatch'
      ? 'restart-conversation-mismatch'
      : 'restart-page-identity-unverified';
  }
  return 'restart-page-unavailable';
}

function result(
  snapshot: SessionSnapshot,
  overrides: {
    readonly rebound?: boolean;
    readonly opened?: boolean;
    readonly conflict?: boolean;
    readonly unavailable?: boolean;
  } = {},
) {
  return {
    snapshot,
    rebound: overrides.rebound ?? false,
    opened: overrides.opened ?? false,
    conflict: overrides.conflict ?? false,
    unavailable: overrides.unavailable ?? false,
  };
}

function emptyReport(): RestartRecoveryReport {
  return {
    scanned: 0,
    rebound: 0,
    opened: 0,
    conflicts: 0,
    unavailable: 0,
    observersStarted: 0,
    durationMs: 0,
  };
}
