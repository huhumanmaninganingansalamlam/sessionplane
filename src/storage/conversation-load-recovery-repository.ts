import type { SessionPlaneDatabase } from './database.ts';
import { ProbeBudgetRepository } from './probe-budget-repository.ts';

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
  reserveTurn(record: LoadRecoveryRecord, now: string, intervalMs: number): boolean {
    return this.database.transaction(() => {
      const deadline = this.nextAllowedAt();
      if (deadline && Date.parse(deadline) > Date.parse(now)) return false;
      record.lastCheckedAt = now;
      this.save(record);
      this.defer(new Date(Date.parse(now) + intervalMs).toISOString(), now);
      return true;
    });
  }
  defer(until: string, now: string): void {
    this.database.transaction(() => {
      const budgets = new ProbeBudgetRepository(this.database.raw);
      const prior = budgets.get(LOAD_RECOVERY_SCOPE);
      budgets.save({ scope: LOAD_RECOVERY_SCOPE, nextAllowedAt: [until, this.nextAllowedAt()].filter((v): v is string => !!v).sort().at(-1)!,
        blockedUntil: prior?.blockedUntil ?? null, backoffLevel: 0, consecutiveFailures: 0, updatedAt: now });
    });
  }
}
