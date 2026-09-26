import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import type {
  ProviderAdapterRegistry,
  ProviderArtifactCandidate,
} from '../providers/provider-adapter.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import { EventRepository } from '../storage/event-repository.ts';
import {
  ArtifactRepository,
  type ArtifactRecord,
} from '../storage/artifact-repository.ts';
import type { TeamDirectory } from './team-directory.ts';

export interface ArtifactSelector {
  readonly sessionId?: string;
  readonly teamId?: string;
  readonly roleKey?: string;
  readonly generation?: number;
}

export class ArtifactService {
  readonly #database: SessionPlaneDatabase;
  readonly #directory: TeamDirectory;
  readonly #adapters: ProviderAdapterRegistry;
  readonly #artifacts: ArtifactRepository;
  readonly #events: EventRepository;
  readonly #artifactDir: string;
  readonly #maxArtifactFileBytes: number;
  readonly #now: () => Date;
  readonly #captureTails = new Map<string, Promise<void>>();

  constructor(options: {
    readonly database: SessionPlaneDatabase;
    readonly directory: TeamDirectory;
    readonly adapters: ProviderAdapterRegistry;
    readonly artifactDir: string;
    readonly maxArtifactFileBytes: number;
    readonly now?: () => Date;
  }) {
    this.#database = options.database;
    this.#directory = options.directory;
    this.#adapters = options.adapters;
    this.#artifacts = new ArtifactRepository(options.database.raw);
    this.#events = new EventRepository(options.database.raw);
    this.#artifactDir = path.resolve(options.artifactDir);
    this.#maxArtifactFileBytes = options.maxArtifactFileBytes;
    this.#now = options.now ?? (() => new Date());
  }

  async discover(selector: ArtifactSelector): Promise<Readonly<Record<string, unknown>>> {
    const { snapshot, bindingGeneration } = this.#resolveAnswer(selector);
    const adapter = this.#adapters.require(snapshot.provider);
    if (adapter.discoverArtifacts === undefined) {
      throw new SessionPlaneDomainError(
        'provider.artifacts-unavailable',
        `Provider ${snapshot.provider} does not expose artifact discovery`,
      );
    }
    const candidates = await adapter.discoverArtifacts({
      session: snapshot,
      generation: snapshot.generation, bindingGeneration,
    });
    const artifacts = this.#persistCandidates(snapshot, candidates);
    return artifactListResult(snapshot, artifacts);
  }

