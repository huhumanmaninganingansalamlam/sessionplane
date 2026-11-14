import type { DatabaseSync } from 'node:sqlite';

/** One immutable result per owner/requestId, committed in the same transaction
 * as the cancellation event and timer revocation. No provider credentials or
 * prompt text are stored here.
 */
export const kernelTaskCancelReceiptsMigration = {
  version: 15,
  name: 'kernel_task_cancel_receipts',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE kernel_task_cancel_receipts (
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY(client_id, request_id),
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id)
      ) STRICT;
      CREATE INDEX idx_kernel_cancel_receipt_task
        ON kernel_task_cancel_receipts(task_id);
    `);
  },
} as const;
