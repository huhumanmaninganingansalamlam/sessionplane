import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import type { PageMutationMutex } from '../browser/page-mutex.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { CurrentGenerationUpdate } from '../domain/generation.ts';
import { isTerminalSessionState, type SessionSnapshot } from '../domain/session.ts';
import {
  ProviderSubmissionError,
  type ProviderAdapterRegistry,
  type ProviderAttachment,
  type ProviderSubmission,
  type ProviderSubmissionAcknowledgement,
  type ProviderSubmissionAttempt,
  type PreparationChoices,
  type PreparationPurpose,
  type PreparationTarget,
} from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionActor } from '../scheduler/session-actor.ts';
import { KeyedMutex } from '../scheduler/keyed-mutex.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { EventRepository } from '../storage/event-repository.ts';
import {
  OutboxRepository,
  type OutboxRecord,
  type OutboxState,
} from '../storage/outbox-repository.ts';
import { ReceiptRepository, hashCanonical } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import { ConversationLoadRecoveryRepository } from '../storage/conversation-load-recovery-repository.ts';
import type { TeamDirectory } from './team-directory.ts';

export interface FailureContinuation {
  readonly rootRequestRef: string;
  readonly failedRequestRef: string;
  readonly attempt: number;
  readonly deadlineAt: string;
}

interface AuthorizedResend {
  readonly requestRef: string;
  readonly approvalRef: string;
}

export interface SessionSendInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly sessionId?: string;
  readonly teamId?: string;
  readonly roleKey?: string;
  readonly expectedGeneration?: number;
  readonly prompt: string;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly surface?: string | null;
  readonly files?: readonly string[];
  readonly sessionDeadlineSec: number;
  readonly thinkingFailureRecovery?: true;
  readonly failureContinuation?: FailureContinuation;
  readonly authorizedResend?: AuthorizedResend;
}

interface PendingPreparation {
  readonly kind: 'pending-preparation';
  readonly choices: PreparationChoices;
  readonly requiresInspection?: boolean;
  readonly message?: string;
}

interface StoredOutboxPayload {
  readonly prompt: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly surface: string | null;
  readonly sessionDeadlineSec: number;
  readonly attachments: readonly ProviderAttachment[];
  readonly uploadAttachments?: readonly ProviderAttachment[];
  readonly thinkingFailureRecovery?: true;
  readonly failureContinuation?: FailureContinuation;
  readonly authorizedResend?: AuthorizedResend;
}

interface PreparedOutbox {
  readonly outbox: OutboxRecord;
  readonly snapshot: SessionSnapshot;
  readonly eventSequence: number;
}

const PROVIDER_STAGE_TIMEOUT_MS = 120_000;

export class SubmissionService {
  readonly uploadsEnabled: boolean;
  readonly #database: SessionPlaneDatabase;
  readonly #directory: TeamDirectory;
  readonly #scheduler: ActorScheduler;
  readonly #pageMutex: PageMutationMutex;
  readonly #adapters: ProviderAdapterRegistry;
  readonly #sessions: SessionRepository;
  readonly #events: EventRepository;
  readonly #outbox: OutboxRepository;
  readonly #now: () => Date;
  readonly #onSubmitted: ((snapshot: SessionSnapshot) => void) | null;
  readonly #onSubmissionUnknown: ((snapshot: SessionSnapshot) => void) | null;
  readonly #maxUploadFileBytes: number;
  readonly #requestMutex = new KeyedMutex();
  readonly #beforeFailureContinuation: ((snapshot: SessionSnapshot, continuation: FailureContinuation) => Promise<void>) | null;
  readonly #beforeAuthorizedResend: ((current: SessionSnapshot, original: SessionSnapshot, prompt: string, allowPreparedDraft: boolean) => Promise<void>) | null;
  readonly #reserveResendPage: ((original: SessionSnapshot, successor: SessionSnapshot) => void) | null;

  constructor(options: {
    readonly database: SessionPlaneDatabase;
    readonly directory: TeamDirectory;
    readonly scheduler: ActorScheduler;
    readonly pageMutex: PageMutationMutex;
    readonly adapters: ProviderAdapterRegistry;
    readonly maxUploadFileBytes?: number;
    readonly uploadsEnabled?: boolean;
    readonly onSubmitted?: (snapshot: SessionSnapshot) => void;
    readonly onSubmissionUnknown?: (snapshot: SessionSnapshot) => void;
    readonly beforeFailureContinuation?: (snapshot: SessionSnapshot, continuation: FailureContinuation) => Promise<void>;
    readonly beforeAuthorizedResend?: (current: SessionSnapshot, original: SessionSnapshot, prompt: string, allowPreparedDraft: boolean) => Promise<void>;
    readonly reserveResendPage?: (original: SessionSnapshot, successor: SessionSnapshot) => void;
    readonly now?: () => Date;
  }) {
    this.#beforeFailureContinuation = options.beforeFailureContinuation ?? null;
    this.#beforeAuthorizedResend = options.beforeAuthorizedResend ?? null;
    this.#reserveResendPage = options.reserveResendPage ?? null;
    this.#database = options.database;
    this.#directory = options.directory;
    this.#scheduler = options.scheduler;
    this.#pageMutex = options.pageMutex;
    this.#adapters = options.adapters;
    this.#sessions = new SessionRepository(options.database.raw);
    this.#events = new EventRepository(options.database.raw);
    this.#outbox = new OutboxRepository(options.database);
    this.#onSubmitted = options.onSubmitted ?? null;
    this.#onSubmissionUnknown = options.onSubmissionUnknown ?? null;
    this.#maxUploadFileBytes = options.maxUploadFileBytes ?? 100 * 1024 * 1024;
    this.uploadsEnabled = options.uploadsEnabled ?? false;
    this.#now = options.now ?? (() => new Date());
  }

