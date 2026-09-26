import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import { isProviderUrl } from '../browser/page-binding.ts';
import { PageRegistryError, type PageRegistry } from '../browser/page-registry.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { Logger } from '../logging.ts';
import type { ProviderAdapterRegistry } from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { PageBindingRepository } from '../storage/page-binding-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import type { RuntimeMetrics } from '../telemetry/metrics.ts';
import type { ObservationService } from './observation-service.ts';
import type { SubmissionService } from './submission-service.ts';

export interface RestartRecoveryReport {
  readonly scanned: number;
  readonly rebound: number;
  readonly opened: number;
  readonly conflicts: number;
  readonly unavailable: number;
  readonly skippedDisabled: number;
  readonly conversationsRecovered: number;
  readonly acknowledgementsRecovered: number;
  readonly observersStarted: number;
  readonly durationMs: number;
}

export interface RecoveryServiceOptions {
  readonly database: SessionPlaneDatabase;
  readonly browserOwner: BrowserOwner | null;
  readonly pageRegistry: PageRegistry;
  readonly scheduler: ActorScheduler;
  readonly observations: ObservationService;
  readonly adapters: ProviderAdapterRegistry;
  readonly submissions: SubmissionService;
  readonly chatgptUrl: string;
  readonly geminiUrl: string;
  readonly grokUrl: string;
  readonly metrics?: RuntimeMetrics;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly acknowledgementRetryMs?: number;
  readonly navigatePage?: (page: Page, url: string) => Promise<void>;
}

interface AcknowledgementWatcher {
  readonly controller: AbortController;
  promise: Promise<void>;
}

export class RecoveryService {
  readonly #browserOwner: BrowserOwner | null;
  readonly #pageRegistry: PageRegistry;
  readonly #scheduler: ActorScheduler;
  readonly #observations: ObservationService;
  readonly #adapters: ProviderAdapterRegistry;
  readonly #submissions: SubmissionService;
  readonly #sessions: SessionRepository;
  readonly #pageBindings: PageBindingRepository;
  readonly #providerUrls: RecoveryProviderUrls;
  readonly #metrics: RuntimeMetrics | null;
  readonly #logger: Logger | null;
  readonly #now: () => Date;
  readonly #acknowledgementRetryMs: number;
  readonly #navigatePage: (page: Page, url: string) => Promise<void>;
  readonly #acknowledgementWatchers = new Map<string, AcknowledgementWatcher>();
  #closed = false;
  #tail: Promise<RestartRecoveryReport> = Promise.resolve(emptyReport());

  constructor(options: RecoveryServiceOptions) {
    this.#browserOwner = options.browserOwner;
    this.#pageRegistry = options.pageRegistry;
    this.#scheduler = options.scheduler;
    this.#observations = options.observations;
    this.#adapters = options.adapters;
    this.#submissions = options.submissions;
    this.#sessions = new SessionRepository(options.database.raw);
    this.#pageBindings = new PageBindingRepository(options.database.raw);
    this.#providerUrls = {
      chatgptUrl: options.chatgptUrl,
      geminiUrl: options.geminiUrl,
      grokUrl: options.grokUrl,
    };
    this.#metrics = options.metrics ?? null;
    this.#logger = options.logger ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#acknowledgementRetryMs = Math.max(1, options.acknowledgementRetryMs ?? 5_000);
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

