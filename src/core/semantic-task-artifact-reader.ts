import { createHash } from 'node:crypto';

import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { SemanticArtifactReadResult } from '../providers/semantic-adapter.ts';
import type { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { TaskKernelRepository } from '../storage/task-kernel-repository.ts';

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export type VerifiedTaskArtifactRead =
  | { readonly kind: 'unsupported'; readonly reason:
      'provider_not_registered' | 'capability_not_supported' }
  | { readonly kind: 'denied'; readonly reason:
      'task_not_authorized' | 'access_denied' }
  | { readonly kind: 'unavailable'; readonly reason:
      'exact_final_not_found' | 'artifact_provenance_unverified' |
      'artifact_read_unavailable' | 'missing_file' }
  | { readonly kind: 'verified'; readonly resultId: string;
      readonly externalTurnId: string; readonly artifactRef: string;
      readonly sha256: string; readonly sizeBytes: number;
      readonly mediaType: string; readonly bytes: Uint8Array };

/**
 * Provider-neutral X04 artifact seam, deliberately independent of legacy
 * artifact storage, browser paths, names, and the public text-only B-first API.
 *
 * The provider may supply bytes only for an exact recorded FINAL belonging to
 * the authorized caller. Returned metadata is untrusted until independently
 * matched to durable Task/attempt/binding identity and SHA-256 bytes.
 */
export class SemanticTaskArtifactReader {
  readonly #repository: TaskKernelRepository;
  readonly #providers: SemanticProviderRegistry;
  readonly #maxBytes: number;

  constructor(input: {
    repository: TaskKernelRepository;
    providers: SemanticProviderRegistry;
    maxBytes?: number;
  }) {
    this.#repository = input.repository;
    this.#providers = input.providers;
    this.#maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1 ||
        this.#maxBytes > DEFAULT_MAX_BYTES) {
      throw new Error('Invalid artifact read byte limit');
    }
  }

  async read(input: {
    taskId: string; clientId: string; resultId: string; artifactRef: string;
  }): Promise<VerifiedTaskArtifactRead> {
    // Artifact reference is opaque, never a file path or provider-supplied
    // download URL. Do not translate it into filesystem access.
    if (typeof input.artifactRef !== 'string' ||
        input.artifactRef.length < 1 || input.artifactRef.length > 1024 ||
        typeof input.resultId !== 'string' || input.resultId.length < 1) {
      return { kind: 'unavailable', reason: 'artifact_provenance_unverified' };
    }
    let full: ReturnType<TaskKernelRepository['getFullTask']>;
    try {
      full = this.#repository.getFullTask(input.taskId, input.clientId);
    } catch (error) {
      if (error instanceof SessionPlaneDomainError &&
          error.errorCode === 'invalid_request' &&
          error.message === 'Project access denied') {
        return { kind: 'denied', reason: 'task_not_authorized' };
      }
      if (error instanceof Error && error.message === 'Unknown task') {
        return { kind: 'denied', reason: 'task_not_authorized' };
      }
      throw error;
    }
    const result = full.results.find(row => row.resultId === input.resultId);
    if (!result) return { kind: 'unavailable', reason: 'exact_final_not_found' };
    const attempt = full.attempts.find(row => row.attemptId === result.attemptId);
    if (!attempt || attempt.kind === 'stop' || attempt.state !== 'acknowledged' ||
        attempt.externalTurnId === null ||
        attempt.externalTurnId !== result.externalTurnId) {
      return { kind: 'unavailable', reason: 'artifact_provenance_unverified' };
    }

    const task = full.task;
    const binding = this.#repository.getBindingAtRevision(
      task.projectId, task.slotId, task.slotRevision, input.clientId);
    const resolved = this.#providers.resolve(binding.providerKey, 'artifact_read');
    if (resolved.kind === 'unsupported') return resolved;
    const conversationId = binding.providerConversationId;
    if (!conversationId) {
      return { kind: 'unavailable', reason: 'artifact_provenance_unverified' };
    }

    // The registry has already checked that an artifact_read declaration has
    // a real handler. This non-null guard remains a fail-closed boundary.
    if (typeof resolved.adapter.readArtifact !== 'function') {
      return { kind: 'unsupported', reason: 'capability_not_supported' };
    }
    let observed: SemanticArtifactReadResult;
    try {
      observed = await resolved.adapter.readArtifact({
        context: {
          projectId: task.projectId, slotId: task.slotId,
          slotRevision: task.slotRevision, taskId: task.taskId,
          providerConversationId: conversationId,
          submittedUserMessageId: null,
          submittedUserTurnId: attempt.externalTurnId,
          pageLease: null,
        },
        resultId: input.resultId,
        artifactRef: input.artifactRef,
      });
    } catch {
      return { kind: 'unavailable', reason: 'artifact_read_unavailable' };
    }
    if (observed.kind === 'denied') {
      return { kind: 'denied', reason: 'access_denied' };
    }
    if (observed.kind === 'unavailable') {
      // Never promote untrusted provider error descriptions to public logs or
      // filenames. A missing provider object is distinctly not a text FINAL.
      return { kind: 'unavailable', reason: observed.reason === 'missing_file'
        ? 'missing_file' : 'artifact_read_unavailable' };
    }
    const bytes = observed.bytes;
    if (observed.artifactRef !== input.artifactRef ||
        observed.taskId !== task.taskId ||
        observed.resultId !== input.resultId ||
        observed.conversationId !== conversationId ||
        observed.submittedUserTurnId !== attempt.externalTurnId ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength > this.#maxBytes ||
        observed.sizeBytes !== bytes.byteLength ||
        !Number.isSafeInteger(observed.sizeBytes) ||
        !SHA256_HEX.test(observed.sha256) ||
        !MIME_TYPE.test(observed.mediaType) ||
        observed.mediaType.length > 128) {
      return { kind: 'unavailable', reason: 'artifact_provenance_unverified' };
    }
    // Copy before hashing and returning so the provider cannot mutate an
    // already verified buffer after handing it to the Core.
    const copy = Buffer.from(bytes);
    if (createHash('sha256').update(copy).digest('hex') !== observed.sha256) {
      return { kind: 'unavailable', reason: 'artifact_provenance_unverified' };
    }
    // External file reads may outlive a revoked project membership. Checking
    // authorization only before the await is not sufficient to release bytes.
    let current: ReturnType<TaskKernelRepository['getFullTask']>;
    try {
      current = this.#repository.getFullTask(input.taskId, input.clientId);
    } catch (error) {
      if ((error instanceof SessionPlaneDomainError &&
          error.errorCode === 'invalid_request' &&
          error.message === 'Project access denied') ||
          (error instanceof Error && error.message === 'Unknown task')) {
        return { kind: 'denied', reason: 'task_not_authorized' };
      }
      throw error;
    }
    if (current.task.projectId !== task.projectId ||
        current.task.slotId !== task.slotId ||
        current.task.slotRevision !== task.slotRevision ||
        !current.results.some(row =>
          row.resultId === result.resultId &&
          row.attemptId === result.attemptId &&
          row.externalTurnId === result.externalTurnId)) {
      return { kind: 'unavailable', reason: 'artifact_provenance_unverified' };
    }
    return {
      kind: 'verified', resultId: input.resultId,
      externalTurnId: attempt.externalTurnId,
      artifactRef: input.artifactRef, sha256: observed.sha256,
      sizeBytes: copy.byteLength, mediaType: observed.mediaType, bytes: copy,
    };
  }
}