  async recoverInterruptedPreSubmissions(): Promise<number> {
    let recovered = 0;
    for (const interrupted of this.#outbox.listByStates(['prepared', 'composer_filled'])) {
      const snapshot = this.#sessions.getSnapshot(interrupted.sessionId);
      if (
        snapshot === null ||
        snapshot.generation !== interrupted.generation ||
        snapshot.terminal
      ) {
        continue;
      }
      const actor = this.#scheduler.actorFor(interrupted.sessionId);
      await actor.enqueue(() => {
        const current = this.#outbox.requireById(interrupted.outboxId);
        if (
          current.submissionState !== 'prepared' &&
          current.submissionState !== 'composer_filled'
        ) {
          return;
        }
        const currentSnapshot = this.#requireSnapshot(current.sessionId);
        if (
          current.submissionState === 'prepared' &&
          current.errorCode === 'provider.preparation-required' &&
          !current.promptSubmitted &&
          currentSnapshot.generation === current.generation &&
          currentSnapshot.sessionState === 'submitting' &&
          currentSnapshot.submissionState === 'prepared' &&
          !currentSnapshot.promptSubmitted
        ) {
          this.#outbox.transition(current.outboxId, ['prepared'], 'prepared', {
            updatedAt: this.#now().toISOString(),
            resultJson: JSON.stringify({ kind: 'pending-preparation', choices: {}, requiresInspection: true }),
            errorCode: 'provider.preparation-required',
            promptSubmitted: false,
          });
          recovered += 1;
          return;
        }
        if (current.promptSubmitted) {
          this.#recordSubmissionUnknown(
            actor,
            current,
            'restart-inconsistent-pre-submit-state',
          );
        } else {
          this.#recordInterruptedPreSubmit(actor, current);
        }
        recovered += 1;
      });
    }
    return recovered;
  }

  async reconcileOutboxDiagnostics(): Promise<number> {
    let reconciled = 0;
    for (const outbox of this.#outbox.listByStates([
      'failed_pre_submit',
      'submission_unknown',
    ])) {
      const snapshot = this.#sessions.getSnapshot(outbox.sessionId);
      if (
        snapshot === null ||
        snapshot.generation !== outbox.generation ||
        isTerminalSessionState(snapshot.sessionState) ||
        (snapshot.terminal && outbox.submissionState !== 'failed_pre_submit')
      ) {
        continue;
      }

      const stored = tryParseStoredSnapshot(outbox);
      let update: CurrentGenerationUpdate;
      if (outbox.submissionState === 'failed_pre_submit') {
        const errorCode = outbox.errorCode ?? stored?.errorCode ?? null;
        if (errorCode === null) {
          continue;
        }
        const reason = stored?.reason ?? 'pre-submit-failure';
        if (
          snapshot.sessionState === 'ready' &&
          snapshot.providerState === 'error' &&
          snapshot.observationTransport === 'unavailable' &&
          snapshot.submissionState === 'failed_pre_submit' &&
          snapshot.promptSubmitted === false &&
          snapshot.errorCode === errorCode &&
          snapshot.reason === reason
        ) {
          continue;
        }
        update = {
          sessionState: 'ready',
          providerState: 'error',
          observationTransport: 'unavailable',
          submissionState: 'failed_pre_submit',
          nextCheckAt: null,
          reason,
          errorCode,
          promptSubmitted: false,
        };
      } else {
        const errorCode =
          outbox.errorCode ?? stored?.errorCode ?? 'session.submission-unknown';
        const reason = stored?.reason ?? 'submit-unacknowledged';
        if (
          snapshot.sessionState === 'observing' &&
          snapshot.providerState === 'unknown' &&
          snapshot.submissionState === 'submission_unknown' &&
          snapshot.promptSubmitted &&
          snapshot.errorCode === errorCode &&
          snapshot.reason === reason
        ) {
          continue;
        }
        update = {
          sessionState: 'observing',
          providerState: 'unknown',
          observationTransport: stored?.observationTransport ?? 'unavailable',
          submissionState: 'submission_unknown',
          nextCheckAt: null,
          reason,
          errorCode,
          promptSubmitted: true,
        };
      }

      await this.#scheduler.updateGeneration(
        snapshot.sessionId,
        snapshot.generation,
        update,
        'generation.outbox-diagnostic-reconciled',
      );
      reconciled += 1;
    }
    return reconciled;
  }

  async recoverInterruptedSubmissions(): Promise<number> {
    let recovered = 0;
    for (const interrupted of this.#outbox.listByStates(['submit_attempted'])) {
      const actor = this.#scheduler.actorFor(interrupted.sessionId);
      await actor.enqueue(() => {
        const current = this.#outbox.requireById(interrupted.outboxId);
        if (current.submissionState !== 'submit_attempted') {
          return;
        }
        this.#recordSubmissionUnknown(actor, current, 'restart-after-submit-attempt');
        recovered += 1;
      });
    }
    return recovered;
  }

  async acknowledgeSubmission(input: { clientId: string; requestId: string; sessionId: string; generation: number; decisionId: string; messageId: string; evidenceHash: string }): Promise<SessionSnapshot> {
    return await this.#requestMutex.runExclusive(JSON.stringify([input.clientId, input.decisionId]), async () => {
      const receipts = new ReceiptRepository(this.#database);
      const method = 'session.submission.acknowledge';
      const requestHash = hashCanonical({ method, input });
      const prior = receipts.get(input.clientId, input.decisionId);
      if (prior !== null && (prior.method !== method || prior.requestHash !== requestHash)) {
        throw new SessionPlaneDomainError('input.idempotency-conflict', 'Decision identity was reused with different arguments');
      }
      const outbox = this.#outbox.getByRequest(input.clientId, input.requestId);
      const snapshot = this.#requireSnapshot(input.sessionId);
      if (outbox === null || outbox.sessionId !== input.sessionId || outbox.generation !== input.generation || snapshot.generation !== input.generation) {
        throw new SessionPlaneDomainError('session.generation-superseded', 'Acknowledgement requires the current caller-owned request');
      }
      if (snapshot.provider !== 'chatgpt') throw new SessionPlaneDomainError('capability.unsupported', 'Observed message selection currently supports ChatGPT only');
      const recovered = await this.recoverAcknowledgement(snapshot, { messageId: input.messageId, evidenceHash: input.evidenceHash });
      if (recovered.generation !== input.generation || recovered.submittedUserMessageId !== input.messageId) {
        throw new SessionPlaneDomainError('browser.snapshot-stale', 'Selected submission evidence is unavailable or no longer current; inspect the same request');
      }
      receipts.record({ clientId: input.clientId, requestId: input.decisionId, method, requestHash, status: 'complete', result: recovered });
      return recovered;
    });
  }

  async recoverAcknowledgement(snapshot: SessionSnapshot, selection?: { readonly messageId: string; readonly evidenceHash: string }): Promise<SessionSnapshot> {
    if (
      snapshot.terminal ||
      snapshot.submissionState !== 'submission_unknown' ||
      !snapshot.promptSubmitted ||
      snapshot.pageKey === null ||
      snapshot.conversationId === null ||
      !this.#adapters.has(snapshot.provider)
    ) {
      return snapshot;
    }
    const outbox = this.#outbox.getByGeneration(snapshot.sessionId, snapshot.generation);
    if (outbox === null || outbox.submissionState !== 'submission_unknown') {
      return snapshot;
    }
    const prompt = promptFromOutbox(outbox);
    if (prompt === null) return snapshot;
    const adapter = this.#adapters.require(snapshot.provider);
    if (adapter.recoverAcknowledgement === undefined) return snapshot;

    const actor = this.#scheduler.actorFor(snapshot.sessionId);
    return await actor.enqueue(async () => {
      const current = this.#requireSnapshot(snapshot.sessionId);
      const currentConversationId = current.conversationId;
      if (
        current.generation !== snapshot.generation || current.terminal ||
        current.submissionState !== 'submission_unknown' ||
        !current.promptSubmitted ||
        current.pageKey === null ||
        currentConversationId === null
      ) {
        return current;
      }
      const currentOutbox = this.#outbox.getByGeneration(current.sessionId, current.generation);
      if (currentOutbox === null || currentOutbox.submissionState !== 'submission_unknown') {
        return current;
      }
      const currentPrompt = promptFromOutbox(currentOutbox);
      if (currentPrompt === null) return current;

      return await this.#pageMutex.runExclusive(current.pageKey, async () => {
        if (selection !== undefined && this.#sessions.submittedMessageIds(current.sessionId).has(selection.messageId)) {
          throw new SessionPlaneDomainError('input.invalid', 'Selected message already belongs to another generation');
        }
        if (this.accountCooldown(current)) return current;
        const attempts = this.#events.submissionAttempts(current.sessionId, current.generation)
          .filter(e => e.requestRef === currentOutbox.outboxId && e.conversationId === currentConversationId &&
            e.promptHash === createHash('sha256').update(currentPrompt).digest('hex'))
          .map(e => e.attempt as ProviderSubmissionAttempt);
        const acknowledgement = await adapter.recoverAcknowledgement?.({
          session: current,
          generation: current.generation,
          prompt: currentPrompt,
          attempts,
          ...(selection === undefined ? {} : { selection }),
        });
        if (
          acknowledgement === undefined ||
          acknowledgement === null ||
          this.#sessions.submittedMessageIds(current.sessionId).has(acknowledgement.submittedUserMessageId) ||
          (selection !== undefined && acknowledgement.submittedUserMessageId !== selection.messageId) ||
          (acknowledgement.conversationId !== currentConversationId &&
            !(current.provider === 'chatgpt' &&
              currentConversationId.startsWith('WEB:') &&
              !acknowledgement.conversationId.startsWith('WEB:')))
        ) {
          return current;
        }

        let recovered!: SessionSnapshot;
        let eventSequence = 0;
        this.#database.transaction(() => {
          const timestamp = this.#now().toISOString();
          const updated = this.#sessions.updateCurrentGeneration(
            current.sessionId,
            current.generation,
            {
              sessionState: 'submitted',
              providerState: 'generating',
              observationTransport: 'fresh',
              submissionState: 'submitted',
              conversationId: acknowledgement.conversationId,
              pageKey: current.pageKey,
              submittedUserMessageId: acknowledgement.submittedUserMessageId,
              submittedUserTurnId: acknowledgement.submittedUserTurnId,
              promptSubmitted: true,
              reason: 'acknowledgement-recovered',
              errorCode: null,
            },
            timestamp,
          );
          if (!updated) {
            throw new SessionPlaneDomainError(
              'session.generation-superseded',
              'Generation changed during acknowledgement recovery',
            );
          }
          recovered = this.#requireSnapshot(current.sessionId);
          if (
            !this.#outbox.transition(
              currentOutbox.outboxId,
              ['submission_unknown'],
              'submitted',
              {
                updatedAt: timestamp,
                resultJson: JSON.stringify(recovered),
                errorCode: null,
                promptSubmitted: true,
              },
            )
          ) {
            throw new SessionPlaneDomainError(
              'internal.invariant-violation',
              'Ambiguous outbox could not be promoted after acknowledgement recovery',
            );
          }
          eventSequence = this.#events.append({
            teamId: currentOutbox.teamId,
            roleId: currentOutbox.roleId,
            sessionId: current.sessionId,
            generation: current.generation,
            eventType: 'generation.acknowledgement-recovered',
            payload: {
              hasConversationId: true,
              hasSubmittedUserMessageId: true,
              hasSubmittedUserTurnId: true,
              acknowledgementEvidence: acknowledgement.evidence ?? 'provider-adapter',
              conversationId: acknowledgement.conversationId,
              submittedUserMessageId: acknowledgement.submittedUserMessageId,
              submittedUserTurnId: acknowledgement.submittedUserTurnId,
              promptSubmitted: true,
            },
            createdAt: timestamp,
          });
        });
        actor.publish(recovered, eventSequence);
        this.#onSubmitted?.(recovered);
        return recovered;
      });
    });
  }

  async send(input: SessionSendInput): Promise<SessionSnapshot> {
    if (input.files?.length) this.#requireUploadsEnabled();
    const prompt = validatePrompt(input.prompt);
    const model = normalizeOptional(input.model);
    const effort = normalizeOptional(input.effort);
    const surface = normalizeOptional(input.surface);
    if (surface?.toLowerCase() === 'work') {
      throw new SessionPlaneDomainError(
        'capability.unsupported',
        'SessionPlane supports the Chat surface only; ChatGPT Work is not supported',
      );
    }
    const attachments = await resolveProviderAttachments(
      input.files ?? [],
      this.#maxUploadFileBytes,
    );
    const payload = {
      selector:
        input.sessionId === undefined
          ? { teamId: input.teamId, roleKey: input.roleKey }
          : { sessionId: input.sessionId },
      prompt,
      model,
      effort,
      surface,
      attachments,
      sessionDeadlineSec: input.sessionDeadlineSec,
      ...(input.thinkingFailureRecovery === true ? { thinkingFailureRecovery: true } : {}),
      ...(input.failureContinuation === undefined ? {} : { failureContinuation: input.failureContinuation }),
    };
    const requestHash = hashCanonical({ method: 'session.send', payload });
    const requestKey = JSON.stringify([input.clientId, input.requestId]);
    return await this.#requestMutex.runExclusive(requestKey, async () => {
      const existing = this.#outbox.getByRequest(input.clientId, input.requestId);
      if (existing !== null) {
        if (existing.requestHash !== requestHash) {
          throw new SessionPlaneDomainError(
            'input.idempotency-conflict',
            `Request ${input.clientId}/${input.requestId} was already used with different input`,
          );
        }
        const actor = this.#scheduler.actorFor(existing.sessionId);
        return await actor.enqueue(async () => await this.#replay(
          actor,
          this.#outbox.requireById(existing.outboxId),
        ));
      }

      const selected = this.#resolveSession(input);
      if (!this.#adapters.has(selected.provider)) {
        throw new SessionPlaneDomainError(
          'provider.disabled',
          'Provider is disabled by runtime configuration: ' + selected.provider,
        );
      }
      if (input.thinkingFailureRecovery === true && selected.provider !== 'chatgpt') throw new SessionPlaneDomainError(
        'capability.unsupported', 'Thinking-failed continuation is ChatGPT-only');
      const actor = this.#scheduler.actorFor(selected.sessionId);
      return await actor.enqueue(async () =>
        await this.#sendLocked(
          actor,
          selected.sessionId,
          input,
          payload,
          requestHash,
          attachments,
        ),
      );
    });
  }

  async #sendLocked(
    actor: SessionActor,
    sessionId: string,
    input: SessionSendInput,
    payload: Readonly<Record<string, unknown>>,
    requestHash: string,
    attachments: readonly ProviderAttachment[],
  ): Promise<SessionSnapshot> {
    const existing = this.#outbox.getByRequest(input.clientId, input.requestId);
    if (existing !== null) {
      if (existing.requestHash !== requestHash || existing.sessionId !== sessionId) {
        throw new SessionPlaneDomainError(
          'input.idempotency-conflict',
          `Request ${input.clientId}/${input.requestId} was already used with different input`,
        );
      }
      return await this.#replay(actor, existing);
    }

    if (input.expectedGeneration !== undefined &&
        this.#requireSnapshot(sessionId).generation !== input.expectedGeneration) {
      throw new SessionPlaneDomainError('session.generation-superseded', 'Role reference is stale; refresh the team before sending');
    }
    const uploadAttachments = await this.#snapshotAttachments(attachments);
    const prepared = this.#prepareOutbox(
      actor,
      sessionId,
      input,
      { ...payload, uploadAttachments },
      requestHash,
    );
    return await this.#runPreparedSubmission(actor, prepared, input, uploadAttachments);
  }

  async #snapshotAttachments(attachments: readonly ProviderAttachment[]): Promise<readonly ProviderAttachment[]> {
    const uploads: ProviderAttachment[] = [];
    for (const attachment of attachments) {
      const directory = path.join(path.dirname(this.#database.path), 'submission-inputs', hashCanonical(attachment));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = path.join(directory, attachment.name);
      const temporary = path.join(directory, randomUUID());
      try {
        await copyFile(attachment.path, temporary);
        await chmod(temporary, 0o600);
        if (statSync(temporary).size !== attachment.sizeBytes || await hashFile(temporary) !== attachment.sha256) {
          throw new SessionPlaneDomainError('input.idempotency-conflict', 'An attachment changed while the request was being accepted');
        }
        await rename(temporary, destination);
        uploads.push({ ...attachment, path: destination });
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return uploads;
  }

  #requireUploadsEnabled(): void {
    if (!this.uploadsEnabled) {
      throw new SessionPlaneDomainError('capability.unsupported',
        'Attachment uploads are disabled. Downloads remain available. The operator can enable uploads with SESSIONPLANE_UPLOADS_ENABLED=true.');
    }
  }

  async #runPreparedSubmission(
    actor: SessionActor,
    prepared: PreparedOutbox,
    input: SessionSendInput,
    attachments: readonly ProviderAttachment[],
    choices?: PreparationChoices,
  ): Promise<SessionSnapshot> {
    let submission: ProviderSubmission;
    try {
      this.#requireAccountReady(prepared.snapshot);
      await this.#verifyAuthorizedResend(prepared.snapshot, input.authorizedResend, false);
      if (attachments.length > 0) this.#requireUploadsEnabled();
      const adapter = this.#adapters.require(prepared.snapshot.provider);
      submission = await adapter.openSubmission({
        session: prepared.snapshot,
        generation: prepared.snapshot.generation,
        prompt: input.prompt,
        model: normalizeOptional(input.model),
        effort: normalizeOptional(input.effort),
        surface: normalizeOptional(input.surface),
        attachments,
        onSubmissionAttempt: attempt => {
          const current = this.#outbox.requireById(prepared.outbox.outboxId);
          const snapshot = this.#requireSnapshot(current.sessionId);
          if (current.submissionState !== 'submit_attempted' || snapshot.generation !== current.generation ||
              snapshot.pageKey !== submission.pageKey || snapshot.conversationId !== attempt.conversationId) return;
          const prior = this.#events.submissionAttempts(current.sessionId, current.generation);
          if (prior.some(e => e.requestRef === current.outboxId && hashCanonical(e.attempt) === hashCanonical(attempt))) return;
          this.#events.append({ teamId: current.teamId, roleId: current.roleId, sessionId: current.sessionId,
            generation: current.generation, eventType: 'generation.submission-attempt-evidence',
            payload: { requestRef: current.outboxId, conversationId: attempt.conversationId,
              promptHash: createHash('sha256').update(input.prompt).digest('hex'), attempt },
            createdAt: attempt.observedAt });
        },
      });
    } catch (error) {
      if (error instanceof SessionPlaneDomainError && error.errorCode === 'provider.preparation-required') {
        return await this.#recordPreparationRequired(actor, prepared.outbox, error);
      }
      return await this.#failPreSubmit(actor, prepared.outbox, error);
    }

    this.#persistPageKey(actor, prepared.outbox, submission.pageKey);
    return await this.#pageMutex.runExclusive(submission.pageKey, async retainUntil => {
      const stageTimeoutMs = Math.min(PROVIDER_STAGE_TIMEOUT_MS, input.sessionDeadlineSec * 1_000);
      const verifyContinuation = async () => {
        if (input.failureContinuation === undefined) return;
        if (this.#beforeFailureContinuation === null) throw new ProviderSubmissionError(
          'provider.preparation-required', 'Automatic continuation validation is unavailable; preserve this prepared request');
        await this.#beforeFailureContinuation(this.#requireSnapshot(prepared.outbox.sessionId), input.failureContinuation);
      };
      try {
        await verifyContinuation();
        await this.#verifyAuthorizedResend(this.#requireSnapshot(prepared.outbox.sessionId), input.authorizedResend, false);
        this.#requireAccountReady(this.#requireSnapshot(prepared.outbox.sessionId));
        const preparation = submission.prepare(choices);
        await withProviderStageTimeout(
          preparation,
          stageTimeoutMs,
          () => {
            retainUntil(preparation);
            submission.abandon();
            throw new ProviderSubmissionError('browser.unavailable',
              `Provider browser operation timed out during ${submission.preparationStage ?? 'prepare'}`,
              { details: { preparationStage: submission.preparationStage ?? 'prepare' } });
          },
        );
        this.#requireActiveRoleSession(this.#requireSnapshot(prepared.outbox.sessionId));
        await verifyContinuation();
        await this.#verifyAuthorizedResend(this.#requireSnapshot(prepared.outbox.sessionId), input.authorizedResend, true);
        this.#requireAccountReady(this.#requireSnapshot(prepared.outbox.sessionId));
        if (input.thinkingFailureRecovery === true) {
          const model = choices?.model ?? choices?.effort;
          if (model === undefined) throw new ProviderSubmissionError(
            'provider.preparation-required', 'Opt-in recovery requires a freshly selected combined configuration');
          new ReceiptRepository(this.#database).execute({ clientId: input.clientId,
            requestId: `thinking-failure-configuration:${prepared.outbox.outboxId}`,
            method: 'session.thinking-failure.configuration', payload: { model }, operation: () => ({ model }) });
        }
      } catch (error) {
        try { this.#requireActiveRoleSession(this.#requireSnapshot(prepared.outbox.sessionId)); }
        catch (retired) { submission.abandon(); error = retired; }
        if ((error instanceof ProviderSubmissionError || error instanceof SessionPlaneDomainError) && error.errorCode === 'provider.preparation-required') {
          return await this.#recordPreparationRequired(actor, prepared.outbox, error);
        }
        return await this.#failPreSubmit(actor, prepared.outbox, error);
      }

      this.#transition(
        actor,
        prepared.outbox,
        ['prepared'],
        'composer_filled',
        {
          submissionState: 'composer_filled',
          pageKey: submission.pageKey,
          providerState: 'pending',
          observationTransport: 'fresh',
        },
        'generation.composer-filled',
        { promptSubmitted: false, errorCode: null, resultJson: null },
      );
      this.#transition(
        actor,
        prepared.outbox,
        ['composer_filled'],
        'submit_attempted',
        {
          submissionState: 'submit_attempted',
          sessionState: 'submitting',
          providerState: 'pending',
          observationTransport: 'fresh',
          pageKey: submission.pageKey,
          promptSubmitted: true,
          reason: null,
          errorCode: null,
        },
        'generation.submit-attempted',
        // Compatibility: promptSubmitted marks a possible irreversible attempt,
        // not acceptance. Only submissionState="submitted" confirms identity.
        { promptSubmitted: true },
      );

      let submitError: unknown = null;
      try {
        await withProviderStageTimeout(submission.submitOnce(), stageTimeoutMs);
      } catch (error) {
        submitError = error;
      }

      let acknowledgement: ProviderSubmissionAcknowledgement | null = null;
      try {
        acknowledgement = await withProviderStageTimeout(
          submission.captureAcknowledgement(),
          stageTimeoutMs,
        );
      } catch (error) {
        submitError ??= error;
      }

      if (acknowledgement !== null) {
        try {
          submission.bindAcknowledgement(acknowledgement);
          return this.#completeSubmitted(actor, prepared.outbox, submission, acknowledgement);
        } catch (error) {
          submitError ??= error;
        }
      }

      return await this.#markSubmissionUnknown(
        actor,
        prepared.outbox,
        submitError === null ? 'acknowledgement-missing' : 'submit-unacknowledged',
      );
    });
  }

  async resumePreparation(input: {
    readonly clientId: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly generation: number;
  }): Promise<SessionSnapshot> {
    const requestKey = JSON.stringify([input.clientId, input.requestId]);
    return await this.#requestMutex.runExclusive(requestKey, async () => {
      const initial = this.#outbox.getByRequest(input.clientId, input.requestId);
      if (initial === null || initial.sessionId !== input.sessionId || initial.generation !== input.generation) {
        throw new SessionPlaneDomainError(
          'provider.preparation-required',
          'No matching caller-owned preparation request is pending',
        );
      }
      if (initial.submissionState !== 'prepared' || initial.errorCode !== 'provider.preparation-required' || initial.promptSubmitted) {
        if (['submitted', 'failed_pre_submit', 'submission_unknown', 'submit_attempted'].includes(initial.submissionState)) {
          const actor = this.#scheduler.actorFor(input.sessionId);
          return await actor.enqueue(async () => await this.#replay(actor, this.#outbox.requireById(initial.outboxId)));
        }
        throw new SessionPlaneDomainError('provider.preparation-required', 'The exact request is not awaiting an assisted preparation choice');
      }
      const actor = this.#scheduler.actorFor(initial.sessionId);
      return await actor.enqueue(async () =>
        await this.#resumePreparationLocked(actor, input),
      );
    });
  }

  async #resumePreparationLocked(
    actor: SessionActor,
    input: { readonly clientId: string; readonly requestId: string; readonly sessionId: string; readonly generation: number },
  ): Promise<SessionSnapshot> {
    const outbox = this.#outbox.getByRequest(input.clientId, input.requestId);
    const snapshot = this.#requireSnapshot(input.sessionId);
    if (
      outbox === null || outbox.sessionId !== input.sessionId || outbox.generation !== input.generation ||
      outbox.submissionState !== 'prepared' || outbox.errorCode !== 'provider.preparation-required' ||
      snapshot.generation !== input.generation || snapshot.promptSubmitted ||
      snapshot.sessionState !== 'submitting'
    ) {
      throw new SessionPlaneDomainError('session.generation-superseded', 'Exact pending preparation is no longer current');
    }
    const payload = parseOutboxPayload(outbox);
    const state = parsePreparationState(outbox);
    if (state.requiresInspection === true) {
      throw new SessionPlaneDomainError('provider.preparation-required', 'Inspect current provider state before resuming after restart');
    }
    let attachments: readonly ProviderAttachment[];
    try {
      const expected = payload.uploadAttachments ?? payload.attachments;
      if (expected.length > 0) this.#requireUploadsEnabled();
      attachments = await resolveProviderAttachments(
        expected.map((attachment) => attachment.path),
        this.#maxUploadFileBytes,
      );
      if (hashCanonical(attachments) !== hashCanonical(expected)) {
        throw new SessionPlaneDomainError('input.idempotency-conflict', 'An attachment changed while preparation was pending');
      }
    } catch (error) {
      return await this.#failPreSubmit(actor, outbox, error);
    }
    const sendInput = sessionSendInputFromOutbox(outbox, payload);
    return await this.#runPreparedSubmission(
      actor,
      { outbox, snapshot, eventSequence: 0 },
      sendInput,
      attachments,
      state.choices,
    );
  }

  async inspectSubmission<Result>(
    input: { readonly clientId: string; readonly requestId: string; readonly sessionId: string; readonly generation: number },
    observe: (snapshot: SessionSnapshot, submittedMessageIds: ReadonlySet<string>) => Promise<Result>,
  ) {
    const actor = this.#scheduler.actorFor(input.sessionId);
    const requireOwner = () => {
      const outbox = this.#outbox.getByRequest(input.clientId, input.requestId);
      const snapshot = this.#requireSnapshot(input.sessionId);
      if (outbox === null || outbox.sessionId !== input.sessionId ||
          outbox.generation !== input.generation || snapshot.generation !== input.generation) {
        throw new SessionPlaneDomainError('session.generation-superseded', 'Exact caller-owned submission is no longer current');
      }
      this.#adapters.require(snapshot.provider);
      if (snapshot.provider !== 'chatgpt') {
        throw new SessionPlaneDomainError('capability.unsupported', 'Submission page inspection currently supports ChatGPT only');
      }
      return { outbox, snapshot };
    };
    const initial = await actor.enqueue(requireOwner);
    if (!initial.snapshot.terminal) await this.recoverAcknowledgement(initial.snapshot);
    return await this.#scheduler.actorFor(input.sessionId).enqueue(async () => {
      const { outbox, snapshot } = requireOwner();
      const requested = parseOutboxPayload(outbox);
      const result = {
        requestId: outbox.requestId,
        snapshot,
        requested: {
          prompt: requested.prompt, model: requested.model, effort: requested.effort,
          surface: requested.surface, attachments: requested.attachments,
          sessionDeadlineSec: requested.sessionDeadlineSec,
        },
      };
      if (snapshot.pageKey === null) return { ...result, evidence: null };
      return await this.#pageMutex.runExclusive(snapshot.pageKey, async () => ({
        ...result, evidence: await observe(snapshot, this.#sessions.submittedMessageIds(snapshot.sessionId)),
      }));
    });
  }

  async prepareAuthorizedResend(input: {
    clientId: string; requestId: string; sessionId: string; generation: number;
    decisionId: string; approvalRef: string; duplicateRiskAccepted: true;
  }) {
    if (input.duplicateRiskAccepted !== true || input.approvalRef.trim() === '') throw new SessionPlaneDomainError(
      'input.invalid', 'A specific user approval after duplicate-risk disclosure is required');
    const original = this.#outbox.getByRequest(input.clientId, input.requestId);
    if (original === null || original.sessionId !== input.sessionId || original.generation !== input.generation) {
      throw new SessionPlaneDomainError('input.invalid', 'Resend requires the original caller-owned request');
    }
    return await this.#scheduler.actorFor(input.sessionId).enqueue(async () => {
      const receipts = new ReceiptRepository(this.#database);
      const method = 'session.resend.prepare';
      // One durable reservation per original request, across IDs and restarts.
      const receiptId = `authorized-resend:${original.outboxId}`;
      const requestHash = hashCanonical({ method, payload: input });
      const previous = receipts.get(input.clientId, receiptId);
      if (previous !== null) {
        if (previous.method !== method || previous.requestHash !== requestHash) throw new SessionPlaneDomainError(
          'input.idempotency-conflict', 'This original request already has its one authorized resend reservation');
        const result = JSON.parse(previous.resultJson) as Record<string, unknown>;
        const successor = typeof result.requestRef === 'string' ? this.#outbox.getById(result.requestRef) : null;
        // The same owner/approval may reopen a proven pre-submit failure, never
        // an attempted/unknown send. No new request, generation or approval.
        if (successor?.submissionState === 'failed_pre_submit' && !successor.promptSubmitted) {
          const current = this.#requireSnapshot(input.sessionId);
          if (successor.clientId !== input.clientId || successor.sessionId !== input.sessionId ||
              current.generation !== successor.generation || current.promptSubmitted || current.pageKey === null ||
              current.sessionState !== 'ready' || current.submissionState !== 'failed_pre_submit' ||
              current.submittedUserMessageId !== null || current.submittedUserTurnId !== null ||
              current.responseMessageId !== null || current.answerText !== null) throw new SessionPlaneDomainError(
            'session.generation-superseded', 'The approved pre-submit request is no longer current');
          const authorization = parseOutboxPayload(successor).authorizedResend;
          if (authorization?.requestRef !== original.outboxId || authorization.approvalRef !== input.approvalRef) throw new SessionPlaneDomainError(
            'input.invalid', 'Pre-submit recovery must retain the exact original approval');
          await this.#pageMutex.runExclusive(current.pageKey, async () => {
            await this.#verifyAuthorizedResend({ ...current, terminal: false }, authorization, false);
            let sequence = 0;
            this.#database.transaction(() => {
              const timestamp = this.#now().toISOString();
              if (!this.#sessions.updateCurrentGeneration(current.sessionId, current.generation, {
                sessionState: 'submitting', providerState: 'unknown', observationTransport: 'unavailable',
                submissionState: 'prepared', reason: 'authorized-resend-prepared',
                errorCode: 'provider.preparation-required', nextCheckAt: null, promptSubmitted: false,
              }, timestamp) || !this.#outbox.transition(successor.outboxId, ['failed_pre_submit'], 'prepared', {
                updatedAt: timestamp, resultJson: JSON.stringify({ kind: 'pending-preparation', choices: {}, requiresInspection: true }),
                errorCode: 'provider.preparation-required', promptSubmitted: false,
              })) throw new SessionPlaneDomainError('session.generation-superseded', 'Approved preparation ownership changed');
              sequence = this.#events.append({ teamId: successor.teamId, roleId: successor.roleId,
                sessionId: successor.sessionId, generation: successor.generation, eventType: 'generation.preparation-required',
                payload: { originalRequestRef: original.outboxId, approvalRef: input.approvalRef,
                  reason: 'authorized-resend-pre-submit-reopened', promptSubmitted: false, originalDisposition: 'unresolved-preserved',
                  priorFailure: { reason: current.reason, errorCode: successor.errorCode, recordedAt: successor.updatedAt,
                    resultHash: hashCanonical(JSON.parse(successor.resultJson ?? 'null')) } },
                createdAt: timestamp });
            });
            this.#scheduler.actorFor(input.sessionId).publishResumedPreparation(this.#requireSnapshot(input.sessionId), sequence);
          });
        }
        return result;
      }
      if (this.#outbox.getByRequest(input.clientId, input.decisionId) !== null ||
          receipts.get(input.clientId, input.decisionId) !== null) throw new SessionPlaneDomainError(
        'input.idempotency-conflict', 'Resend request ID already belongs to another submission');
      const current = this.#requireSnapshot(input.sessionId);
      if (current.generation !== original.generation || current.pageKey === null) throw new SessionPlaneDomainError(
        'session.generation-superseded', 'Resend requires the exact current original request page');
      const authorization = { requestRef: original.outboxId, approvalRef: input.approvalRef };
      return await this.#pageMutex.runExclusive(current.pageKey, async () => {
        await this.#verifyAuthorizedResend(current, authorization, false);
        const source = parseOutboxPayload(original);
        if (this.#reserveResendPage === null) throw new SessionPlaneDomainError(
          'capability.unsupported', 'Exact same-page resend reservation is unavailable');
        if (source.attachments.length !== 0) throw new SessionPlaneDomainError(
          'capability.unsupported', 'This narrow resend path does not replay attachment uploads');
        const payload = { prompt: source.prompt, model: source.model, effort: source.effort,
          surface: source.surface, attachments: [], sessionDeadlineSec: source.sessionDeadlineSec,
          authorizedResend: authorization };
        const sendInput: SessionSendInput = { clientId: input.clientId, requestId: input.decisionId,
          sessionId: input.sessionId, prompt: source.prompt, sessionDeadlineSec: source.sessionDeadlineSec };
        const result = receipts.execute({ clientId: input.clientId, requestId: receiptId, method, payload: input,
          operation: () => {
            const prepared = this.#prepareOutbox(this.#scheduler.actorFor(input.sessionId), input.sessionId,
              sendInput, payload, hashCanonical({ method: 'session.resend.send', payload }), original);
            this.#reserveResendPage!(current, prepared.snapshot);
            const timestamp = this.#now().toISOString();
            this.#sessions.updateCurrentGeneration(input.sessionId, prepared.snapshot.generation,
              { reason: 'authorized-resend-prepared', errorCode: 'provider.preparation-required' }, timestamp);
            this.#outbox.transition(prepared.outbox.outboxId, ['prepared'], 'prepared', {
              updatedAt: timestamp, errorCode: 'provider.preparation-required',
              resultJson: JSON.stringify({ kind: 'pending-preparation', choices: {} }), promptSubmitted: false });
            this.#events.append({ teamId: original.teamId, roleId: original.roleId, sessionId: original.sessionId,
              generation: original.generation, eventType: 'generation.resend-authorized',
              payload: { originalRequestRef: original.outboxId, successorRequestRef: prepared.outbox.outboxId,
                successorGeneration: prepared.snapshot.generation, receiptId, approvalRef: input.approvalRef,
                duplicateRiskAccepted: true, originalDisposition: 'unresolved-preserved', providerMutation: false },
              createdAt: timestamp });
            const result = { requestOk: true, requestRef: prepared.outbox.outboxId, originalRequestRef: original.outboxId,
              sessionId: input.sessionId, generation: prepared.snapshot.generation, receiptId,
              approvalRef: input.approvalRef, status: 'needs_decision', submissionState: 'prepared',
              originalDisposition: 'unresolved-preserved', providerMutation: false };
            receipts.record({ clientId: input.clientId, requestId: input.decisionId, method, requestHash, status: 'complete', result });
            return result;
          } });
        this.#scheduler.refreshSession(input.sessionId);
        return result;
      });
    });
  }

  async #verifyAuthorizedResend(current: SessionSnapshot, authorization: AuthorizedResend | undefined, allowPreparedDraft: boolean) {
    if (authorization === undefined) return;
    const receipts = new ReceiptRepository(this.#database);
    const stopId = `authorized-resend-stopped:${authorization.requestRef}`;
    if (receipts.get(`team:${current.teamId}`, stopId) !== null) throw new SessionPlaneDomainError(
      'provider.preparation-required', 'This approved resend was stopped after original progress/answer discovery; preserve and collect the original request');
    const source = this.#outbox.getById(authorization.requestRef);
    const original = source === null ? null : this.#sessions.getGenerationResult(source.sessionId, source.generation);
    const proof = source === null ? null : this.#events.latestAnchorRecovery(source.sessionId, source.generation);
    if (source === null || original === null || source.sessionId !== current.sessionId || source.teamId !== current.teamId ||
        current.provider !== 'chatgpt' || current.terminal ||
        ![source.generation, source.generation + 1].includes(current.generation) ||
        original.submissionState !== 'submitted' || !original.promptSubmitted || original.completedAt !== null ||
        original.responseMessageId !== null || original.answerText !== null ||
        (original.submittedUserMessageId === null && original.submittedUserTurnId === null)) throw new SessionPlaneDomainError(
      'provider.preparation-required', 'Approved resend requires the exact unresolved original request');
    const identity = proof?.recoveryIdentity as Record<string, unknown> | undefined;
    if (proof && (!identity || identity.conversationId !== current.conversationId ||
        identity.submittedUserMessageId !== original.submittedUserMessageId ||
        identity.submittedUserTurnId !== original.submittedUserTurnId)) throw new SessionPlaneDomainError(
      'session.page-identity-unverified', 'Missing-anchor evidence belongs to another request or conversation');
    if (proof && proof.recoveryReason !== 'backend-user-anchor-absent-from-mapping') throw new SessionPlaneDomainError(
      'provider.preparation-required', 'Original anchor or answer was found; preserve and collect it before any resend');
    if (current.generation === source.generation + 1) {
      const approval = receipts.get(source.clientId, `authorized-resend:${source.outboxId}`);
      const reserved = approval?.method === 'session.resend.prepare' ? JSON.parse(approval.resultJson) as Record<string, unknown> : null;
      const successor = typeof reserved?.requestRef === 'string' ? this.#outbox.getById(reserved.requestRef) : null;
      if (!reserved || reserved.originalRequestRef !== source.outboxId || reserved.approvalRef !== authorization.approvalRef ||
          successor?.clientId !== source.clientId || successor.sessionId !== current.sessionId || successor.generation !== current.generation) {
        throw new SessionPlaneDomainError('input.invalid', 'Exact durable duplicate-risk approval does not own this successor');
      }
    }
    this.#requireActiveRoleSession(current);
    this.#requireAccountReady(current);
    if (this.#beforeAuthorizedResend === null) throw new SessionPlaneDomainError(
      'provider.preparation-required', 'Approved resend display validation is unavailable');
    const originalSnapshot = { ...current, ...original, generation: source.generation, terminal: false };
    try {
      await withProviderStageTimeout(
        this.#beforeAuthorizedResend(current, originalSnapshot, parseOutboxPayload(source).prompt, allowPreparedDraft), 5_000);
    } catch (error) {
      const detail = error instanceof SessionPlaneDomainError ? preSubmitDetails(error.details) : {};
      if (detail.originalAnchorFound === true || detail.matchingPromptFound === true ||
          typeof detail.responseMessageId === 'string' || detail.activity === 'strong') {
        receipts.execute({ clientId: `team:${current.teamId}`, requestId: stopId,
          method: 'session.resend.dispatch-stopped', payload: { originalRequestRef: source.outboxId },
          operation: () => ({ originalRequestRef: source.outboxId, stoppedAt: this.#now().toISOString(), evidence: detail }) });
      }
      throw error;
    }
  }

  async reconcileFollowup(
    input: { readonly clientId: string; readonly requestId: string; readonly sessionId: string; readonly generation: number;
      readonly decisionId: string; readonly followupUserMessageId: string; readonly responseMessageId: string;
      readonly responseSha256: string; readonly followupCompleted: true },
    observe: (snapshot: SessionSnapshot) => Promise<{ readonly pageKey: string; readonly conversationId: string;
      readonly bindingEpoch: number; readonly observedAt: string }>,
  ) {
    const method = 'session.manual-followup.reconcile';
    const { clientId, decisionId, ...payload } = input;
    const receipts = new ReceiptRepository(this.#database);
    return await this.#scheduler.actorFor(input.sessionId).enqueue(async () => {
      if (receipts.get(clientId, decisionId) !== null) return receipts.execute({ clientId, requestId: decisionId,
        method, payload, operation: () => { throw new Error('Existing receipt must replay'); } });
      const outbox = this.#outbox.getByRequest(clientId, input.requestId);
      const snapshot = this.#requireSnapshot(input.sessionId);
      if (!outbox || outbox.sessionId !== input.sessionId || outbox.generation !== input.generation ||
          snapshot.generation !== input.generation) throw new SessionPlaneDomainError(
        'session.generation-superseded', 'Follow-up reconciliation requires the exact current request');
      this.#requireActiveRoleSession(snapshot);
      if (input.followupCompleted !== true || snapshot.provider !== 'chatgpt' || snapshot.terminal ||
          snapshot.submissionState !== 'submitted' || !snapshot.promptSubmitted || !snapshot.submittedUserMessageId ||
          !snapshot.pageKey || !snapshot.conversationId || snapshot.responseMessageId !== null || snapshot.answerText !== null) {
        throw new SessionPlaneDomainError('provider.failure-unverified', 'Requires an unresolved acknowledged request and explicitly confirmed manual follow-up');
      }
      return await this.#pageMutex.runExclusive(snapshot.pageKey, async () => {
        const evidence = await observe(snapshot);
        if (evidence.pageKey !== snapshot.pageKey || evidence.conversationId !== snapshot.conversationId) {
          throw new SessionPlaneDomainError('session.page-identity-unverified', 'Manual follow-up page changed');
        }
        const result = receipts.execute({ clientId, requestId: decisionId, method, payload, operation: () => {
          const timestamp = this.#now().toISOString();
          if (!this.#sessions.updateCurrentGeneration(snapshot.sessionId, snapshot.generation, {
            sessionState: 'cancelled', providerState: 'unknown', observationTransport: 'fresh', nextCheckAt: null,
            completedAt: timestamp, errorCode: null, reason: 'manual-followup-reconciled',
          }, timestamp)) throw new SessionPlaneDomainError('session.generation-superseded', 'Request changed during reconciliation');
          const proof = { ...evidence, originalUserMessageId: snapshot.submittedUserMessageId,
            followupUserMessageId: input.followupUserMessageId, responseMessageId: input.responseMessageId,
            responseSha256: input.responseSha256, completionSource: 'explicit-user-confirmation' };
          this.#events.append({ teamId: snapshot.teamId, roleId: snapshot.roleId, sessionId: snapshot.sessionId,
            generation: snapshot.generation, eventType: 'generation.manual-followup-reconciled',
            payload: { requestRef: outbox.outboxId, receiptId: decisionId, evidence: proof }, createdAt: timestamp });
          return { requestOk: true, requestRef: outbox.outboxId, sessionId: snapshot.sessionId,
            generation: snapshot.generation, disposition: 'tracking-cancelled', providerMutation: false, evidence: proof };
        } });
        this.#scheduler.refreshSession(snapshot.sessionId);
        return result;
      });
    });
  }

  async reconcileFailure(
    input: { readonly clientId: string; readonly requestId: string; readonly sessionId: string; readonly generation: number; readonly decisionId: string },
    observe: (snapshot: SessionSnapshot) => Promise<{
      readonly kind: 'thinking-failed'; readonly pageKey: string; readonly bindingEpoch: number;
      readonly conversationId: string; readonly submittedUserMessageId: string | null;
      readonly submittedUserTurnId: string | null; readonly observedAt: string; readonly providerAlerts: readonly string[];
    }>,
  ) {
    const method = 'session.failure.reconcile';
    const payload = { requestId: input.requestId, sessionId: input.sessionId, generation: input.generation };
    const receipts = new ReceiptRepository(this.#database);
    return await this.#scheduler.actorFor(input.sessionId).enqueue(async () => {
      const prior = receipts.get(input.clientId, input.decisionId);
      if (prior !== null) return receipts.execute({ clientId: input.clientId, requestId: input.decisionId,
        method, payload, operation: () => { throw new Error('Existing receipt must replay'); } });
      const outbox = this.#outbox.getByRequest(input.clientId, input.requestId);
      const snapshot = this.#requireSnapshot(input.sessionId);
      if (outbox === null || outbox.sessionId !== input.sessionId || outbox.generation !== input.generation ||
          snapshot.generation !== input.generation) {
        throw new SessionPlaneDomainError('session.generation-superseded', 'Failure reconciliation requires the exact current request');
      }
      this.#requireActiveRoleSession(snapshot);
      this.#adapters.require(snapshot.provider);
      if (snapshot.provider !== 'chatgpt' || snapshot.terminal || snapshot.submissionState !== 'submitted' ||
          !snapshot.promptSubmitted || snapshot.conversationId === null || snapshot.pageKey === null ||
          (snapshot.submittedUserMessageId === null && snapshot.submittedUserTurnId === null) ||
          snapshot.errorCode !== 'provider.actionable-alert') {
        throw new SessionPlaneDomainError('provider.failure-unverified', 'Requires a confirmed submitted current provider failure, not preparation or an ambiguous submission');
      }
      return await this.#pageMutex.runExclusive(snapshot.pageKey, async () => {
        const evidence = await observe(snapshot);
        if (evidence.conversationId !== snapshot.conversationId || evidence.pageKey !== snapshot.pageKey ||
            evidence.submittedUserMessageId !== snapshot.submittedUserMessageId ||
            evidence.submittedUserTurnId !== snapshot.submittedUserTurnId || evidence.kind !== 'thinking-failed') {
          throw new SessionPlaneDomainError('provider.failure-unverified', 'Failure evidence does not match the submitted binding');
        }
        const result = receipts.execute({ clientId: input.clientId, requestId: input.decisionId, method, payload,
          operation: () => {
            const timestamp = this.#now().toISOString();
            if (!this.#sessions.updateCurrentGeneration(snapshot.sessionId, snapshot.generation, {
              sessionState: 'failed', providerState: 'error', observationTransport: 'fresh', nextCheckAt: null,
              completedAt: timestamp, errorCode: 'provider.execution-failed', reason: 'thinking-failed-reconciled',
            }, timestamp)) throw new SessionPlaneDomainError('session.generation-superseded', 'Failed generation is no longer current');
            this.#events.append({ teamId: snapshot.teamId, roleId: snapshot.roleId, sessionId: snapshot.sessionId,
              generation: snapshot.generation, eventType: 'generation.failure-reconciled',
              payload: { requestRef: outbox.outboxId, receiptId: input.decisionId, evidence }, createdAt: timestamp });
            return { requestOk: true, requestRef: outbox.outboxId, sessionId: snapshot.sessionId,
              generation: snapshot.generation, disposition: 'failed', errorCode: 'provider.execution-failed',
              providerMutation: false, evidence };
          } });
        this.#scheduler.refreshSession(snapshot.sessionId);
        return result;
      });
    });
  }

  async refreshPage(
    input: { readonly clientId: string; readonly requestId: string; readonly sessionId: string; readonly generation: number; readonly decisionId: string },
    reload: (snapshot: SessionSnapshot) => Promise<void>,
    verifyPage?: (snapshot: SessionSnapshot) => Promise<boolean | void | { loadError: boolean; rendererCrash: { observedAt: string; targetId: string | null; bindingEpoch: number; draftPreservation: 'provider-persisted-only' } }>,
  ): Promise<void> {
    const method = 'session.page.refresh';
    const requestHash = hashCanonical({ method, requestId: input.requestId, sessionId: input.sessionId, generation: input.generation });
    const receipts = new ReceiptRepository(this.#database);
    await this.#scheduler.actorFor(input.sessionId).enqueue(async () => {
      const prior = receipts.get(input.clientId, input.decisionId);
      if (prior !== null) {
        if (prior.method !== method || prior.requestHash !== requestHash) {
          throw new SessionPlaneDomainError('input.idempotency-conflict', 'Refresh request identity was reused with different arguments');
        }
        if (prior.status === 'complete') return;
        throw new SessionPlaneDomainError('provider.action-unknown', 'Refresh was attempted; inspect the same request before deciding whether another refresh is needed');
      }
      const outbox = this.#outbox.getByRequest(input.clientId, input.requestId);
      const snapshot = this.#requireSnapshot(input.sessionId);
      if (outbox === null || outbox.sessionId !== input.sessionId || outbox.generation !== input.generation || snapshot.generation !== input.generation) {
        throw new SessionPlaneDomainError('session.generation-superseded', 'Refresh requires the current exact request');
      }
      this.#adapters.require(snapshot.provider);
      if (snapshot.provider !== 'chatgpt') throw new SessionPlaneDomainError('capability.unsupported', 'Page refresh currently supports ChatGPT only');
      if (snapshot.pageKey === null) throw new SessionPlaneDomainError('browser.unavailable', 'Inspect the exact request to recover its page before refreshing');
      await this.#pageMutex.runExclusive(snapshot.pageKey, async () => {
        const recovery = new ConversationLoadRecoveryRepository(this.#database);
        let loadError = false;
        const requireReady = () => {
          const nextAllowedAt = loadError ? recovery.effectiveNextAllowedAt(snapshot.conversationId ?? undefined)
            : recovery.serviceNextAllowedAt(snapshot.conversationId ?? undefined);
          if (nextAllowedAt !== null && Date.parse(nextAllowedAt) > this.#now().getTime()) {
            throw new SessionPlaneDomainError('provider.observation-deferred',
              `Page refresh was not dispatched: shared ChatGPT pacing requires waiting until ${nextAllowedAt}`);
          }
        };
        requireReady();
        const verification = await verifyPage?.(snapshot);
        loadError = verification === true || (typeof verification === 'object' && verification.loadError);
        requireReady();
        const record = (status: 'attempted' | 'complete') => receipts.record({
          clientId: input.clientId, requestId: input.decisionId, method, requestHash, status,
          result: { requestId: input.requestId, sessionId: input.sessionId, generation: input.generation,
            pageKey: snapshot.pageKey, conversationId: snapshot.conversationId,
            dispatch: status === 'complete' ? 'reload-returned' : 'attempted-outcome-unknown',
            ...(typeof verification === 'object' ? { rendererCrash: verification.rendererCrash } : {}),
            conversationRecovered: null },
        });
        this.#database.transaction(() => {
          if (loadError && !recovery.reserveRefresh(this.#now().toISOString(), 5_000, snapshot.conversationId ?? undefined)) {
            throw new SessionPlaneDomainError('provider.observation-deferred', 'Shared refresh pacing changed; no reload was dispatched');
          }
          record('attempted');
          if (outbox.submissionState === 'prepared' && outbox.errorCode === 'provider.preparation-required') {
            this.#outbox.transition(outbox.outboxId, ['prepared'], 'prepared', {
              updatedAt: this.#now().toISOString(),
              resultJson: JSON.stringify({ kind: 'pending-preparation', choices: {}, requiresInspection: true }),
            });
          }
        });
        await reload(snapshot);
        record('complete');
      });
    });
  }

  async withPendingPreparation<Result>(
    input: { readonly clientId: string; readonly requestId: string; readonly sessionId: string; readonly generation: number },
    operation: (snapshot: SessionSnapshot) => Promise<Result>,
  ): Promise<Result> {
    const actor = this.#scheduler.actorFor(input.sessionId);
    return await actor.enqueue(async () => {
      const pending = this.#requirePreparationOwner(input);
      let snapshot = this.#requireSnapshot(input.sessionId);
      this.#requireAccountReady(snapshot);
      this.#adapters.require(snapshot.provider);
      if (snapshot.provider !== 'chatgpt') {
        throw new SessionPlaneDomainError('capability.unsupported', 'Provider cannot inspect assisted preparation state');
      }
      // Status inspection must not open a submission or navigate a missing page.
      const pageKey = snapshot.pageKey;
      if (pageKey === null) throw new SessionPlaneDomainError('browser.unavailable', 'Exact preparation page is unavailable');
      return await this.#pageMutex.runExclusive(pageKey, async () => {
        this.#requirePreparationOwner(input);
        this.#requireAccountReady(this.#requireSnapshot(input.sessionId));
        snapshot = this.#requireSnapshot(input.sessionId);
        if (snapshot.pageKey !== pageKey || pending.sessionId !== snapshot.sessionId) {
          throw new SessionPlaneDomainError('session.generation-superseded', 'Preparation page changed during inspection');
        }
        const result = await operation(snapshot);
        const current = this.#outbox.requireById(pending.outboxId);
        const state = parsePreparationState(current);
        if (state.requiresInspection === true) {
          this.#outbox.transition(current.outboxId, ['prepared'], 'prepared', {
            updatedAt: this.#now().toISOString(),
            resultJson: JSON.stringify({ ...state, requiresInspection: false }),
            errorCode: 'provider.preparation-required',
            promptSubmitted: false,
          });
        }
        return result;
      });
    });
  }

  async decidePreparation<Result>(input: {
    readonly clientId: string;
    readonly requestId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly decisionId: string;
    readonly decision: 'choose' | 'reveal' | 'cancel' | 'discover' | 'configure';
    readonly purpose?: PreparationPurpose;
    readonly snapshotId?: string;
    readonly ref?: string;
    readonly value?: number | undefined;
    readonly configurationId?: string | undefined;
  }, operation?: (snapshot: SessionSnapshot, payload: StoredOutboxPayload) => Promise<{ readonly choice: PreparationTarget | null; readonly result: Result }>): Promise<Result | SessionSnapshot> {
    const actor = this.#scheduler.actorFor(input.sessionId);
    const payload = {
      requestId: input.requestId,
      sessionId: input.sessionId,
      generation: input.generation,
      decision: input.decision,
      purpose: input.purpose ?? null,
      snapshotId: input.snapshotId ?? null,
      ref: input.ref ?? null,
      value: input.value ?? null,
      ...(input.configurationId === undefined ? {} : { configurationId: input.configurationId }),
    };
    const method = 'session.preparation.decide';
    const requestHash = hashCanonical({ method, payload });
    return await actor.enqueue(async () => {
      const previous = this.#database.raw.prepare(`
        SELECT method, request_hash AS requestHash, status, result_json AS resultJson
        FROM request_receipts WHERE client_id = ? AND request_id = ?
      `).get(input.clientId, input.decisionId) as { method: string; requestHash: string; status: string; resultJson: string } | undefined;
      if (previous !== undefined) {
        if (previous.method !== method || previous.requestHash !== requestHash) {
          throw new SessionPlaneDomainError('input.idempotency-conflict', 'Decision ID was already used with different input');
        }
        if (previous.status !== 'complete') {
          throw new SessionPlaneDomainError('provider.action-unknown', 'Preparation decision may have occurred; inspect before another decision');
        }
        return JSON.parse(previous.resultJson) as Result | SessionSnapshot;
      }
      this.#requirePreparationOwner(input);
      const initialSnapshot = this.#requireSnapshot(input.sessionId);
      if (input.decision !== 'cancel') this.#requireAccountReady(initialSnapshot);
      const pageKey = initialSnapshot.pageKey;
      if (pageKey === null) throw new SessionPlaneDomainError('browser.unavailable', 'Exact preparation page is unavailable');
      return await this.#pageMutex.runExclusive(pageKey, async () => {
        const current = this.#requirePreparationOwner(input);
        const snapshot = this.#requireSnapshot(input.sessionId);
        if (snapshot.pageKey !== pageKey) throw new SessionPlaneDomainError('session.generation-superseded', 'Preparation page changed before decision');
        if (input.decision !== 'cancel') this.#requireAccountReady(snapshot);
        const timestamp = this.#now().toISOString();
        this.#database.raw.prepare(`
          INSERT INTO request_receipts(client_id, request_id, method, result_json, created_at, request_hash, status, updated_at)
          VALUES (?, ?, ?, '{}', ?, ?, 'attempted', ?)
        `).run(input.clientId, input.decisionId, method, timestamp, requestHash, timestamp);

        let result: Result | SessionSnapshot;
        let choices: PreparationChoices | null = null;
        if (input.decision === 'cancel') {
          result = this.#terminalizePreparation(actor, current, 'provider.preparation-cancelled');
        } else {
          if (input.purpose === undefined || operation === undefined ||
              (!['discover', 'configure'].includes(input.decision) && (input.snapshotId === undefined || input.ref === undefined))) {
            throw new SessionPlaneDomainError('input.invalid', 'Choosing a target requires purpose, snapshotId, ref, and a decision handler');
          }
          const selected = await operation(snapshot, parseOutboxPayload(current));
          if ((input.decision === 'choose' || input.decision === 'configure') && selected.choice?.purpose !== input.purpose) {
            throw new SessionPlaneDomainError('input.invalid', 'Preparation purpose does not match the observed choice');
          }
          if ((input.decision === 'reveal' || input.decision === 'discover') && selected.choice !== null) {
            throw new SessionPlaneDomainError('internal.invariant-violation', 'Revealing choices cannot record a selected value');
          }
          this.#requirePreparationOwner(input);
          const state = parsePreparationState(current);
          const { model: _model, effort: _effort, ...otherChoices } = state.choices;
          if (selected.choice !== null) {
            const configuration = selected.choice.purpose === 'model' || selected.choice.purpose === 'effort';
            choices = { ...(configuration ? otherChoices : state.choices), [selected.choice.purpose]: selected.choice };
          } else {
            choices = otherChoices;
          }
          result = selected.result;
        }

        let eventSequence = 0;
        this.#database.transaction(() => {
          if (choices !== null) {
            const updated = this.#outbox.transition(current.outboxId, ['prepared'], 'prepared', {
              updatedAt: this.#now().toISOString(),
              errorCode: 'provider.preparation-required',
              resultJson: JSON.stringify({ kind: 'pending-preparation', choices }),
              promptSubmitted: false,
            });
            if (!updated) throw new SessionPlaneDomainError('session.generation-superseded', 'Preparation changed before choice was recorded');
          }
          const updatedAt = this.#now().toISOString();
          this.#database.raw.prepare(`
            UPDATE request_receipts SET result_json = ?, status = 'complete', updated_at = ?
            WHERE client_id = ? AND request_id = ? AND status = 'attempted'
          `).run(JSON.stringify(result), updatedAt, input.clientId, input.decisionId);
          if (input.decision !== 'cancel') {
            eventSequence = this.#events.append({
              teamId: current.teamId,
              roleId: current.roleId,
              sessionId: current.sessionId,
              generation: current.generation,
              eventType: input.decision === 'reveal' ? 'generation.preparation-choices-revealed' : 'generation.preparation-decision-recorded',
              payload: { decision: input.decision, purpose: input.purpose, promptSubmitted: false },
              createdAt: updatedAt,
            });
          }
        });
        if (eventSequence > 0) actor.publish(this.#requireSnapshot(input.sessionId), eventSequence);
        return result;
      });
    });
  }

  #requirePreparationOwner(input: {
    readonly clientId: string; readonly requestId: string; readonly sessionId: string; readonly generation: number;
  }): OutboxRecord {
    const outbox = this.#outbox.getByRequest(input.clientId, input.requestId);
    const snapshot = this.#requireSnapshot(input.sessionId);
    if (
      outbox === null || outbox.sessionId !== input.sessionId || outbox.generation !== input.generation ||
      outbox.submissionState !== 'prepared' || outbox.errorCode !== 'provider.preparation-required' ||
      snapshot.generation !== input.generation ||
      snapshot.sessionState !== 'submitting' || snapshot.submissionState !== 'prepared' || snapshot.promptSubmitted
    ) {
      throw new SessionPlaneDomainError('session.generation-superseded', 'Exact caller-owned preparation is no longer current');
    }
    return outbox;
  }

  accountCooldown(snapshot: SessionSnapshot): string | null {
    if (snapshot.provider !== 'chatgpt') return null;
    // Recovery GET pacing is not a restriction on settings or the submission POST.
    // Only an explicit broad service hold applies to unrelated web preparation.
    const until = new ConversationLoadRecoveryRepository(this.#database).serviceNextAllowedAt();
    return until && Date.parse(until) > this.#now().getTime() ? until : null;
  }

  #requireAccountReady(snapshot: SessionSnapshot): void {
    const nextCheckAt = this.accountCooldown(snapshot);
    if (nextCheckAt !== null) throw new SessionPlaneDomainError('provider.preparation-required',
      'ChatGPT account cooldown: keep the same prepared request and wait before web preparation or submission',
      { reason: 'account-cooldown', nextCheckAt, promptSubmitted: false,
        sessionId: snapshot.sessionId, generation: snapshot.generation });
  }

  async #recordPreparationRequired(actor: SessionActor, outbox: OutboxRecord, cause: unknown): Promise<SessionSnapshot> {
    const classified = classifyPreSubmitError(cause);
    const nextCheckAt = this.accountCooldown(this.#requireSnapshot(outbox.sessionId));
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    const state = {
      kind: 'pending-preparation',
      choices: parsePreparationState(outbox).choices,
      message: classified.message,
    } satisfies PendingPreparation;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      const updated = this.#sessions.updateCurrentGeneration(
        outbox.sessionId,
        outbox.generation,
        {
          submissionState: 'prepared',
          providerState: 'pending',
          observationTransport: 'fresh',
          reason: nextCheckAt === null ? 'agent-preparation-required' : 'account-cooldown',
          nextCheckAt,
          errorCode: 'provider.preparation-required',
          promptSubmitted: false,
        },
        timestamp,
      );
      if (!updated || !this.#outbox.transition(outbox.outboxId, ['prepared'], 'prepared', {
        updatedAt: timestamp,
        resultJson: JSON.stringify(state),
        errorCode: 'provider.preparation-required',
        promptSubmitted: false,
      })) {
        throw new SessionPlaneDomainError('session.generation-superseded', 'Preparation ownership changed before it could be recorded');
      }
      snapshot = this.#requireSnapshot(outbox.sessionId);
      eventSequence = this.#events.append({
        teamId: outbox.teamId,
        roleId: outbox.roleId,
        sessionId: outbox.sessionId,
        generation: outbox.generation,
        eventType: 'generation.preparation-required',
        payload: { errorCode: classified.errorCode, promptSubmitted: false },
        createdAt: timestamp,
      });
    });
    actor.publish(snapshot, eventSequence);
    const authorizedResend = parseOutboxPayload(outbox).authorizedResend;
    throw new SessionPlaneDomainError(
      'provider.preparation-required',
      authorizedResend !== undefined ? classified.message : nextCheckAt === null ? 'Provider UI needs a caller decision before the same request can continue'
        : 'The same prepared request is waiting for the shared ChatGPT account cooldown',
      { promptSubmitted: false, requestId: outbox.requestId, sessionId: outbox.sessionId, generation: outbox.generation, snapshot,
        ...(authorizedResend === undefined ? {} : { originalRequestRef: authorizedResend.requestRef,
          pauseReason: classified.message, ...preSubmitDetails(classified.details) }) },
    );
  }

  #terminalizePreparation(actor: SessionActor, outbox: OutboxRecord, errorCode: string): SessionSnapshot {
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      const updated = this.#sessions.updateCurrentGeneration(outbox.sessionId, outbox.generation, {
        sessionState: 'ready',
        providerState: 'error',
        observationTransport: 'unavailable',
        submissionState: 'failed_pre_submit',
        reason: 'preparation-cancelled-by-caller',
        errorCode,
        promptSubmitted: false,
      }, timestamp);
      if (!updated || !this.#outbox.transition(outbox.outboxId, ['prepared'], 'failed_pre_submit', {
        updatedAt: timestamp,
        resultJson: null,
        errorCode,
        promptSubmitted: false,
      })) throw new SessionPlaneDomainError('session.generation-superseded', 'Preparation was already completed');
      snapshot = this.#requireSnapshot(outbox.sessionId);
      eventSequence = this.#events.append({
        teamId: outbox.teamId,
        roleId: outbox.roleId,
        sessionId: outbox.sessionId,
        generation: outbox.generation,
        eventType: 'generation.preparation-cancelled',
        payload: { errorCode, promptSubmitted: false },
        createdAt: timestamp,
      });
    });
    actor.publish(snapshot, eventSequence);
    return snapshot;
  }

  #requireActiveRoleSession(session: Pick<SessionSnapshot, 'sessionId' | 'teamId' | 'roleId'>) {
    const team = this.#directory.getTeam(session.teamId);
    if (!team.roles.some(role => role.roleId === session.roleId && role.roleState === 'active' &&
        role.currentSessionId === session.sessionId)) {
      throw new SessionPlaneDomainError('session.generation-superseded', 'New submissions require the current session of an active role');
    }
    return team;
  }

  #prepareOutbox(
    actor: SessionActor,
    sessionId: string,
    input: SessionSendInput,
    payload: Readonly<Record<string, unknown>>,
    requestHash: string,
    authorizedOriginal?: OutboxRecord,
  ): PreparedOutbox {
    let outbox!: OutboxRecord;
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const session = this.#sessions.getSession(sessionId);
      if (session === null) {
        throw new SessionPlaneDomainError('input.session-not-found', `Unknown session: ${sessionId}`);
      }
      if (authorizedOriginal !== undefined && (authorizedOriginal.sessionId !== sessionId ||
          authorizedOriginal.generation !== session.currentGeneration ||
          payload.authorizedResend === undefined)) throw new SessionPlaneDomainError(
        'session.generation-superseded', 'Authorized resend source is no longer current');
      if (authorizedOriginal === undefined && !['created', 'ready', 'complete'].includes(session.sessionState) &&
          !(session.sessionState === 'cancelled' && this.#requireSnapshot(sessionId).reason === 'manual-followup-reconciled') &&
          !(session.sessionState === 'failed' &&
            this.#requireSnapshot(sessionId).reason === 'thinking-failed-reconciled' &&
            this.#requireSnapshot(sessionId).errorCode === 'provider.execution-failed')) {
        throw new SessionPlaneDomainError(
          'session.busy',
          `Session ${sessionId} already has active generation ${session.currentGeneration}`,
        );
      }
      if (session.conversationId !== null &&
          new ReceiptRepository(this.#database).findConversationDeletion(session.conversationId) !== null) {
        throw new SessionPlaneDomainError('session.cleanup-pending', 'Conversation deletion was attempted; create a replacement session');
      }
      const team = this.#requireActiveRoleSession(session);
      const generation = session.currentGeneration + 1;
      const timestamp = this.#now().toISOString();
      const deadlineAt = input.failureContinuation?.deadlineAt ?? new Date(
        this.#now().getTime() + input.sessionDeadlineSec * 1_000,
      ).toISOString();
      if (input.failureContinuation !== undefined &&
          (deadlineAt !== session.deadlineAt || Date.parse(deadlineAt) <= this.#now().getTime())) {
        throw new SessionPlaneDomainError('session.deadline-expired', 'Automatic continuation cannot reset or exceed the original deadline');
      }
      this.#sessions.insertGeneration({
        sessionId,
        generation,
        teamBriefVersion: team.sharedBriefVersion,
        promptHash: hashPrompt(input.prompt),
        submissionState: 'prepared',
        submittedUserMessageId: null,
        submittedUserTurnId: null,
        responseMessageId: null,
        answerText: null,
        completedAt: null,
        reason: null,
        errorCode: null,
        promptSubmitted: false,
      });
      if (
        !this.#sessions.advanceGeneration({
          sessionId,
          expectedGeneration: session.currentGeneration,
          nextGeneration: generation,
          deadlineAt,
          updatedAt: timestamp,
        })
      ) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Session ${sessionId} generation changed before outbox preparation`,
        );
      }
      outbox = this.#outbox.insert({
        clientId: input.clientId,
        requestId: input.requestId,
        teamId: session.teamId,
        roleId: session.roleId,
        sessionId,
        generation,
        payloadJson: JSON.stringify(payload),
        requestHash,
        createdAt: timestamp,
      });
      eventSequence = this.#events.append({
        teamId: session.teamId,
        roleId: session.roleId,
        sessionId,
        generation,
        eventType: 'generation.prepared',
        payload: { teamBriefVersion: team.sharedBriefVersion },
        createdAt: timestamp,
      });
      snapshot = this.#requireSnapshot(sessionId);
    });
    actor.publish(snapshot, eventSequence);
    return { outbox, snapshot, eventSequence };
  }

  #persistPageKey(actor: SessionActor, outbox: OutboxRecord, pageKey: string): SessionSnapshot {
    return this.#updateOnly(
      actor,
      outbox,
      { pageKey },
      'generation.page-reserved',
      { hasPageKey: true },
    );
  }

  #transition(
    actor: SessionActor,
    outbox: OutboxRecord,
    expected: readonly OutboxState[],
    next: OutboxState,
    update: CurrentGenerationUpdate,
    eventType: string,
    outboxFields: {
      readonly promptSubmitted?: boolean;
      readonly errorCode?: string | null;
      readonly resultJson?: string | null;
    },
  ): SessionSnapshot {
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      if (!this.#sessions.updateCurrentGeneration(outbox.sessionId, outbox.generation, update, timestamp)) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Generation ${outbox.generation} is no longer current`,
        );
      }
      if (
        !this.#outbox.transition(outbox.outboxId, expected, next, {
          updatedAt: timestamp,
          ...outboxFields,
        })
      ) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          `Outbox ${outbox.outboxId} transition to ${next} was rejected`,
        );
      }
      const session = this.#sessions.getSession(outbox.sessionId);
      if (session === null) {
        throw new SessionPlaneDomainError(
          'input.session-not-found',
          `Unknown session: ${outbox.sessionId}`,
        );
      }
      eventSequence = this.#events.append({
        teamId: session.teamId,
        roleId: session.roleId,
        sessionId: session.sessionId,
        generation: outbox.generation,
        eventType,
        payload: {
          submissionState: next,
          promptSubmitted: outboxFields.promptSubmitted ?? false,
        },
        createdAt: timestamp,
      });
      snapshot = this.#requireSnapshot(outbox.sessionId);
    });
    actor.publish(snapshot, eventSequence);
    return snapshot;
  }

  #updateOnly(
    actor: SessionActor,
    outbox: OutboxRecord,
    update: CurrentGenerationUpdate,
    eventType: string,
    eventPayload: Readonly<Record<string, unknown>>,
  ): SessionSnapshot {
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      if (!this.#sessions.updateCurrentGeneration(outbox.sessionId, outbox.generation, update, timestamp)) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Generation ${outbox.generation} is no longer current`,
        );
      }
      const session = this.#sessions.getSession(outbox.sessionId);
      if (session === null) {
        throw new SessionPlaneDomainError(
          'input.session-not-found',
          `Unknown session: ${outbox.sessionId}`,
        );
      }
      eventSequence = this.#events.append({
        teamId: session.teamId,
        roleId: session.roleId,
        sessionId: session.sessionId,
        generation: outbox.generation,
        eventType,
        payload: eventPayload,
        createdAt: timestamp,
      });
      snapshot = this.#requireSnapshot(outbox.sessionId);
    });
    actor.publish(snapshot, eventSequence);
    return snapshot;
  }

  #completeSubmitted(
    actor: SessionActor,
    outbox: OutboxRecord,
    submission: ProviderSubmission,
    acknowledgement: ProviderSubmissionAcknowledgement,
  ): SessionSnapshot {
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      const updated = this.#sessions.updateCurrentGeneration(
        outbox.sessionId,
        outbox.generation,
        {
          sessionState: 'submitted',
          providerState: 'generating',
          observationTransport: 'fresh',
          submissionState: 'submitted',
          conversationId: acknowledgement.conversationId,
          pageKey: submission.pageKey,
          submittedUserMessageId: acknowledgement.submittedUserMessageId,
          submittedUserTurnId: acknowledgement.submittedUserTurnId,
          promptSubmitted: true,
          reason: null,
          errorCode: null,
        },
        timestamp,
      );
      if (!updated) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Generation ${outbox.generation} is no longer current`,
        );
      }
      snapshot = this.#requireSnapshot(outbox.sessionId);
      if (
        !this.#outbox.transition(outbox.outboxId, ['submit_attempted'], 'submitted', {
          updatedAt: timestamp,
          resultJson: JSON.stringify(snapshot),
          errorCode: null,
          promptSubmitted: true,
        })
      ) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          `Outbox ${outbox.outboxId} could not be acknowledged`,
        );
      }
      eventSequence = this.#events.append({
        teamId: outbox.teamId,
        roleId: outbox.roleId,
        sessionId: outbox.sessionId,
        generation: outbox.generation,
        eventType: 'generation.submitted',
        payload: {
          hasConversationId: true,
          hasSubmittedUserMessageId: true,
          hasSubmittedUserTurnId: true,
          acknowledgementEvidence: acknowledgement.evidence ?? 'provider-adapter',
          conversationId: acknowledgement.conversationId,
          submittedUserMessageId: acknowledgement.submittedUserMessageId,
          submittedUserTurnId: acknowledgement.submittedUserTurnId,
        },
        createdAt: timestamp,
      });
    });
    actor.publish(snapshot, eventSequence);
    this.#onSubmitted?.(snapshot);
    return snapshot;
  }

  async #failPreSubmit(
    actor: SessionActor,
    originalOutbox: OutboxRecord,
    error: unknown,
  ): Promise<never> {
    const classified = classifyPreSubmitError(error);
    const outbox = this.#outbox.requireById(originalOutbox.outboxId);
    if (outbox.submissionState === 'submitted') {
      return throwUnexpectedSuccess(parseStoredSnapshot(outbox));
    }
    if (outbox.submissionState === 'submit_attempted' || outbox.submissionState === 'submission_unknown') {
      return await this.#markSubmissionUnknown(actor, outbox, 'pre-submit-error-after-attempt');
    }

    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      const updated = this.#sessions.updateCurrentGeneration(
        outbox.sessionId,
        outbox.generation,
        {
          sessionState: 'ready',
          providerState: 'error',
          observationTransport: 'unavailable',
          submissionState: 'failed_pre_submit',
          reason: 'pre-submit-failure',
          errorCode: classified.errorCode,
          promptSubmitted: false,
        },
        timestamp,
      );
      if (!updated) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Generation ${outbox.generation} is no longer current`,
        );
      }
      snapshot = this.#requireSnapshot(outbox.sessionId);
      if (
        !this.#outbox.transition(
          outbox.outboxId,
          ['prepared', 'composer_filled', 'failed_pre_submit'],
          'failed_pre_submit',
          {
            updatedAt: timestamp,
            resultJson: JSON.stringify({ ...snapshot, message: classified.message }),
            errorCode: classified.errorCode,
            promptSubmitted: false,
          },
        )
      ) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          `Outbox ${outbox.outboxId} could not record pre-submit failure`,
        );
      }
      eventSequence = this.#events.append({
        teamId: outbox.teamId,
        roleId: outbox.roleId,
        sessionId: outbox.sessionId,
        generation: outbox.generation,
        eventType: 'generation.pre-submit-failed',
        payload: {
          errorCode: classified.errorCode,
          promptSubmitted: false,
          ...(typeof preSubmitDetails(classified.details).preparationStage === 'string'
            ? { preparationStage: preSubmitDetails(classified.details).preparationStage } : {}),
        },
        createdAt: timestamp,
      });
    });
    actor.publish(snapshot, eventSequence);
    throw new SessionPlaneDomainError(classified.errorCode, classified.message, {
      ...preSubmitDetails(classified.details),
      promptSubmitted: false,
      snapshot,
    });
  }

  #recordInterruptedPreSubmit(
    actor: SessionActor,
    outbox: OutboxRecord,
  ): SessionSnapshot {
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      const updated = this.#sessions.updateCurrentGeneration(
        outbox.sessionId,
        outbox.generation,
        {
          sessionState: 'ready',
          providerState: 'error',
          observationTransport: 'unavailable',
          submissionState: 'failed_pre_submit',
          nextCheckAt: null,
          reason: 'restart-pre-submit-interrupted',
          errorCode: 'browser.unavailable',
          promptSubmitted: false,
        },
        timestamp,
      );
      if (!updated) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Generation ${outbox.generation} is no longer current`,
        );
      }
      snapshot = this.#requireSnapshot(outbox.sessionId);
      if (
        !this.#outbox.transition(
          outbox.outboxId,
          ['prepared', 'composer_filled'],
          'failed_pre_submit',
          {
            updatedAt: timestamp,
            resultJson: JSON.stringify(snapshot),
            errorCode: 'browser.unavailable',
            promptSubmitted: false,
          },
        )
      ) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          `Outbox ${outbox.outboxId} could not record interrupted pre-submit recovery`,
        );
      }
      eventSequence = this.#events.append({
        teamId: outbox.teamId,
        roleId: outbox.roleId,
        sessionId: outbox.sessionId,
        generation: outbox.generation,
        eventType: 'generation.pre-submit-interrupted',
        payload: {
          errorCode: 'browser.unavailable',
          promptSubmitted: false,
        },
        createdAt: timestamp,
      });
    });
    actor.publish(snapshot, eventSequence);
    return snapshot;
  }

  #recordSubmissionUnknown(
    actor: SessionActor,
    originalOutbox: OutboxRecord,
    reason: string,
  ): SessionSnapshot {
    const outbox = this.#outbox.requireById(originalOutbox.outboxId);
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      const session = this.#sessions.getSession(outbox.sessionId);
      if (session === null) {
        throw new SessionPlaneDomainError(
          'input.session-not-found',
          `Unknown session: ${outbox.sessionId}`,
        );
      }
      const lifecycleUpdate: CurrentGenerationUpdate = isTerminalSessionState(session.sessionState)
        ? {}
        : {
            sessionState: 'observing',
            providerState: 'unknown',
            observationTransport: 'unavailable',
          };
      const updated = this.#sessions.updateCurrentGeneration(
        outbox.sessionId,
        outbox.generation,
        {
          ...lifecycleUpdate,
          submissionState: 'submission_unknown',
          reason,
          errorCode: 'session.submission-unknown',
          promptSubmitted: outbox.promptSubmitted || outbox.submissionState === 'submit_attempted',
        },
        timestamp,
      );
      if (!updated) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Generation ${outbox.generation} is no longer current`,
        );
      }
      snapshot = this.#requireSnapshot(outbox.sessionId);
      if (
        !this.#outbox.transition(
          outbox.outboxId,
          ['prepared', 'composer_filled', 'submit_attempted', 'submission_unknown'],
          'submission_unknown',
          {
            updatedAt: timestamp,
            resultJson: JSON.stringify(snapshot),
            errorCode: 'session.submission-unknown',
            promptSubmitted: snapshot.promptSubmitted,
          },
        )
      ) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          `Outbox ${outbox.outboxId} could not record ambiguous submission`,
        );
      }
      eventSequence = this.#events.append({
        teamId: outbox.teamId,
        roleId: outbox.roleId,
        sessionId: outbox.sessionId,
        generation: outbox.generation,
        eventType: 'generation.submission-unknown',
        payload: { reason, promptSubmitted: snapshot.promptSubmitted },
        createdAt: timestamp,
      });
    });
    actor.publish(snapshot, eventSequence);
    return snapshot;
  }

  async #markSubmissionUnknown(
    actor: SessionActor,
    originalOutbox: OutboxRecord,
    reason: string,
  ): Promise<never> {
    const snapshot = this.#recordSubmissionUnknown(actor, originalOutbox, reason);
    this.#onSubmissionUnknown?.(snapshot);
    throw new SessionPlaneDomainError(
      'session.submission-unknown',
      'Submission was attempted but exact provider acknowledgement was not proven',
      { promptSubmitted: snapshot.promptSubmitted, snapshot },
    );
  }

  async #replay(actor: SessionActor, outbox: OutboxRecord): Promise<SessionSnapshot> {
    if (outbox.submissionState === 'submitted') {
      return parseStoredSnapshot(outbox);
    }
    if (outbox.submissionState === 'failed_pre_submit') {
      const snapshot = parseStoredSnapshot(outbox);
      throw new SessionPlaneDomainError(
        outbox.errorCode ?? 'provider.composer-unavailable',
        'The original request failed before provider submission',
        { promptSubmitted: false, snapshot },
      );
    }
    if (outbox.submissionState === 'submission_unknown') {
      const snapshot = parseStoredSnapshot(outbox);
      throw new SessionPlaneDomainError(
        'session.submission-unknown',
        'The original request has ambiguous provider acknowledgement and will not be resent',
        { promptSubmitted: outbox.promptSubmitted, snapshot },
      );
    }
    const pendingSnapshot = outbox.submissionState === 'prepared' &&
      outbox.errorCode === 'provider.preparation-required' && !outbox.promptSubmitted ? this.#sessions.getSnapshot(outbox.sessionId) : null;
    if (
      pendingSnapshot?.generation === outbox.generation &&
      pendingSnapshot.sessionState === 'submitting' &&
      pendingSnapshot.submissionState === 'prepared' &&
      !pendingSnapshot.promptSubmitted
    ) {
      throw new SessionPlaneDomainError(
        'provider.preparation-required',
        'The original request is waiting for a purpose-scoped provider UI decision',
        {
          promptSubmitted: false,
          requestId: outbox.requestId,
          sessionId: outbox.sessionId,
          generation: outbox.generation,
          snapshot: this.#requireSnapshot(outbox.sessionId),
        },
      );
    }
    if (outbox.submissionState === 'submit_attempted') {
      return await this.#markSubmissionUnknown(actor, outbox, 'restart-after-submit-attempt');
    }
    return await this.#failPreSubmit(
      actor,
      outbox,
      new ProviderSubmissionError(
        'session.submission-unknown',
        'The original request stopped before submit and will not replay browser mutations',
      ),
    );
  }

  #resolveSession(input: SessionSendInput): SessionSnapshot {
    if (input.sessionId !== undefined) {
      return this.#directory.getSession(input.sessionId);
    }
    if (input.teamId === undefined || input.roleKey === undefined) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        'session.send requires either sessionId or teamId + roleKey',
      );
    }
    return this.#directory.getCurrentSession(input.teamId, input.roleKey);
  }

  #requireSnapshot(sessionId: string): SessionSnapshot {
    const snapshot = this.#sessions.getSnapshot(sessionId);
    if (snapshot === null) {
      throw new SessionPlaneDomainError('input.session-not-found', `Unknown session: ${sessionId}`);
    }
    return snapshot;
  }
}

