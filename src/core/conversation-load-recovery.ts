import type { Page } from 'playwright-core';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { ProbeCoordinator } from '../scheduler/probe-coordinator.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import { EventRepository } from '../storage/event-repository.ts';
import { ConversationLoadRecoveryRepository, conversationLimitScope, type LoadRecoveryRecord } from '../storage/conversation-load-recovery-repository.ts';
import { conversationLoadSurface, type LoadSurface } from '../providers/chatgpt/conversation-load-recovery.ts';

export const LOAD_RECOVERY_INTERVAL_MS = 5_000;
export const LOAD_RECOVERY_MAX_ATTEMPTS = 100;
function limitationHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset',
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset',
    'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests']) {
    const value = headers[name]?.trim();
    if (value && value.length <= 80 && /^(?:\d+(?:\.\d+)?|(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+)$/.test(value)) safe[name] = value;
  }
  for (const name of ['ratelimit-scope', 'x-ratelimit-scope']) {
    const value = headers[name]?.trim().toLowerCase();
    if (value && /^(account|user|ip|endpoint|route|model|global)$/.test(value)) safe[name] = value;
  }
  return safe;
}

function endpointCategory(path: string): string {
  if (/^\/backend-api\/(?:f\/)?conversations(?:\/|$)/.test(path)) return 'conversation-list';
  if (/^\/backend-api\/(?:f\/)?conversation(?:\/|$)/.test(path)) return 'conversation-detail';
  if (/telemetry|metrics|analytics|events/.test(path)) return 'telemetry-or-events';
  return path.startsWith('/backend-api/') ? 'other-backend' : 'other-chatgpt';
}
type Services = { database: SessionPlaneDatabase; registry: PageRegistry; pageMutex: PageMutationMutex;
  scheduler: ActorScheduler; probes: ProbeCoordinator; chatgptUrl: string; minimumIntervalMs?: number };

