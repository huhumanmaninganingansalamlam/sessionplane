import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runMigrations } from './migrations/index.ts';

export interface DatabaseHealth {
  readonly path: string;
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly integrity: string;
}

export class SessionPlaneDatabase {
  readonly raw: DatabaseSync;
  readonly path: string;
  readonly schemaVersion: number;
  #closed = false;
  #transactionDepth = 0;
  #savepointSequence = 0;

  private constructor(databasePath: string, raw: DatabaseSync, schemaVersion: number) {
    this.path = databasePath;
    this.raw = raw;
    this.schemaVersion = schemaVersion;
  }

  static open(databasePath: string): SessionPlaneDatabase {
    const absolutePath = path.resolve(databasePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(absolutePath), 0o700);

    const existed = existsSync(absolutePath);
    const raw = new DatabaseSync(absolutePath);
    try {
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec('PRAGMA busy_timeout = 5000');
      const schemaVersion = runMigrations(raw);
      chmodSync(absolutePath, 0o600);
      return new SessionPlaneDatabase(absolutePath, raw, schemaVersion);
    } catch (error) {
      raw.close();
      if (!existed && existsSync(absolutePath)) {
        chmodSync(absolutePath, 0o600);
      }
      throw error;
    }
  }

  health(): DatabaseHealth {
    this.assertOpen();
    const journalRow = this.raw.prepare('PRAGMA journal_mode').get() as Record<string, unknown>;
    const foreignKeysRow = this.raw.prepare('PRAGMA foreign_keys').get() as Record<string, unknown>;
    const integrityRow = this.raw.prepare('PRAGMA quick_check').get() as Record<string, unknown>;

    return {
      path: this.path,
      schemaVersion: this.schemaVersion,
      journalMode: String(firstValue(journalRow)),
      foreignKeys: Number(firstValue(foreignKeysRow)) === 1,
      integrity: String(firstValue(integrityRow)),
    };
  }

  transaction<T>(operation: () => T): T {
    this.assertOpen();
    const outermost = this.#transactionDepth === 0;
    const savepoint = outermost ? null : `sessionplane_sp_${++this.#savepointSequence}`;
    this.raw.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.#transactionDepth += 1;
    try {
      const result = operation();
      this.raw.exec(outermost ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      if (outermost) {
        this.raw.exec('ROLLBACK');
      } else {
        this.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      throw error;
    } finally {
      this.#transactionDepth -= 1;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.raw.close();
    this.#closed = true;
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new Error('SessionPlane database is closed');
    }
  }
}

function firstValue(row: Record<string, unknown>): unknown {
  const values = Object.values(row);
  if (values.length !== 1) {
    throw new Error('Unexpected SQLite PRAGMA result');
  }
  return values[0];
}

