import type { DatabaseSync } from 'node:sqlite';

import { initialMigration } from './0001-initial.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(database: DatabaseSync): void;
}

export const migrations: readonly Migration[] = [initialMigration];

export function runMigrations(database: DatabaseSync, now: () => Date = () => new Date()): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const appliedRows = database
    .prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  const insert = database.prepare(
    'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      migration.up(database);
      insert.run(migration.version, migration.name, now().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };
  return Number(row.version);
}

