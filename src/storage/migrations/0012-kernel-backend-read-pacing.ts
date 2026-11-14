import type { DatabaseSync } from 'node:sqlite';

/** Profile-scoped backend pacing survives Core restart without storing auth
 * material, message bodies, task data or browser state.
 */
export const kernelBackendReadPacingMigration = {
  version: 12,
  name: 'kernel_backend_read_pacing',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE kernel_backend_read_pacing (
        provider_key TEXT NOT NULL,
        endpoint_origin TEXT NOT NULL,
        next_allowed_at_ms INTEGER NOT NULL CHECK(next_allowed_at_ms >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider_key, endpoint_origin)
      ) STRICT;
    `);
  },
} as const;