  async ensurePage(sessionId: string, generation: number): Promise<void> {
    const operation = this.#tail.then(async () => {
      const snapshot = this.#sessions.getSnapshot(sessionId);
      if (snapshot === null || snapshot.generation !== generation) {
        throw new SessionPlaneDomainError('session.generation-superseded', 'Artifact page ownership changed');
      }
      this.#adapters.require(snapshot.provider);
      if (snapshot.pageKey !== null) {
        try {
          this.#pageRegistry.requireSessionPage(snapshot.pageKey, {
            sessionId, generation, conversationId: snapshot.conversationId,
          });
          return;
        } catch (error) {
          if (!(error instanceof PageRegistryError) || error.errorCode !== 'browser.unavailable') throw error;
        }
      }
      const recovered = await this.#reconcilePage(snapshot);
      if (recovered.unavailable || recovered.conflict || recovered.snapshot.pageKey === null) {
        throw new SessionPlaneDomainError('browser.unavailable', 'Exact artifact conversation page could not be recovered');
      }
    });
    this.#tail = operation.then(() => emptyReport(), () => emptyReport());
    await operation;
  }

  watchAcknowledgementRecovery(
    snapshot: SessionSnapshot,
    delayFirstAttempt = false,
  ): void {
    if (
      this.#closed ||
      !needsAcknowledgementRecovery(snapshot) ||
      !this.#adapters.has(snapshot.provider)
    ) {
      return;
    }
    const key = `${snapshot.sessionId}:${snapshot.generation}`;
    if (this.#acknowledgementWatchers.has(key)) return;

    const controller = new AbortController();
    const watcher: AcknowledgementWatcher = {
      controller,
      promise: Promise.resolve(),
    };
    this.#acknowledgementWatchers.set(key, watcher);
    watcher.promise = this.#watchAcknowledgementRecovery(
      snapshot,
      controller.signal,
      delayFirstAttempt ? this.#acknowledgementRetryMs : 0,
    )
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          this.#logger?.warn('recovery.acknowledgement-retry-failed', {
            sessionId: snapshot.sessionId,
            generation: snapshot.generation,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (this.#acknowledgementWatchers.get(key) === watcher) {
          this.#acknowledgementWatchers.delete(key);
        }
      });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const watchers = [...this.#acknowledgementWatchers.values()];
    for (const watcher of watchers) watcher.controller.abort();
    await Promise.allSettled(watchers.map((watcher) => watcher.promise));
    this.#acknowledgementWatchers.clear();
  }

  async #restore(options: {
    readonly forceObservers?: boolean;
  }): Promise<RestartRecoveryReport> {
    const startedAtMs = this.#now().getTime();
    let rebound = 0;
    let opened = 0;
    let conflicts = 0;
    let unavailable = 0;
    let skippedDisabled = 0;
    let conversationsRecovered = 0;
    let acknowledgementsRecovered = 0;
    let observersStarted = 0;
    const snapshots = this.#sessions.listRecoverableSnapshots();

    for (const original of snapshots) {
      if (options.forceObservers === true) {
        this.#observations.stop(original.sessionId, original.generation);
      }
      if (!this.#adapters.has(original.provider)) {
        skippedDisabled += 1;
        continue;
      }

      let snapshot = original;
      const hadConversation = snapshot.conversationId !== null;
      snapshot = await this.#recoverConversationIdentity(snapshot);
      if (!hadConversation && snapshot.conversationId !== null) {
        conversationsRecovered += 1;
      }

      if (
        this.#browserOwner !== null &&
        shouldRecoverPage(snapshot) &&
        snapshot.conversationId !== null
      ) {
        const reconciled = await this.#reconcilePage(snapshot);
        snapshot = reconciled.snapshot;
        rebound += reconciled.rebound ? 1 : 0;
        opened += reconciled.opened ? 1 : 0;
        conflicts += reconciled.conflict ? 1 : 0;
        unavailable += reconciled.unavailable ? 1 : 0;
      }

      if (
        snapshot.submissionState === 'submission_unknown' &&
        snapshot.pageKey !== null &&
        snapshot.conversationId !== null &&
        snapshot.submittedUserMessageId === null &&
        snapshot.submittedUserTurnId === null
      ) {
        const recovered = await this.#submissions.recoverAcknowledgement(snapshot);
        if (
          snapshot.submissionState === 'submission_unknown' &&
          recovered.submissionState === 'submitted'
        ) {
          acknowledgementsRecovered += 1;
        }
        snapshot = recovered;
      }

      if (needsAcknowledgementRecovery(snapshot)) {
        this.watchAcknowledgementRecovery(snapshot, true);
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
      skippedDisabled,
      conversationsRecovered,
      acknowledgementsRecovered,
      observersStarted,
      durationMs,
    };
    this.#logger?.info('recovery.completed', { ...report });
    return report;
  }

  async #watchAcknowledgementRecovery(
    initial: SessionSnapshot,
    signal: AbortSignal,
    initialDelayMs: number,
  ): Promise<void> {
    const session = this.#sessions.getSession(initial.sessionId);
    const deadlineMs = session?.deadlineAt === null || session?.deadlineAt === undefined
      ? Number.NaN
      : Date.parse(session.deadlineAt);
    const retryUntilMs = Math.max(
      Number.isFinite(deadlineMs) ? deadlineMs : 0,
      this.#now().getTime() + 60_000,
    );
    let delayMs = initialDelayMs;
    let pageRecoveryAttempted = false;
    while (!signal.aborted) {
      if (delayMs > 0) {
        const remainingMs = retryUntilMs - this.#now().getTime();
        if (remainingMs <= 0) return;
        delayMs = Math.min(delayMs, remainingMs);
        try {
          await delay(delayMs, undefined, { signal });
        } catch {
          return;
        }
        if (this.#now().getTime() >= retryUntilMs) return;
      }

      const snapshot = this.#sessions.getSnapshot(initial.sessionId);
      if (
        snapshot === null ||
        snapshot.generation !== initial.generation ||
        !needsAcknowledgementRecovery(snapshot)
      ) {
        return;
      }

      let identified = await this.#recoverConversationIdentity(snapshot);
      if (
        this.#browserOwner !== null &&
        identified.conversationId !== null &&
        !pageRecoveryAttempted
      ) {
        pageRecoveryAttempted = true;
        identified = (await this.#reconcilePage(identified)).snapshot;
      }
      if (identified.pageKey !== null && identified.conversationId !== null) {
        const recovered = await this.#submissions.recoverAcknowledgement(identified);
        if (!needsAcknowledgementRecovery(recovered)) return;
      }

      const remainingMs = retryUntilMs - this.#now().getTime();
      if (remainingMs <= 0) return;
      delayMs = Math.min(this.#acknowledgementRetryMs, remainingMs);
    }
  }

  async #recoverConversationIdentity(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
    if (
      snapshot.conversationId !== null ||
      snapshot.submissionState !== 'submission_unknown'
    ) {
      return snapshot;
    }
    const conversationIds = [
      ...new Set(
        this.#pageBindings
          .listForSession(snapshot.sessionId)
          .filter(
            (binding) =>
              binding.generation === snapshot.generation &&
              binding.conversationId !== null &&
              isProviderUrl(snapshot.provider, binding.url),
          )
          .map((binding) => binding.conversationId)
          .filter((value): value is string => value !== null),
      ),
    ];
    if (conversationIds.length !== 1) return snapshot;
    const conversationId = conversationIds[0];
    if (conversationId === undefined) return snapshot;
    return await this.#scheduler.updateGeneration(
      snapshot.sessionId,
      snapshot.generation,
      { conversationId },
      'generation.restart-conversation-recovered',
    );
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
    const matches = this.#pageRegistry
      .findByConversation(conversationId)
      .filter((page) => isProviderUrl(snapshot.provider, page.url));
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

    const redirectIds = snapshot.provider === 'chatgpt' && conversationId.startsWith('WEB:')
      ? [...new Set(this.#pageBindings.listForSession(snapshot.sessionId)
          .filter((binding) =>
            binding.generation === snapshot.generation &&
            (binding.bindingState === 'identity_lost' || binding.bindingState === 'closed') &&
            binding.conversationId !== null &&
            !binding.conversationId.startsWith('WEB:') &&
            isProviderUrl(snapshot.provider, binding.url))
          .map((binding) => binding.conversationId))]
      : [];
    const redirectId = redirectIds.length === 1 ? redirectIds[0] : null;
    if (redirectId !== null && redirectId !== undefined) {
      const candidates = this.#pageRegistry.findByConversation(redirectId)
        .filter((page) => isProviderUrl(snapshot.provider, page.url));
      if (candidates.length > 1) {
        return await this.#recordUnavailable(snapshot, 'restart-page-redirect-conflict');
      }
      const candidate = candidates[0];
      if (candidate !== undefined) {
        try {
          this.#pageRegistry.reserveRedirectCandidate(candidate.pageKey, {
            sessionId: snapshot.sessionId,
            generation: snapshot.generation,
            previousConversationId: conversationId,
            conversationId: redirectId,
          });
          const updated = await this.#recordPageState(snapshot, {
            pageKey: candidate.pageKey,
            observationTransport: 'stale',
            reason: 'restart-page-redirect-unverified',
            errorCode: 'session.page-identity-unverified',
          }, 'generation.restart-page-rebound');
          return result(updated, { rebound: true });
        } catch (error) {
          return await this.#recordUnavailable(snapshot, classifyPageFailure(error));
        }
      }
    }

    if (this.#browserOwner === null) {
      return result(snapshot, { unavailable: true });
    }
    let createdPage: Page | null = null;
    try {
      const created = await this.#browserOwner.createPage();
      createdPage = created.page;
      this.#pageRegistry.reservePage(created.binding.pageKey, {
        sessionId: snapshot.sessionId,
        generation: snapshot.generation,
        conversationId: null,
      });
      const target = providerConversationUrl(
        snapshot.provider,
        redirectId ?? conversationId,
        this.#providerUrls,
      );
      await this.#navigatePage(created.page, target);
      const navigated = this.#pageRegistry.refreshPage(created.binding.pageKey);
      if (
        snapshot.provider === 'chatgpt' &&
        conversationId.startsWith('WEB:') &&
        navigated.state === 'identity_lost' &&
        navigated.conversationId !== null &&
        !navigated.conversationId.startsWith('WEB:')
      ) {
        const updated = await this.#recordPageState(snapshot, {
          pageKey: created.binding.pageKey,
          observationTransport: 'stale',
          reason: 'restart-page-redirect-unverified',
          errorCode: 'session.page-identity-unverified',
        }, 'generation.restart-page-opened');
        createdPage = null;
        return result(updated, { opened: true });
      }
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
      createdPage = null;
      return result(updated, { opened: true, rebound: true });
    } catch (error) {
      await createdPage?.close().catch(() => undefined);
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
    const preserveGenerationDiagnostic =
      snapshot.submissionState === 'submission_unknown' ||
      (!snapshot.promptSubmitted && snapshot.errorCode !== null);
    const effectiveUpdate =
      snapshot.terminal || (preserveGenerationDiagnostic && update.errorCode === null)
        ? {
            ...update,
            reason: snapshot.reason,
            errorCode: snapshot.errorCode,
          }
        : update;
    if (
      snapshot.pageKey === effectiveUpdate.pageKey &&
      snapshot.observationTransport === effectiveUpdate.observationTransport &&
      snapshot.reason === effectiveUpdate.reason &&
      snapshot.errorCode === effectiveUpdate.errorCode
    ) {
      return snapshot;
    }
    return await this.#scheduler.updateGeneration(
      snapshot.sessionId,
      snapshot.generation,
      effectiveUpdate,
      eventType,
    );
  }
}

