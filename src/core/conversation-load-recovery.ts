import type { Page } from 'playwright-core';
import type { PageRegistry } from '../browser/page-registry.ts';
import type { PageMutationMutex } from '../browser/page-mutex.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { ProbeCoordinator } from '../scheduler/probe-coordinator.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import { EventRepository } from '../storage/event-repository.ts';
import { ConversationLoadRecoveryRepository, type LoadRecoveryRecord } from '../storage/conversation-load-recovery-repository.ts';
import { conversationLoadSurface, type LoadSurface } from '../providers/chatgpt/conversation-load-recovery.ts';

export const LOAD_RECOVERY_INTERVAL_MS = 60_000;
export const LOAD_RECOVERY_MAX_ATTEMPTS = 100;
type Services = { database: SessionPlaneDatabase; registry: PageRegistry; pageMutex: PageMutationMutex;
  scheduler: ActorScheduler; probes: ProbeCoordinator; chatgptUrl: string; minimumIntervalMs?: number };

/** One owner-wide queue; all UI retries also share the existing ChatGPT account probe budget. */
export class ConversationLoadRecovery {
  readonly repository: ConversationLoadRecoveryRepository;
  readonly #sessions: SessionRepository;
  readonly #events: EventRepository;
  readonly #origin: string;
  readonly intervalMs: number;
  readonly #attached = new WeakSet<Page>();
  readonly #probeCaller = Symbol('conversation-load-recovery');
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
    this.services.probes.withdraw('chatgpt:default', this.#probeCaller);
  }
  status() { return { intervalMs: this.intervalMs, maxAttempts: LOAD_RECOVERY_MAX_ATTEMPTS,
    nextAllowedAt: this.repository.nextAllowedAt(), conversations: this.repository.list() }; }
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
  #attach(page: Page): void {
    if (this.#attached.has(page)) return;
    this.#attached.add(page);
    page.on('response', response => {
      if (this.#closed || response.status() !== 429 || new URL(response.url()).origin !== this.#origin) return;
      const header = response.headers()['retry-after'];
      const specified = header && /^\d+(?:\.\d+)?$/.test(header) ? this.now() + Number(header) * 1000 : Date.parse(header ?? '');
      const until = new Date(Math.max(this.now() + this.intervalMs, Number.isFinite(specified) ? specified : this.now() + 15 * 60_000)).toISOString();
      this.repository.defer(until, new Date(this.now()).toISOString());
      this.services.probes.defer('chatgpt:default', until);
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
        this.#attach(page);
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
    if (!record) { this.services.probes.withdraw('chatgpt:default', this.#probeCaller); return; }
    const session = targets.get(record.conversationId)!;
    // Fair turns include held pages. Persist before actor/page work or any click.
    if (!this.repository.reserveTurn(record, new Date(this.now()).toISOString(), this.intervalMs)) return;
    const probe = await this.services.probes.run('chatgpt:default', async () => {
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
              if (surface.reason === 'service-limited') {
                const until = new Date(this.now() + 15 * 60_000).toISOString();
                this.repository.defer(until, new Date(this.now()).toISOString());
                this.services.probes.defer('chatgpt:default', until);
              }
              this.#record(record, current, 'held', surface.reason); return;
            }
            if (record.attempts >= LOAD_RECOVERY_MAX_ATTEMPTS) { this.#exhaust(record, current); return; }
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
      return { kind: 'pending', observationTransport: 'fresh', responseMessageId: null, answerText: null,
        reason: 'conversation-load-recovery', retryAfterMs: null, nextCheckAt: null };
    }, this.#probeCaller, this.intervalMs);
    if (probe.kind === 'deferred' && probe.nextCheckAt) {
      this.repository.defer(probe.nextCheckAt, new Date(this.now()).toISOString());
      this.#record(record, session, 'waiting', 'account-probe-paced');
    }
  }
  #record(record: LoadRecoveryRecord, session: SessionSnapshot, state: LoadRecoveryRecord['state'], reason: string): void {
    const previous = this.repository.get(record.conversationId);
    if (state === 'recovered' && previous?.state !== 'recovered') record.lastCheckedAt = new Date(this.now()).toISOString();
    Object.assign(record, { state, reason });
    let changed = false;
    this.services.database.transaction(() => {
      this.repository.save(record);
      if (previous?.state === state && previous.reason === reason && previous.attempts === record.attempts && previous.lastOutcome === record.lastOutcome) return;
      changed = true;
      this.#events.append({ teamId: session.teamId, roleId: session.roleId, sessionId: session.sessionId,
        generation: session.generation, eventType: 'conversation.load-recovery', createdAt: new Date(this.now()).toISOString(),
        payload: { ...record } });
    });
    // Publish the committed notice to existing native waiters without changing the generation.
    if (changed && state === 'exhausted') this.services.scheduler.refreshSession(session.sessionId);
  }
  #exhaust(record: LoadRecoveryRecord, session: SessionSnapshot): void {
    record.notifiedAt ??= new Date(this.now()).toISOString();
    this.#record(record, session, 'exhausted', '100-load-retries-exhausted');
  }
}
