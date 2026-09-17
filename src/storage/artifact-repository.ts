import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { ProviderArtifactCandidate } from '../providers/provider-adapter.ts';

export const ARTIFACT_STATES = ['discovered', 'downloaded', 'missing'] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const ARTIFACT_KINDS = ['file', 'image', 'archive', 'report', 'transcript'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactRecord {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly provider: string;
  readonly providerArtifactId: string;
  readonly artifactKind: ArtifactKind;
  readonly name: string;
  readonly mediaType: string | null;
  readonly sourceUrl: string;
  readonly artifactState: ArtifactState;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly relativePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ArtifactRow extends Omit<ArtifactRecord, 'generation' | 'sizeBytes'> {
  readonly generation: number;
  readonly sizeBytes: number | null;
}

export class ArtifactRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  upsertCandidate(input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly provider: string;
    readonly candidate: ProviderArtifactCandidate;
    readonly timestamp: string;
  }): ArtifactRecord {
    const existing = this.getByProviderArtifact(
      input.sessionId,
      input.generation,
      input.candidate.providerArtifactId,
    );
    if (existing !== null) {
      this.#database
        .prepare(`
          UPDATE provider_artifacts
          SET name = ?, media_type = ?, source_url = ?, updated_at = ?
          WHERE artifact_id = ?
        `)
        .run(
          input.candidate.name,
          input.candidate.mediaType,
          input.candidate.sourceUrl,
          input.timestamp,
          existing.artifactId,
        );
      return this.require(existing.artifactId);
    }

    const artifactId = randomUUID();
    this.#database
      .prepare(`
        INSERT INTO provider_artifacts(
          artifact_id, session_id, generation, provider, provider_artifact_id,
          artifact_kind, name, media_type, source_url, artifact_state,
          size_bytes, sha256, relative_path, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered', NULL, NULL, NULL, ?, ?)
      `)
      .run(
        artifactId,
        input.sessionId,
        input.generation,
        input.provider,
        input.candidate.providerArtifactId,
        inferArtifactKind(input.candidate.name, input.candidate.mediaType),
        input.candidate.name,
        input.candidate.mediaType,
        input.candidate.sourceUrl,
        input.timestamp,
        input.timestamp,
      );
    return this.require(artifactId);
  }

  markDownloaded(input: {
    readonly artifactId: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly relativePath: string;
    readonly timestamp: string;
  }): ArtifactRecord {
    const result = this.#database
      .prepare(`
        UPDATE provider_artifacts
        SET artifact_state = 'downloaded', size_bytes = ?, sha256 = ?,
            relative_path = ?, updated_at = ?
        WHERE artifact_id = ?
      `)
      .run(
        input.sizeBytes,
        input.sha256,
        input.relativePath,
        input.timestamp,
        input.artifactId,
      );
    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown artifact: ${input.artifactId}`);
    }
    return this.require(input.artifactId);
  }

  markMissing(artifactId: string, timestamp: string): ArtifactRecord {
    const result = this.#database
      .prepare(`
        UPDATE provider_artifacts
        SET artifact_state = 'missing', updated_at = ?
        WHERE artifact_id = ?
      `)
      .run(timestamp, artifactId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Unknown artifact: ${artifactId}`);
    }
    return this.require(artifactId);
  }

  get(artifactId: string): ArtifactRecord | null {
    const row = this.#database
      .prepare(`SELECT ${ARTIFACT_COLUMNS} FROM provider_artifacts WHERE artifact_id = ?`)
      .get(artifactId) as ArtifactRow | undefined;
    return row === undefined ? null : mapArtifact(row);
  }

  require(artifactId: string): ArtifactRecord {
    const artifact = this.get(artifactId);
    if (artifact === null) {
      throw new Error(`Unknown artifact: ${artifactId}`);
    }
    return artifact;
  }

  getByProviderArtifact(
    sessionId: string,
    generation: number,
    providerArtifactId: string,
  ): ArtifactRecord | null {
    const row = this.#database
      .prepare(`
        SELECT ${ARTIFACT_COLUMNS}
        FROM provider_artifacts
        WHERE session_id = ? AND generation = ? AND provider_artifact_id = ?
      `)
      .get(sessionId, generation, providerArtifactId) as ArtifactRow | undefined;
    return row === undefined ? null : mapArtifact(row);
  }

  list(sessionId: string, generation?: number): readonly ArtifactRecord[] {
    const rows = generation === undefined
      ? this.#database
          .prepare(`
            SELECT ${ARTIFACT_COLUMNS}
            FROM provider_artifacts
            WHERE session_id = ?
            ORDER BY generation, created_at, artifact_id
          `)
          .all(sessionId)
      : this.#database
          .prepare(`
            SELECT ${ARTIFACT_COLUMNS}
            FROM provider_artifacts
            WHERE session_id = ? AND generation = ?
            ORDER BY created_at, artifact_id
          `)
          .all(sessionId, generation);
    return (rows as unknown as ArtifactRow[]).map(mapArtifact);
  }
}

const ARTIFACT_COLUMNS = `
  artifact_id AS artifactId,
  session_id AS sessionId,
  generation,
  provider,
  provider_artifact_id AS providerArtifactId,
  artifact_kind AS artifactKind,
  name,
  media_type AS mediaType,
  source_url AS sourceUrl,
  artifact_state AS artifactState,
  size_bytes AS sizeBytes,
  sha256,
  relative_path AS relativePath,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function mapArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    ...row,
    generation: Number(row.generation),
    sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
  };
}

function inferArtifactKind(name: string, mediaType: string | null): ArtifactKind {
  const normalizedName = name.toLowerCase();
  const normalizedType = mediaType?.toLowerCase() ?? '';
  if (normalizedType.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/.test(normalizedName)) {
    return 'image';
  }
  if (/\.(zip|tar|tgz|gz|bz2|xz|7z)$/.test(normalizedName)) {
    return 'archive';
  }
  if (normalizedType === 'text/markdown' && /report/i.test(name)) {
    return 'report';
  }
  return 'file';
}

