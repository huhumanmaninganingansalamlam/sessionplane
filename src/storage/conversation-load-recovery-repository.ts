import type { SessionPlaneDatabase } from './database.ts';
import { ProbeBudgetRepository } from './probe-budget-repository.ts';

export const conversationLimitScope = (conversationId: string) => `chatgpt:conversation-detail:${conversationId}`;
export const LOAD_RECOVERY_SCOPE = 'chatgpt:conversation-load-ui';
export interface LoadRecoveryRecord {
  conversationId: string; url: string; sessionId: string; pageKey: string; bindingEpoch: number;
  attempts: number; state: 'waiting' | 'held' | 'attempting' | 'recovered' | 'exhausted';
  reason: string; lastOutcome: 'clicked' | 'not-clicked' | 'uncertain' | null;
  lastCheckedAt: string; lastAttemptAt: string | null; notifiedAt: string | null;
}
const columns = `conversation_id AS conversationId, url, session_id AS sessionId,
  page_key AS pageKey, binding_epoch AS bindingEpoch, attempts, state, reason,
  last_outcome AS lastOutcome, last_checked_at AS lastCheckedAt,
  last_attempt_at AS lastAttemptAt, notified_at AS notifiedAt`;

export class ConversationLoadRecoveryRepository {
  readonly database: SessionPlaneDatabase;
  constructor(database: SessionPlaneDatabase) { this.database = database; }
  get(conversationId: string): LoadRecoveryRecord | null {
    const row = this.database.raw.prepare(`SELECT ${columns} FROM conversation_load_recovery WHERE conversation_id=?`)
      .get(conversationId) as unknown as LoadRecoveryRecord | undefined;
    return row ? { ...row } : null;
  }
  list(): LoadRecoveryRecord[] {
    return this.database.raw.prepare(`SELECT ${columns} FROM conversation_load_recovery ORDER BY last_checked_at, conversation_id`)
      .all() as unknown as LoadRecoveryRecord[];
  }
  save(record: LoadRecoveryRecord): void {
    this.database.raw.prepare(`INSERT INTO conversation_load_recovery VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET url=excluded.url, session_id=excluded.session_id,
      page_key=excluded.page_key, binding_epoch=excluded.binding_epoch, attempts=excluded.attempts,
      state=excluded.state, reason=excluded.reason, last_outcome=excluded.last_outcome,
      last_checked_at=excluded.last_checked_at, last_attempt_at=excluded.last_attempt_at,
      notified_at=excluded.notified_at`).run(record.conversationId, record.url, record.sessionId,
        record.pageKey, record.bindingEpoch, record.attempts, record.state, record.reason,
        record.lastOutcome, record.lastCheckedAt, record.lastAttemptAt, record.notifiedAt);
  }
  nextAllowedAt(): string | null {
    const b = new ProbeBudgetRepository(this.database.raw).get(LOAD_RECOVERY_SCOPE);
    return [b?.nextAllowedAt, b?.blockedUntil].filter((v): v is string => !!v).sort().at(-1) ?? null;
  }
  /** Relocate only a legacy blanket hold whose exact persisted deadline has list-only proof. */
  reclassifyLegacyListCooldown(now: string, intervalMs: number): void {
    this.database.transaction(() => {
      const budgets = new ProbeBudgetRepository(this.database.raw), prior = budgets.get('chatgpt:default');
      if (!prior?.blockedUntil || prior.blockedUntil <= now || prior.backoffLevel || prior.consecutiveFailures ||
          (prior.nextAllowedAt && prior.nextAllowedAt > prior.blockedUntil)) return;
      const signals = this.database.raw.prepare(`SELECT sequence,team_id,payload_json FROM events
        WHERE event_type='provider.rate-limit-observed'
          AND json_extract(payload_json,'$.policyScope')='chatgpt:default'
          AND json_extract(payload_json,'$.policyUntil')>?`).all(now) as
        { sequence: number; team_id: string; payload_json: string }[];
      const listOnly = (p: Record<string, any>) => p.method === 'GET' && p.endpointCategory === 'conversation-list' &&
        !['account','user','ip','global'].some(scope => [p.serverScope,p.headers?.['ratelimit-scope'],p.headers?.['x-ratelimit-scope']].includes(scope));
      const proof = signals.find(row => { const p = JSON.parse(row.payload_json); return p.policyUntil === prior.blockedUntil && listOnly(p); });
      if (!proof) return; // Unknown provenance is retained, never weakened.
      const other = signals.map(row => JSON.parse(row.payload_json)).filter(p => !listOnly(p)).map(p => p.policyUntil);
      // Unattributed operator holds remain conservative; old receipts themselves are immutable.
      const receipts = this.database.raw.prepare(`SELECT result_json FROM request_receipts WHERE status='complete'
        AND method='system.defer_account_cooldown' AND json_extract(result_json,'$.account.blockedUntil')>?`).all(now) as {result_json:string}[];
      other.push(...receipts.map(row => JSON.parse(row.result_json).account.blockedUntil));
      const retained = other.sort().at(-1) ?? null;
      if (retained === prior.blockedUntil) return;
      const listUntil = signals.map(row => JSON.parse(row.payload_json)).filter(listOnly).map(p => p.policyUntil).sort().at(-1)!;
      const listPrior = budgets.get('chatgpt:conversation-list');
      budgets.save({ ...prior, scope: 'chatgpt:conversation-list', blockedUntil: [listUntil,listPrior?.blockedUntil].filter(Boolean).sort().at(-1)!,
        nextAllowedAt: [listUntil,listPrior?.nextAllowedAt].filter(Boolean).sort().at(-1)!, updatedAt: now });
      budgets.save({ ...prior, blockedUntil: retained, nextAllowedAt: retained, updatedAt: now });
      const ui = budgets.get(LOAD_RECOVERY_SCOPE);
      if (ui?.nextAllowedAt === prior.blockedUntil && !ui.blockedUntil) {
        const lastAttempt = this.list().map(row => row.lastAttemptAt).filter((v): v is string => !!v).sort().at(-1);
        budgets.save({ ...ui, nextAllowedAt: lastAttempt ? new Date(Date.parse(lastAttempt) + intervalMs).toISOString() : null, updatedAt: now });
      }
      this.database.raw.prepare(`INSERT INTO events(team_id,event_type,payload_json,created_at) VALUES (?,?,?,?)`)
        .run(proof.team_id, 'provider.rate-limit-scope-reclassified', JSON.stringify({ evidenceSequence: proof.sequence,
          originalUntil: prior.blockedUntil, scope: 'chatgpt:conversation-list', retainedAccountUntil: retained }), now);
    });
  }
  serviceNextAllowedAt(conversationId?: string): string | null {
    const budgets = new ProbeBudgetRepository(this.database.raw);
    return [budgets.get('chatgpt:default')?.blockedUntil,
      conversationId ? budgets.get(conversationLimitScope(conversationId))?.blockedUntil : null]
      .filter((v): v is string => !!v).sort().at(-1) ?? null;
  }
  effectiveNextAllowedAt(conversationId?: string): string | null {
    const { ui } = this.pacing();
    return [ui?.nextAllowedAt, ui?.blockedUntil, this.serviceNextAllowedAt(conversationId)]
      .filter((v): v is string => !!v).sort().at(-1) ?? null;
  }
  pacing() {
    const budgets = new ProbeBudgetRepository(this.database.raw);
    return { ui: budgets.get(LOAD_RECOVERY_SCOPE), account: budgets.get('chatgpt:default') };
  }
  reserveRefresh(now: string, intervalMs: number, conversationId?: string): boolean {
    return this.database.transaction(() => {
      const deadline = this.effectiveNextAllowedAt(conversationId);
      if (deadline && Date.parse(deadline) > Date.parse(now)) return false;
      const until = new Date(Date.parse(now) + intervalMs).toISOString();
      this.defer(until, now);
      return true;
    });
  }
  reserveTurn(record: LoadRecoveryRecord, now: string, _intervalMs: number): boolean {
    return this.database.transaction(() => {
      const deadline = this.nextAllowedAt();
      if (deadline && Date.parse(deadline) > Date.parse(now)) return false;
      record.lastCheckedAt = now;
      this.save(record);
      return true;
    });
  }
  defer(until: string, now: string): void {
    this.database.transaction(() => {
      const budgets = new ProbeBudgetRepository(this.database.raw);
      const prior = budgets.get(LOAD_RECOVERY_SCOPE);
      budgets.save({ scope: LOAD_RECOVERY_SCOPE, nextAllowedAt: [until, prior?.nextAllowedAt, prior?.blockedUntil].filter((v): v is string => !!v).sort().at(-1)!,
        blockedUntil: prior?.blockedUntil ?? null, backoffLevel: 0, consecutiveFailures: 0, updatedAt: now });
    });
  }
}