export interface RecoveryProviderUrls {
  readonly chatgptUrl: string;
  readonly geminiUrl: string;
  readonly grokUrl: string;
}

export function providerConversationUrl(
  provider: string,
  conversationId: string,
  urls: RecoveryProviderUrls,
): string {
  const encoded = encodeURIComponent(conversationId);
  if (provider === 'chatgpt') {
    return new URL(`/c/${encoded}`, urls.chatgptUrl).href;
  }
  if (provider === 'gemini') {
    return new URL(`/app/${encoded}`, urls.geminiUrl).href;
  }
  if (provider === 'grok') {
    return new URL(`/c/${encoded}`, urls.grokUrl).href;
  }
  throw new Error(`Unsupported provider recovery URL: ${provider}`);
}

function isObservationReady(snapshot: SessionSnapshot): boolean {
  return (
    !snapshot.terminal &&
    snapshot.submissionState === 'submitted' &&
    snapshot.pageKey !== null &&
    snapshot.conversationId !== null &&
    (snapshot.submittedUserMessageId !== null || snapshot.submittedUserTurnId !== null)
  );
}

function needsAcknowledgementRecovery(snapshot: SessionSnapshot): boolean {
  return (
    !snapshot.terminal &&
    snapshot.submissionState === 'submission_unknown' &&
    snapshot.promptSubmitted &&
    snapshot.submittedUserMessageId === null &&
    snapshot.submittedUserTurnId === null
  );
}

function shouldRecoverPage(snapshot: SessionSnapshot): boolean {
  return (
    snapshot.promptSubmitted ||
    snapshot.submissionState === 'submitted' ||
    snapshot.submissionState === 'submission_unknown'
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
    skippedDisabled: 0,
    conversationsRecovered: 0,
    acknowledgementsRecovered: 0,
    observersStarted: 0,
    durationMs: 0,
  };
}