  async capture(
    selector: ArtifactSelector & { readonly artifactIds?: readonly string[] },
  ): Promise<Readonly<Record<string, unknown>>> {
    const { snapshot, bindingGeneration } = this.#resolveAnswer(selector);
    const captureKey = `${snapshot.sessionId}:${snapshot.generation}`;
    return await this.#runExclusive(captureKey, async () => {
      const stored = this.#artifacts.list(snapshot.sessionId, snapshot.generation);
      if (bindingGeneration !== snapshot.generation && stored.length > 0 && stored.every((artifact) => this.#reuseDownloaded(artifact) !== null)) {
        const artifacts = selectArtifacts(stored, selector.artifactIds);
        return { ...artifactListResult(snapshot, artifacts), discoveredCount: stored.length, capturedCount: artifacts.length, failures: [] };
      }
      const adapter = this.#adapters.require(snapshot.provider);
      if (adapter.discoverArtifacts === undefined || adapter.downloadArtifact === undefined) {
        throw new SessionPlaneDomainError(
          'provider.artifacts-unavailable',
          `Provider ${snapshot.provider} does not expose artifact capture`,
        );
      }

      const candidates = await adapter.discoverArtifacts({
        session: snapshot, generation: snapshot.generation, bindingGeneration,
      });
      const discovered = this.#persistCandidates(snapshot, candidates);
      const selected = selectArtifacts(discovered, selector.artifactIds);
      const captured: ArtifactRecord[] = [];
      const failures: Array<Readonly<Record<string, unknown>>> = [];

      for (const artifact of selected) {
        try {
          const reusable = this.#reuseDownloaded(artifact);
          if (reusable !== null) {
            captured.push(reusable);
            continue;
          }
          const candidate = candidateFromRecord(artifact);
          const downloaded = await adapter.downloadArtifact(
            { session: snapshot, generation: snapshot.generation, bindingGeneration },
            candidate,
          );
          if (downloaded.candidate.providerArtifactId !== artifact.providerArtifactId) {
            throw new SessionPlaneDomainError(
              'internal.invariant-violation',
              'Provider returned bytes for a different artifact identity',
            );
          }
          const bytes = Buffer.from(downloaded.bytes);
          if (bytes.length === 0) {
            throw new SessionPlaneDomainError(
              'provider.artifact-empty',
              `Provider artifact is empty: ${artifact.name}`,
            );
          }
          if (bytes.length > this.#maxArtifactFileBytes) {
            throw new SessionPlaneDomainError(
              'provider.artifact-too-large',
              `Provider artifact exceeds ${this.#maxArtifactFileBytes} bytes: ${artifact.name}`,
              { sizeBytes: bytes.length, limitBytes: this.#maxArtifactFileBytes },
            );
          }
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const relativePath = this.#storeContent(sha256, bytes);
          const timestamp = this.#now().toISOString();
          const updated = this.#database.transaction(() => {
            const record = this.#artifacts.markDownloaded({
              artifactId: artifact.artifactId,
              sizeBytes: bytes.length,
              sha256,
              relativePath,
              timestamp,
            });
            this.#events.append({
              teamId: snapshot.teamId,
              roleId: snapshot.roleId,
              sessionId: snapshot.sessionId,
              generation: snapshot.generation,
              eventType: 'artifact.downloaded',
              payload: {
                artifactId: record.artifactId,
                artifactKind: record.artifactKind,
                sizeBytes: record.sizeBytes,
                sha256: record.sha256,
              },
              createdAt: timestamp,
            });
            return record;
          });
          captured.push(updated);
        } catch (error) {
          failures.push({
            artifactId: artifact.artifactId,
            name: artifact.name,
            errorCode:
              error instanceof SessionPlaneDomainError
                ? error.errorCode
                : 'provider.artifact-download-failed',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return {
        requestOk: failures.length === 0,
        sessionId: snapshot.sessionId,
        generation: snapshot.generation,
        discoveredCount: discovered.length,
        capturedCount: captured.length,
        artifacts: captured,
        failures,
      };
    });
  }

  list(selector: ArtifactSelector) {
    const snapshot = this.#resolveSession(selector);
    const generation = selector.generation ?? snapshot.generation;
    return artifactListResult(
      snapshot,
      this.#artifacts.list(snapshot.sessionId, generation),
      generation,
    );
  }

  get(artifactId: string): Readonly<Record<string, unknown>> {
    const artifact = this.#requireArtifact(artifactId);
    this.#directory.getSession(artifact.sessionId);
    return { requestOk: true, artifact };
  }

  export(input: {
    readonly artifactId: string;
    readonly outputPath: string;
    readonly overwrite?: boolean;
  }): Readonly<Record<string, unknown>> {
    const artifact = this.#requireArtifact(input.artifactId);
    if (
      artifact.artifactState !== 'downloaded' ||
      artifact.relativePath === null ||
      artifact.sha256 === null ||
      artifact.sizeBytes === null
    ) {
      throw new SessionPlaneDomainError(
        'provider.artifact-not-downloaded',
        `Artifact ${input.artifactId} has not been downloaded`,
      );
    }
    const sourcePath = this.#resolveStoredPath(artifact.relativePath);
    if (!existsSync(sourcePath)) {
      this.#artifacts.markMissing(artifact.artifactId, this.#now().toISOString());
      throw new SessionPlaneDomainError(
        'provider.artifact-missing',
        `Stored bytes are missing for artifact ${input.artifactId}`,
      );
    }

    const outputPath = path.resolve(input.outputPath);
    if (existsSync(outputPath) && input.overwrite !== true) {
      const existing = readFileSync(outputPath);
      const existingHash = createHash('sha256').update(existing).digest('hex');
      if (existingHash === artifact.sha256) {
        return exportResult(artifact, outputPath, true);
      }
      throw new SessionPlaneDomainError(
        'input.output-exists',
        `Refusing to replace existing output: ${outputPath}`,
      );
    }

    mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.sessionplane-${randomUUID()}.part`;
    try {
      copyFileSync(sourcePath, temporaryPath);
      chmodSync(temporaryPath, 0o600);
      if (input.overwrite === true) {
        rmSync(outputPath, { force: true });
      }
      renameSync(temporaryPath, outputPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    return exportResult(artifact, outputPath, false);
  }

  #persistCandidates(
    snapshot: SessionSnapshot,
    candidates: readonly ProviderArtifactCandidate[],
  ): readonly ArtifactRecord[] {
    const timestamp = this.#now().toISOString();
    return this.#database.transaction(() => {
      const records = candidates.map((candidate) =>
        this.#artifacts.upsertCandidate({
          sessionId: snapshot.sessionId,
          generation: snapshot.generation,
          provider: snapshot.provider,
          candidate,
          timestamp,
        }),
      );
      if (records.length > 0) {
        this.#events.append({
          teamId: snapshot.teamId,
          roleId: snapshot.roleId,
          sessionId: snapshot.sessionId,
          generation: snapshot.generation,
          eventType: 'artifact.discovered',
          payload: { count: records.length },
          createdAt: timestamp,
        });
      }
      return records;
    });
  }

  #reuseDownloaded(artifact: ArtifactRecord): ArtifactRecord | null {
    if (
      artifact.artifactState !== 'downloaded' ||
      artifact.relativePath === null ||
      artifact.sha256 === null ||
      artifact.sizeBytes === null
    ) {
      return null;
    }
    const storedPath = this.#resolveStoredPath(artifact.relativePath);
    if (
      !existsSync(storedPath) ||
      statSync(storedPath).size !== artifact.sizeBytes ||
      createHash('sha256').update(readFileSync(storedPath)).digest('hex') !== artifact.sha256
    ) {
      this.#artifacts.markMissing(artifact.artifactId, this.#now().toISOString());
      return null;
    }
    return artifact;
  }

  #storeContent(sha256: string, bytes: Buffer): string {
    const relativePath = path.join('sha256', sha256.slice(0, 2), sha256);
    const destination = this.#resolveStoredPath(relativePath);
    if (existsSync(destination)) {
      if (
        statSync(destination).size !== bytes.length ||
        createHash('sha256').update(readFileSync(destination)).digest('hex') !== sha256
      ) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          `Content-addressed artifact size mismatch for ${sha256}`,
        );
      }
      return relativePath;
    }
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(destination), 0o700);
    const temporaryPath = `${destination}.${randomUUID()}.part`;
    try {
      writeFileSync(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporaryPath, destination);
      chmodSync(destination, 0o600);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
    return relativePath;
  }

  #resolveStoredPath(relativePath: string): string {
    const resolved = path.resolve(this.#artifactDir, relativePath);
    if (resolved !== this.#artifactDir && !resolved.startsWith(`${this.#artifactDir}${path.sep}`)) {
      throw new SessionPlaneDomainError(
        'internal.invariant-violation',
        'Artifact path escaped the configured artifact directory',
      );
    }
    return resolved;
  }

  #resolveAnswer(selector: ArtifactSelector): { snapshot: SessionSnapshot; bindingGeneration: number } {
    const snapshot = this.#resolveSession(selector);
    if (snapshot.generation <= 0) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        `Session ${snapshot.sessionId} has no submitted generation`,
      );
    }
    if (selector.generation !== undefined && selector.generation > snapshot.generation) {
      throw new SessionPlaneDomainError('session.generation-superseded', 'Requested generation has not been created');
    }
    if (selector.generation !== undefined && selector.generation !== snapshot.generation) {
      const previous = new SessionRepository(this.#database.raw).getGenerationResult(snapshot.sessionId, selector.generation);
      if (previous === null || previous.completedAt === null || previous.responseMessageId === null || previous.errorCode !== null) {
        throw new SessionPlaneDomainError('provider.artifacts-unavailable', 'No completed exact answer exists for this generation');
      }
      return { bindingGeneration: snapshot.generation, snapshot: {
        ...snapshot, ...previous, sessionState: 'complete', providerState: 'complete', terminal: true, nextCheckAt: null,
      } };
    }
    return { snapshot, bindingGeneration: snapshot.generation };
  }

  #resolveSession(selector: ArtifactSelector): SessionSnapshot {
    if (selector.sessionId !== undefined) {
      return this.#directory.getSession(selector.sessionId);
    }
    if (selector.teamId === undefined || selector.roleKey === undefined) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        'Artifact operation requires sessionId or teamId + roleKey',
      );
    }
    return this.#directory.getCurrentSession(selector.teamId, selector.roleKey);
  }

  #requireArtifact(artifactId: string): ArtifactRecord {
    const artifact = this.#artifacts.get(artifactId);
    if (artifact === null) {
      throw new SessionPlaneDomainError(
        'input.artifact-not-found',
        `Unknown artifact: ${artifactId}`,
      );
    }
    return artifact;
  }

  async #runExclusive<Result>(key: string, operation: () => Promise<Result>): Promise<Result> {
    const previous = this.#captureTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#captureTails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#captureTails.get(key) === tail) {
        this.#captureTails.delete(key);
      }
    }
  }
}