async function withProviderStageTimeout<Result>(
  operation: Promise<Result>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<Result> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout?.();
          } catch (error) {
            reject(error);
            return;
          }
          reject(new ProviderSubmissionError('browser.unavailable', 'Provider browser operation timed out'));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function promptFromOutbox(outbox: OutboxRecord): string | null {
  try {
    const payload = JSON.parse(outbox.payloadJson) as unknown;
    if (
      payload !== null &&
      typeof payload === 'object' &&
      'prompt' in payload &&
      typeof (payload as { readonly prompt?: unknown }).prompt === 'string'
    ) {
      const prompt = (payload as { readonly prompt: string }).prompt;
      return prompt.length > 0 ? prompt : null;
    }
  } catch {
    return null;
  }
  return null;
}

function parseOutboxPayload(outbox: OutboxRecord): StoredOutboxPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(outbox.payloadJson);
  } catch (error) {
    throw new SessionPlaneDomainError('internal.invariant-violation', `Outbox ${outbox.outboxId} has invalid payload JSON`, error);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SessionPlaneDomainError('internal.invariant-violation', `Outbox ${outbox.outboxId} payload is not an object`);
  }
  const value = parsed as Record<string, unknown>;
  const attachmentLists = [value.attachments];
  if (value.uploadAttachments !== undefined) attachmentLists.push(value.uploadAttachments);
  if (
    typeof value.prompt !== 'string' ||
    !(value.model === null || typeof value.model === 'string') ||
    !(value.effort === null || typeof value.effort === 'string') ||
    !(value.surface === null || typeof value.surface === 'string') ||
    !Number.isSafeInteger(value.sessionDeadlineSec) ||
    !attachmentLists.every((attachments) => Array.isArray(attachments) &&
      attachments.every((item) => item !== null && typeof item === 'object' &&
      typeof (item as Record<string, unknown>).path === 'string' &&
      typeof (item as Record<string, unknown>).name === 'string' &&
      Number.isSafeInteger((item as Record<string, unknown>).sizeBytes) &&
      typeof (item as Record<string, unknown>).sha256 === 'string'))
  ) {
    throw new SessionPlaneDomainError('internal.invariant-violation', `Outbox ${outbox.outboxId} payload is incomplete`);
  }
  return value as unknown as StoredOutboxPayload;
}

