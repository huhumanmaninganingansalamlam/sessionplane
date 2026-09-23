import type { DatabaseSync } from 'node:sqlite';

export const teamOwnerIndexMigration = {
  version: 5,
  name: 'team_owner_index',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE INDEX idx_teams_owner_created
        ON teams(owner_client_id, created_at, team_id);
    `);
  },
} as const;