/** One owner-wide UI queue; backend probe cadence is separate from proven service holds. */
export class ConversationLoadRecovery {
  readonly repository: ConversationLoadRecoveryRepository;
  readonly #sessions: SessionRepository;
  readonly #events: EventRepository;
  readonly #origin: string;
  readonly intervalMs: number;
  readonly #attached = new WeakSet<Page>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #pending: Promise<void> | null = null;
  #closed = false;
  readonly services: Services;
  readonly now: () => number;
  constructor(services: Services, now: () => number = Date.now) {
    this.services = services; this.now = now;
    this.repository = new ConversationLoadRecoveryRepository(services.database);
    this.#sessions = new SessionRepository(services.database.raw);
    this.#events = new EventRepository(services.database.raw);
    this.#origin = new URL(services.chatgptUrl).origin;
    this.intervalMs = Math.max(LOAD_RECOVERY_INTERVAL_MS, services.minimumIntervalMs ?? 0);
    this.repository.reclassifyLegacyListCooldown(new Date(this.now()).toISOString(), this.intervalMs);
  }
  start(): void {
    if (this.#timer || this.#closed) return;
    void this.sweep().catch(() => undefined);
    this.#timer = setInterval(() => { void this.sweep().catch(() => undefined); }, this.intervalMs);
    this.#timer.unref();
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#pending?.catch(() => undefined);
  }
  status() { return { intervalMs: this.intervalMs, maxAttempts: LOAD_RECOVERY_MAX_ATTEMPTS,
    nextAllowedAt: this.repository.effectiveNextAllowedAt(), pacing: this.repository.pacing(), conversations: this.repository.list() }; }
  sweep(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#pending) return this.#pending;
    this.#pending = this.#sweep().finally(() => { this.#pending = null; });
    return this.#pending;
  }
  async #surface(page: Page, session: SessionSnapshot, click: boolean): Promise<LoadSurface> {
    // The renderer also checks this lease: a late queued evaluation must never click on recovery's next turn.
    const operation = page.evaluate(conversationLoadSurface, { origin: this.#origin,
      conversationId: session.conversationId!, click, expiresAt: this.now() + 5_000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<LoadSurface>((_, reject) => {
        timer = setTimeout(() => reject(new Error('bounded-surface-timeout')), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  }
  #attach(page: Page, pageKey: string): void {
    if (this.#attached.has(page)) return;
    this.#attached.add(page);
    page.on('response', response => {
      if (this.#closed || response.status() !== 429 || new URL(response.url()).origin !== this.#origin) return;
      const received = this.now(), headers = response.headers(), header = headers['retry-after'];
      const specified = header && /^\d+(?:\.\d+)?$/.test(header) ? received + Number(header) * 1000 : Date.parse(header ?? '');
      const valid = Number.isFinite(specified);
      const until = new Date(Math.max(received + this.intervalMs, valid ? specified : received + 15 * 60_000)).toISOString();
      const safeHeaders = limitationHeaders(headers);
      const serverScope = safeHeaders['ratelimit-scope'] ?? safeHeaders['x-ratelimit-scope'] ?? 'unverified';
      const category = endpointCategory(new URL(response.url()).pathname);
      const broad = ['ratelimit-scope', 'x-ratelimit-scope'].some(name =>
        ['account', 'user', 'ip', 'global'].includes(safeHeaders[name] ?? ''));
      const binding = this.services.registry.getBinding(pageKey);
      const detailId = new URL(response.url()).pathname.match(/^\/backend-api\/(?:f\/)?conversation\/([^/]+)$/)?.[1];
      const policyScope = broad ? 'chatgpt:default' : category === 'conversation-detail' && (detailId || binding.conversationId)
        ? conversationLimitScope(detailId || binding.conversationId!) : `chatgpt:${category}`;
      this.services.probes.defer(policyScope, until);
      // Passive evidence only: no body read, probe, raw URL/query or arbitrary header values.
      try {
        const session = binding.sessionId && this.#sessions.getSnapshot(binding.sessionId);
        if (binding.state !== 'owned' || !session || session.pageKey !== pageKey ||
          session.generation !== binding.generation || session.conversationId !== binding.conversationId) return;
        if (valid) safeHeaders['retry-after'] = /^\d+(?:\.\d+)?$/.test(header!) ? String(Number(header)) : new Date(specified).toUTCString();
        const method = response.request().method();
        this.#events.append({ teamId: session.teamId, roleId: session.roleId, sessionId: session.sessionId,
          generation: session.generation, eventType: 'provider.rate-limit-observed', createdAt: new Date(received).toISOString(),
          payload: { status: 429, method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : 'unknown',
            endpointCategory: category, headers: safeHeaders,
            pageKey, bindingEpoch: binding.bindingEpoch, association: 'owned-page-at-response',
            retryAfterSource: valid ? 'valid-header' : header === undefined ? 'header-absent-fallback' : 'header-invalid-fallback',
            retryAfterDurationMs: valid ? Math.max(0, specified - received) : null,
            minimumIntervalMs: this.intervalMs, fallbackMs: valid ? null : 900_000,
            policyScope, serverScope, policyUntil: until,
            effectiveUntil: this.repository.effectiveNextAllowedAt() } });
      } catch { /* Evidence failure cannot weaken or retry the existing cooldown operation. */ }
    });
  }
  async #sweep(): Promise<void> {
    const targets = new Map<string, SessionSnapshot>();
    for (const binding of this.services.registry.listBindings()) {
      if (this.#closed || binding.state !== 'owned' || !binding.sessionId || !binding.conversationId || this.services.pageMutex.isBusy(binding.pageKey)) continue;
      const session = this.#sessions.getSnapshot(binding.sessionId);
      if (!session || session.provider !== 'chatgpt' || session.pageKey !== binding.pageKey || session.conversationId !== binding.conversationId ||
          session.generation !== binding.generation || ['submitting', 'queued'].includes(session.submissionState ?? '')) continue;
      try {
        const page = this.services.registry.requireSessionPage(binding.pageKey, session);
        this.#attach(page, binding.pageKey);
        const surface = await this.#surface(page, session, false);
        targets.set(binding.conversationId, session);
        const prior = this.repository.get(binding.conversationId);
        if (!prior && !surface.loadError) continue;
        const record: LoadRecoveryRecord = prior ?? { conversationId: binding.conversationId, url: binding.url,
          sessionId: session.sessionId, pageKey: binding.pageKey, bindingEpoch: binding.bindingEpoch,
          attempts: 0, state: 'waiting', reason: surface.reason, lastOutcome: null,
          lastCheckedAt: new Date(0).toISOString(), lastAttemptAt: null, notifiedAt: null };
        Object.assign(record, { url: binding.url, sessionId: session.sessionId, pageKey: binding.pageKey, bindingEpoch: binding.bindingEpoch });
        if (surface.kind === 'normal') this.#record(record, session, 'recovered', 'conversation-rendered');
        else if (record.state !== 'exhausted') {
          this.#record(record, session, surface.kind === 'retry' ? 'waiting' : 'held', surface.reason);
        }
      } catch { /* Page identity/channel uncertainty never authorizes a click. */ }
    }
    if (this.#closed) return;
    const next = this.repository.nextAllowedAt();
    if (next && Date.parse(next) > this.now()) return;
    const record = this.repository.list().find(r => ['waiting', 'held', 'attempting'].includes(r.state) && targets.has(r.conversationId));
    if (!record) return;
    const session = targets.get(record.conversationId)!;
    // Fair turns include held pages. Persist before actor/page work or any click.
    if (!this.repository.reserveTurn(record, new Date(this.now()).toISOString(), this.intervalMs)) return;
    const priorAttemptAt = record.lastAttemptAt;
    await this.services.scheduler.actorFor(session.sessionId).enqueue(async () => {
      if (this.#closed) return;
      const current = this.#sessions.getSnapshot(session.sessionId);
      if (!current || current.pageKey !== session.pageKey || current.conversationId !== session.conversationId || current.generation !== session.generation ||
          ['submitting', 'queued'].includes(current.submissionState ?? '')) { this.#record(record, session, 'held', 'request-state-changed'); return; }
      await this.services.pageMutex.runExclusive(record.pageKey, async () => {
        try {
          const page = this.services.registry.requireSessionPage(record.pageKey, current);
          const surface = await this.#surface(page, current, false);
          if (surface.kind === 'normal') { this.#record(record, current, 'recovered', surface.reason); return; }
          if (surface.kind !== 'retry') {
            this.#record(record, current, 'held', surface.reason); return;
          }
          if (record.attempts >= LOAD_RECOVERY_MAX_ATTEMPTS) { this.#exhaust(record, current); return; }
          // Recheck scoped service holds and reserve global UI spacing at actual dispatch.
          if (!this.repository.reserveRefresh(new Date(this.now()).toISOString(), this.intervalMs, current.conversationId!)) {
            this.#record(record, current, 'waiting', 'service-or-ui-cooldown'); return;
          }
          record.attempts++;
          record.lastAttemptAt = new Date(this.now()).toISOString();
          record.lastOutcome = 'uncertain';
          this.#record(record, current, 'attempting', 'load-retry-dispatched');
          const clicked = await this.#surface(page, current, true);
          if (!clicked.clicked) {
            record.attempts--; record.lastOutcome = 'not-clicked';
            this.#record(record, current, clicked.kind === 'normal' ? 'recovered' : 'held', clicked.reason);
          } else {
            record.lastOutcome = 'clicked';
            this.#record(record, current, 'waiting', 'load-retry-clicked');
          }
        } catch {
          this.#record(record, current, 'held', record.state === 'attempting' ? 'click-outcome-uncertain' : 'page-inspection-unavailable');
        }
      });
    });
    if (record.lastAttemptAt !== priorAttemptAt) {
      this.repository.defer(new Date(this.now() + this.intervalMs).toISOString(), new Date(this.now()).toISOString());
    }
  }
  #record(record: LoadRecoveryRecord, session: SessionSnapshot, state: LoadRecoveryRecord['state'], reason: string): void {
    const previous = this.repository.get(record.conversationId);
    if (state === 'recovered' && previous?.state !== 'recovered') record.lastCheckedAt = new Date(this.now()).toISOString();
    Object.assign(record, { state, reason });
    this.services.database.transaction(() => {
      this.repository.save(record);
      if (previous?.state === state && previous.reason === reason && previous.attempts === record.attempts && previous.lastOutcome === record.lastOutcome) return;
      this.#events.append({ teamId: session.teamId, roleId: session.roleId, sessionId: session.sessionId,
        generation: session.generation, eventType: 'conversation.load-recovery', createdAt: new Date(this.now()).toISOString(),
        payload: { ...record } });
    });
  }
  #exhaust(record: LoadRecoveryRecord, session: SessionSnapshot): void {
    record.notifiedAt ??= new Date(this.now()).toISOString();
    this.#record(record, session, 'exhausted', '100-load-retries-exhausted');
  }
}