function parsePreparationState(outbox: OutboxRecord): PendingPreparation {
  if (outbox.resultJson === null) return { kind: 'pending-preparation', choices: {} };
  try {
    const parsed = JSON.parse(outbox.resultJson) as unknown;
    if (parsed !== null && typeof parsed === 'object' &&
      (parsed as Record<string, unknown>).kind === 'pending-preparation' &&
      (parsed as Record<string, unknown>).choices !== null &&
      typeof (parsed as Record<string, unknown>).choices === 'object') {
      return parsed as PendingPreparation;
    }
  } catch {
    // The state is only read for an outbox already marked as preparation-pending.
  }
  throw new SessionPlaneDomainError('internal.invariant-violation', `Outbox ${outbox.outboxId} has invalid preparation state`);
}

function sessionSendInputFromOutbox(outbox: OutboxRecord, payload: StoredOutboxPayload): SessionSendInput {
  return {
    clientId: outbox.clientId,
    requestId: outbox.requestId,
    sessionId: outbox.sessionId,
    prompt: payload.prompt,
    model: payload.model,
    effort: payload.effort,
    surface: payload.surface,
    files: payload.attachments.map((attachment) => attachment.path),
    sessionDeadlineSec: payload.sessionDeadlineSec,
    ...(payload.thinkingFailureRecovery === true ? { thinkingFailureRecovery: true } : {}),
    ...(payload.failureContinuation === undefined ? {} : { failureContinuation: payload.failureContinuation }),
    ...(payload.authorizedResend === undefined ? {} : { authorizedResend: payload.authorizedResend }),
  };
}

