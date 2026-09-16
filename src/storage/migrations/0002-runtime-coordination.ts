import type { DatabaseSync } from 'node:sqlite';

export const runtimeCoordinationMigration = {
  version: 2,
  name: 'runtime_coordination',
  up(database: DatabaseSync): void {
    database.exec(`
      ALTER TABLE request_receipts
        ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE request_receipts
        ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
      ALTER TABLE request_receipts
        ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

      CREATE INDEX idx_receipts_method_status
        ON request_receipts(method, status);
      CREATE INDEX idx_events_session_sequence
        ON events(session_id, sequence);
    `);
  },
} as const;

