import type { DatabaseSync } from 'node:sqlite';

/** Immutable Task attempt -> owned session generation bridge.
 * An attempt cannot borrow a later generation when the same page and
 * conversation are reused. Continuations get a new bound attempt.
 */
export const kernelAttemptSessionBindingMigration = {
  version: 11,
  name: 'kernel_attempt_session_binding',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE kernel_attempt_session_bindings (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        provider_conversation_id TEXT NOT NULL,
        bound_at TEXT NOT NULL,
        FOREIGN KEY(attempt_id) REFERENCES kernel_attempts(attempt_id),
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      ) STRICT;

      CREATE INDEX idx_kernel_attempt_session_binding_owner
        ON kernel_attempt_session_bindings(session_id, generation);
    `);
  },
} as const;
