import type { DatabaseSync } from 'node:sqlite';

export const conversationLoadRecoveryMigration = {
  version: 7,
  name: 'conversation_load_recovery',
  up(database: DatabaseSync): void {
    database.exec(`CREATE TABLE conversation_load_recovery (
      conversation_id TEXT PRIMARY KEY, url TEXT NOT NULL,
      session_id TEXT NOT NULL, page_key TEXT NOT NULL, binding_epoch INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 100),
      state TEXT NOT NULL, reason TEXT NOT NULL, last_outcome TEXT,
      last_checked_at TEXT NOT NULL, last_attempt_at TEXT, notified_at TEXT
    ) STRICT;`);
  },
} as const;
