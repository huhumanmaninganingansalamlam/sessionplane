import type { DatabaseSync } from 'node:sqlite';

export const submissionOutboxMigration = {
  version: 3,
  name: 'submission_outbox',
  up(database: DatabaseSync): void {
    database.exec(`
      ALTER TABLE generations ADD COLUMN reason TEXT;
      ALTER TABLE generations ADD COLUMN error_code TEXT;
      ALTER TABLE generations ADD COLUMN prompt_submitted INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE outbox ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE outbox ADD COLUMN result_json TEXT;
      ALTER TABLE outbox ADD COLUMN error_code TEXT;
      ALTER TABLE outbox ADD COLUMN prompt_submitted INTEGER NOT NULL DEFAULT 0;

      CREATE INDEX idx_outbox_submission_state
        ON outbox(submission_state, updated_at);
    `);
  },
} as const;

