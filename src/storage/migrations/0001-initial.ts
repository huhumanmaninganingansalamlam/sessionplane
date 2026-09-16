import type { DatabaseSync } from 'node:sqlite';

export const initialMigration = {
  version: 1,
  name: 'initial',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE teams (
        team_id TEXT PRIMARY KEY,
        owner_client_id TEXT NOT NULL,
        name TEXT,
        objective TEXT,
        team_state TEXT NOT NULL,
        primary_role_id TEXT,
        shared_brief_version INTEGER NOT NULL DEFAULT 0,
        external_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE team_roles (
        role_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        role_key TEXT NOT NULL,
        role_type TEXT NOT NULL,
        display_name TEXT,
        reports_to_role_id TEXT,
        current_session_id TEXT,
        role_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        retired_at TEXT,
        UNIQUE (team_id, role_key),
        FOREIGN KEY (team_id) REFERENCES teams(team_id),
        FOREIGN KEY (reports_to_role_id) REFERENCES team_roles(role_id)
      ) STRICT;

      CREATE TABLE team_briefs (
        team_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        objective TEXT,
        brief_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (team_id, version),
        FOREIGN KEY (team_id) REFERENCES teams(team_id)
      ) STRICT;

      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        predecessor_session_id TEXT,
        session_state TEXT NOT NULL,
        provider_state TEXT NOT NULL,
        observation_transport TEXT NOT NULL,
        current_generation INTEGER NOT NULL,
        conversation_id TEXT,
        page_key TEXT,
        deadline_at TEXT,
        next_check_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (team_id) REFERENCES teams(team_id),
        FOREIGN KEY (role_id) REFERENCES team_roles(role_id),
        FOREIGN KEY (predecessor_session_id) REFERENCES sessions(session_id)
      ) STRICT;

      CREATE TABLE generations (
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        team_brief_version INTEGER NOT NULL,
        prompt_hash TEXT NOT NULL,
        submission_state TEXT NOT NULL,
        submitted_user_message_id TEXT,
        submitted_user_turn_id TEXT,
        response_message_id TEXT,
        answer_text TEXT,
        completed_at TEXT,
        PRIMARY KEY (session_id, generation),
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      ) STRICT;

      CREATE TABLE page_bindings (
        page_key TEXT PRIMARY KEY,
        binding_epoch INTEGER NOT NULL,
        team_id TEXT,
        role_id TEXT,
        session_id TEXT,
        generation INTEGER,
        conversation_id TEXT,
        binding_state TEXT NOT NULL,
        url TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE outbox (
        outbox_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        submission_state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (client_id, request_id)
      ) STRICT;

      CREATE TABLE request_receipts (
        client_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        method TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (client_id, request_id)
      ) STRICT;

      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        role_id TEXT,
        session_id TEXT,
        generation INTEGER,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE probe_budget (
        scope TEXT PRIMARY KEY,
        next_allowed_at TEXT,
        blocked_until TEXT,
        backoff_level INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_roles_team ON team_roles(team_id, role_state);
      CREATE INDEX idx_sessions_team_role ON sessions(team_id, role_id, updated_at);
      CREATE INDEX idx_events_team_sequence ON events(team_id, sequence);
      CREATE INDEX idx_outbox_session_generation ON outbox(session_id, generation);
    `);
  },
} as const;