function validatePrompt(value: string): string {
  if (value.length === 0 || value.length > 200_000) {
    throw new SessionPlaneDomainError(
      'input.invalid',
      'prompt must contain between 1 and 200000 characters',
    );
  }
  return value;
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function classifyPreSubmitError(error: unknown): {
  readonly errorCode: string;
  readonly message: string;
  readonly details?: unknown;
} {
  if (error instanceof ProviderSubmissionError) {
    return { errorCode: error.errorCode, message: error.message, details: error.details };
  }
  if (error instanceof SessionPlaneDomainError) {
    return { errorCode: error.errorCode, message: error.message, details: error.details };
  }
  return {
    errorCode: 'browser.unavailable',
    message: error instanceof Error ? error.message : 'Provider preparation failed',
  };
}

function preSubmitDetails(value: unknown): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  return { providerDetails: value };
}

function tryParseStoredSnapshot(outbox: OutboxRecord): SessionSnapshot | null {
  if (outbox.resultJson === null) return null;
  try {
    const parsed = JSON.parse(outbox.resultJson) as unknown;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as SessionSnapshot)
      : null;
  } catch {
    return null;
  }
}

function parseStoredSnapshot(outbox: OutboxRecord): SessionSnapshot {
  if (outbox.resultJson === null) {
    throw new SessionPlaneDomainError(
      'internal.invariant-violation',
      `Outbox ${outbox.outboxId} has no stored terminal result`,
    );
  }
  try {
    return JSON.parse(outbox.resultJson) as SessionSnapshot;
  } catch (error) {
    throw new SessionPlaneDomainError(
      'internal.invariant-violation',
      `Outbox ${outbox.outboxId} has invalid stored result JSON`,
      error,
    );
  }
}