function candidateFromRecord(artifact: ArtifactRecord): ProviderArtifactCandidate {
  return {
    providerArtifactId: artifact.providerArtifactId,
    name: artifact.name,
    sourceUrl: artifact.sourceUrl,
    mediaType: artifact.mediaType,
  };
}

function selectArtifacts(
  artifacts: readonly ArtifactRecord[],
  requested: readonly string[] | undefined,
): readonly ArtifactRecord[] {
  if (requested === undefined || requested.length === 0) {
    return artifacts;
  }
  const requestedSet = new Set(requested);
  const selected = artifacts.filter(
    (artifact) =>
      requestedSet.has(artifact.artifactId) ||
      requestedSet.has(artifact.providerArtifactId),
  );
  const matched = new Set(
    selected.flatMap((artifact) => [artifact.artifactId, artifact.providerArtifactId]),
  );
  const missing = [...requestedSet].filter((id) => !matched.has(id));
  if (missing.length > 0) {
    throw new SessionPlaneDomainError(
      'input.artifact-not-found',
      `Requested artifact identities were not discovered: ${missing.join(', ')}`,
    );
  }
  return selected;
}

function artifactListResult(
  snapshot: SessionSnapshot,
  artifacts: readonly ArtifactRecord[],
  generation = snapshot.generation,
) {
  return {
    requestOk: true,
    teamId: snapshot.teamId,
    roleKey: snapshot.roleKey,
    sessionId: snapshot.sessionId,
    generation,
    artifacts,
  };
}

function exportResult(
  artifact: ArtifactRecord,
  outputPath: string,
  reused: boolean,
): Readonly<Record<string, unknown>> {
  return {
    requestOk: true,
    artifactId: artifact.artifactId,
    sessionId: artifact.sessionId,
    generation: artifact.generation,
    outputPath,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    reused,
  };
}

