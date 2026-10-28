import type { DatabaseSync } from 'node:sqlite';

export const generationEventIndexMigration = {
  version: 8,
  name: 'generation_event_index',
  up(database: DatabaseSync): void {
    database.exec(`CREATE INDEX idx_events_session_generation_sequence
      ON events(session_id, generation, sequence);`);
  },
} as const;
