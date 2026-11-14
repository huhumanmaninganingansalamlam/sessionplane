import type { DatabaseSync } from 'node:sqlite';

/** Additive, immutable outgoing POST provenance for the new exact Task port.
 * It stores IDs and SHA-256 only; never credentials or a second prompt copy.
 * Existing session/outbox tables and production profiles are untouched.
 */
export const kernelDispatchEvidenceMigration = {
  version: 10,
  name: 'kernel_dispatch_evidence',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE kernel_dispatch_evidence (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        provider_conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        parent_message_id TEXT NOT NULL,
        text_hash TEXT NOT NULL CHECK(length(text_hash) = 64),
        observed_at TEXT NOT NULL,
        UNIQUE(provider_key, provider_conversation_id, message_id),
        FOREIGN KEY(attempt_id) REFERENCES kernel_attempts(attempt_id),
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id)
      ) STRICT;

      CREATE INDEX idx_kernel_dispatch_evidence_task
        ON kernel_dispatch_evidence(task_id, observed_at);
    `);
  },
} as const;
