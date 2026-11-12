import type { DatabaseSync } from 'node:sqlite';

/**
 * The first ChatGPT POST has no authenticated provider conversation ID yet.
 * Persist its exact outgoing message ID and content hash separately from
 * the normal bound-conversation dispatch journal. This is NOT an ACK.
 */
export const kernelRootDispatchEvidenceMigration = {
  version: 14,
  name: 'kernel_root_dispatch_evidence',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE kernel_root_dispatch_evidence (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        page_key TEXT NOT NULL,
        target_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation>=1),
        binding_epoch INTEGER NOT NULL CHECK(binding_epoch >= 1),
        observation_count INTEGER NOT NULL DEFAULT 1 CHECK(observation_count >= 1),
        ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(ambiguous IN (0,1)),
        message_id TEXT NOT NULL,
        parent_message_id TEXT NOT NULL,
        text_hash TEXT NOT NULL CHECK(length(text_hash) = 64),
        observed_at TEXT NOT NULL,
        request_conversation_id TEXT,
        canonical_conversation_id TEXT,
        UNIQUE(provider_key, message_id),
        FOREIGN KEY(attempt_id) REFERENCES kernel_attempts(attempt_id),
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id)
      ) STRICT;

      CREATE INDEX idx_kernel_root_dispatch_task
        ON kernel_root_dispatch_evidence(task_id, observed_at);
    `);
  },
} as const;
