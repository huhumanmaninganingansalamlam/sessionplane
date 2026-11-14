import type { DatabaseSync } from 'node:sqlite';

/**
 * Public admission metadata is separate from exact provider/page identity.
 * Project keys are scoped by caller in the canonical service; mutation
 * request receipts and continuation delegation survive Core restart.
 */
export const publicTaskAdmissionMigration = {
  version: 13,
  name: 'public_task_admission',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE kernel_public_project_intents (
        project_id TEXT PRIMARY KEY,
        owner_client_id TEXT NOT NULL,
        public_project_key TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        surface_intent TEXT NOT NULL,
        model_intent TEXT,
        main_slot_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(owner_client_id, public_project_key),
        FOREIGN KEY(project_id) REFERENCES kernel_projects(project_id)
      ) STRICT;

      CREATE TABLE kernel_public_slot_revisions (
        project_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        PRIMARY KEY(project_id, slot_id),
        FOREIGN KEY(project_id, slot_id) REFERENCES kernel_slots(project_id, slot_id)
      ) STRICT;

      CREATE TABLE kernel_public_project_open_requests (
        owner_client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(owner_client_id, request_id),
        FOREIGN KEY(project_id) REFERENCES kernel_projects(project_id)
      ) STRICT;

      CREATE TABLE kernel_public_task_policies (
        task_id TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL,
        input_sha256 TEXT NOT NULL,
        accepted_revision INTEGER NOT NULL CHECK(accepted_revision > 0),
        created_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id)
      ) STRICT;
    `);
  },
} as const;