function throwUnexpectedSuccess(snapshot: SessionSnapshot): never {
  throw new SessionPlaneDomainError(
    'internal.invariant-violation',
    `Submission ${snapshot.sessionId}/${snapshot.generation} completed while handling a failure`,
  );
}

export async function resolveProviderAttachments(
  values: readonly string[],
  maxUploadFileBytes: number,
): Promise<readonly ProviderAttachment[]> {
  if (values.length > 20) {
    throw new SessionPlaneDomainError('input.invalid', 'At most 20 files may be attached');
  }
  const seen = new Set<string>();
  const attachments: ProviderAttachment[] = [];
  for (const value of values) {
    const absolutePath = path.resolve(value);
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(absolutePath);
    } catch (error) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        `Attachment does not exist: ${absolutePath}`,
        error,
      );
    }
    if (!stat.isFile()) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        `Attachment is not a regular file: ${absolutePath}`,
      );
    }
    if (stat.size <= 0 || stat.size > maxUploadFileBytes) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        `Attachment size must be from 1 to ${maxUploadFileBytes} bytes: ${absolutePath}`,
      );
    }
    attachments.push({
      path: absolutePath,
      name: path.basename(absolutePath),
      sizeBytes: stat.size,
      sha256: await hashFile(absolutePath),
      mediaType: mediaTypeForPath(absolutePath),
    });
  }
  return Object.freeze(attachments);
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function mediaTypeForPath(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case '.txt':
    case '.md':
    case '.log':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.zip':
      return 'application/zip';
    default:
      return null;
  }
}
