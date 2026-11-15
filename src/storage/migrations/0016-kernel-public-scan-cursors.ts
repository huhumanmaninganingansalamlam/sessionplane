import type { Migration } from './index.ts';

/** Core-owned fairness positions are deliberately not Task events or provider
 * evidence. Each bounded scan advances atomically with selecting its batch.
 * No foreign key: a deleted/completed Task is just a stable ordering marker.
 */
export const kernelPublicScanCursorsMigration: Migration = {
  version: 16,
  name: 'kernel-public-scan-cursors',
  up(database) {
    database.exec(`
      CREATE TABLE kernel_public_scan_cursors (
        scan_kind TEXT PRIMARY KEY CHECK (scan_kind IN (
          'root_prepare', 'root_initial', 'initial', 'bound_prepare',
          'root_reconcile', 'ack_reconcile', 'final'
        )),
        last_task_id TEXT NOT NULL CHECK (length(last_task_id) > 0),
        last_attempt_sequence INTEGER NOT NULL CHECK (last_attempt_sequence >= 0)
      ) STRICT;

      CREATE TABLE kernel_public_preparation_phase (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        next_kind TEXT NOT NULL CHECK (next_kind IN ('root', 'bound'))
      ) STRICT;
    `);
  },
};
