import type { DatabaseSync } from 'node:sqlite';

/**
 * Additive schema for the new Task kernel. The existing team/session/outbox
 * tables remain intact until the separately approved data-cutover task.
 */
export const durableTaskKernelMigration = {
  version: 9,
  name: 'durable_task_kernel',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE kernel_projects (
        project_id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE kernel_project_access (
        project_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        access_role TEXT NOT NULL CHECK(access_role IN ('owner', 'member')),
        PRIMARY KEY(project_id, client_id),
        FOREIGN KEY(project_id) REFERENCES kernel_projects(project_id)
      ) STRICT;

      CREATE TABLE kernel_slots (
        project_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        role_key TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        provider_conversation_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        active_task_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(project_id, slot_id),
        UNIQUE(project_id, role_key),
        FOREIGN KEY(project_id) REFERENCES kernel_projects(project_id)
      ) STRICT;

      CREATE TABLE kernel_slot_bindings (
        project_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        provider_key TEXT NOT NULL,
        provider_conversation_id TEXT,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(project_id, slot_id, revision),
        FOREIGN KEY(project_id, slot_id) REFERENCES kernel_slots(project_id, slot_id)
      ) STRICT;

      CREATE TABLE kernel_tasks (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        slot_revision INTEGER NOT NULL,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        original_prompt TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'working', 'agent_input_required', 'human_input_required',
          'uncertain', 'completed', 'failed', 'canceled'
        )),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
        pending_decision_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, client_id, request_id),
        FOREIGN KEY(project_id, slot_id) REFERENCES kernel_slots(project_id, slot_id)
      ) STRICT;

      CREATE INDEX idx_kernel_tasks_slot
        ON kernel_tasks(project_id, slot_id, created_at);

      CREATE TABLE kernel_attempts (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        kind TEXT NOT NULL CHECK(kind IN ('initial', 'continuation', 'stop')),
        turn_key TEXT NOT NULL,
        content TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'planned', 'dispatched', 'acknowledged', 'uncertain',
          'failed_before_dispatch'
        )),
        external_turn_id TEXT,
        dispatched_at TEXT,
        acknowledged_at TEXT,
        uncertain_reason TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, sequence),
        UNIQUE(task_id, turn_key),
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id)
      ) STRICT;

      CREATE INDEX idx_kernel_attempts_task
        ON kernel_attempts(task_id, sequence);

      CREATE TABLE kernel_decisions (
        decision_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        audience TEXT NOT NULL CHECK(audience IN ('agent', 'human')),
        context_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'resolved', 'superseded')),
        resolution_json TEXT,
        action_consumed INTEGER NOT NULL DEFAULT 0 CHECK(action_consumed IN (0, 1)),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id)
      ) STRICT;

      CREATE UNIQUE INDEX idx_kernel_one_pending_decision
        ON kernel_decisions(task_id) WHERE status = 'pending';

      CREATE TABLE kernel_timers (
        timer_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        due_at TEXT NOT NULL,
        context_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'fired', 'canceled')),
        created_at TEXT NOT NULL,
        fired_at TEXT,
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id)
      ) STRICT;

      CREATE INDEX idx_kernel_due_timers
        ON kernel_timers(status, due_at, timer_id);

      CREATE TABLE kernel_results (
        result_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL UNIQUE,
        external_turn_id TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        completes_task INTEGER NOT NULL CHECK(completes_task IN (0, 1)),
        observed_at TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id),
        FOREIGN KEY(attempt_id) REFERENCES kernel_attempts(attempt_id)
      ) STRICT;

      CREATE INDEX idx_kernel_results_task
        ON kernel_results(task_id, observed_at);

      CREATE TABLE kernel_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        task_revision INTEGER NOT NULL CHECK(task_revision > 0),
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, task_revision),
        FOREIGN KEY(task_id) REFERENCES kernel_tasks(task_id)
      ) STRICT;
    `);
  },
} as const;
