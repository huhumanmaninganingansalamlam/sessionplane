import type { Migration } from './index.ts';

/** Historical v1 JSON must remain byte-exact. A separate SQLite discriminator
 * makes new writes queryable without converting an old pending action into a
 * newly authorized provider effect. No external action or Decision is created.
 */
export const kernelDecisionEnvelopeV2Migration: Migration = {
  version: 17,
  name: 'kernel-decision-envelope-v2',
  up(database) {
    database.exec(`
      ALTER TABLE kernel_decisions
        ADD COLUMN envelope_version INTEGER NOT NULL DEFAULT 1
          CHECK (envelope_version IN (1, 2));
      CREATE INDEX kernel_decisions_envelope_version_idx
        ON kernel_decisions (envelope_version, status, task_id);
    `);
  },
};
