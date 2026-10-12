import type { DatabaseSync } from 'node:sqlite';

export const pageTargetIdentityMigration = {
  version: 6,
  name: 'page_target_identity',
  up(database: DatabaseSync): void {
    database.exec('ALTER TABLE page_bindings ADD COLUMN target_id TEXT');
  },
} as const;
