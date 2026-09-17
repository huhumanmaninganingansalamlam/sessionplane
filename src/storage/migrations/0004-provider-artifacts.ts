import type { DatabaseSync } from 'node:sqlite';

export const providerArtifactsMigration = {
  version: 4,
  name: 'provider_artifacts',
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE provider_artifacts (
        artifact_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        provider TEXT NOT NULL,
        provider_artifact_id TEXT NOT NULL,
        artifact_kind TEXT NOT NULL,
        name TEXT NOT NULL,
        media_type TEXT,
        source_url TEXT NOT NULL,
        artifact_state TEXT NOT NULL,
        size_bytes INTEGER,
        sha256 TEXT,
        relative_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, generation, provider_artifact_id),
        FOREIGN KEY (session_id, generation)
          REFERENCES generations(session_id, generation)
          ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX idx_provider_artifacts_session_generation
        ON provider_artifacts(session_id, generation, created_at);
      CREATE INDEX idx_provider_artifacts_sha256
        ON provider_artifacts(sha256)
        WHERE sha256 IS NOT NULL;
    `);
  },
} as const;

