import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
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
  type PreparationChoices,
  type PreparationPurpose,
  type PreparationTarget,
} from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionActor } from '../scheduler/session-actor.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { EventRepository } from '../storage/event-repository.ts';
import {
  OutboxRepository,
  type OutboxRecord,
  type OutboxState,
} from '../storage/outbox-repository.ts';
import { hashCanonical } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import type { TeamDirectory } from './team-directory.ts';

export interface SessionSendInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly sessionId?: string;
  readonly teamId?: string;
  readonly roleKey?: string;
  readonly prompt: string;
  readonly model?: string | null;
  readonly effort?: string | null;
  readonly surface?: string | null;
  readonly files?: readonly string[];
  readonly sessionDeadlineSec: number;
}

interface PendingPreparation {
  readonly kind: 'pending-preparation';
  readonly choices: PreparationChoices;
  readonly requiresInspection?: boolean;
}


interface StoredOutboxPayload {
  readonly prompt: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly surface: string | null;
  readonly sessionDeadlineSec: number;
  readonly attachments: readonly ProviderAttachment[];
}

interface PreparedOutbox {
  readonly outbox: OutboxRecord;
  readonly snapshot: SessionSnapshot;
  readonly eventSequence: number;
}

const PROVIDER_STAGE_TIMEOUT_MS = 120_000;

export class SubmissionService {
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
  readonly #requestTails = new Map<string, Promise<void>>();

  constructor(options: {
    readonly database: SessionPlaneDatabase;
    readonly directory: TeamDirectory;
    readonly scheduler: ActorScheduler;
    readonly pageMutex: PageMutationMutex;
    readonly adapters: ProviderAdapterRegistry;
    readonly maxUploadFileBytes?: number;
    readonly onSubmitted?: (snapshot: SessionSnapshot) => void;
    readonly onSubmissionUnknown?: (snapshot: SessionSnapshot) => void;
    readonly now?: () => Date;
  }) {
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

  async recoverAcknowledgement(snapshot: SessionSnapshot): Promise<SessionSnapshot> {
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
        const acknowledgement = await adapter.recoverAcknowledgement?.({
          session: current,
          generation: current.generation,
          prompt: currentPrompt,
        });
        if (
          acknowledgement === undefined ||
          acknowledgement === null ||
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
    };
    const requestHash = hashCanonical({ method: 'session.send', payload });
    const requestKey = JSON.stringify([input.clientId, input.requestId]);
    return await this.#runRequestExclusive(requestKey, async () => {
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

    const prepared = this.#prepareOutbox(
      actor,
      sessionId,
      input,
      payload,
      requestHash,
    );
    return await this.#runPreparedSubmission(actor, prepared, input, attachments);
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
      const adapter = this.#adapters.require(prepared.snapshot.provider);
      submission = await adapter.openSubmission({
        session: prepared.snapshot,
        generation: prepared.snapshot.generation,
        prompt: input.prompt,
        model: normalizeOptional(input.model),
        effort: normalizeOptional(input.effort),
        surface: normalizeOptional(input.surface),
        attachments,
      });
    } catch (error) {
      return await this.#failPreSubmit(actor, prepared.outbox, error);
    }

    this.#persistPageKey(actor, prepared.outbox, submission.pageKey);
    return await this.#pageMutex.runExclusive(submission.pageKey, async () => {
      const stageTimeoutMs = Math.min(PROVIDER_STAGE_TIMEOUT_MS, input.sessionDeadlineSec * 1_000);
      try {
        await withProviderStageTimeout(
          submission.prepare(choices),
          stageTimeoutMs,
          () => submission.abandon(),
        );
      } catch (error) {
        if (error instanceof ProviderSubmissionError && error.errorCode === 'provider.preparation-required') {
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
    return await this.#runRequestExclusive(requestKey, async () => {
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
      const payload = parseOutboxPayload(initial);
      const attachments = await resolveProviderAttachments(
        payload.attachments.map((attachment) => attachment.path),
        this.#maxUploadFileBytes,
      );
      if (hashCanonical(attachments) !== hashCanonical(payload.attachments)) {
        throw new SessionPlaneDomainError('input.idempotency-conflict', 'An attachment changed while preparation was pending');
      }
      const actor = this.#scheduler.actorFor(initial.sessionId);
      return await actor.enqueue(async () =>
        await this.#resumePreparationLocked(actor, input, attachments),
      );
    });
  }

  async #resumePreparationLocked(
    actor: SessionActor,
    input: { readonly clientId: string; readonly requestId: string; readonly sessionId: string; readonly generation: number },
    attachments: readonly ProviderAttachment[],
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
    observe: (snapshot: SessionSnapshot) => Promise<Result>,
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
    return await actor.enqueue(async () => {
      const { outbox, snapshot } = requireOwner();
      const requested = parseOutboxPayload(outbox);
      const result = {
        requestId: outbox.requestId,
        snapshot,
        requested: { prompt: requested.prompt, model: requested.model, effort: requested.effort },
      };
      if (snapshot.pageKey === null) return { ...result, evidence: null };
      return await this.#pageMutex.runExclusive(snapshot.pageKey, async () => ({
        ...result, evidence: await observe(snapshot),
      }));
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
      const payload = parseOutboxPayload(pending);
      const adapter = this.#adapters.require(snapshot.provider);
      const submission = await adapter.openSubmission({
        session: snapshot,
        generation: snapshot.generation,
        prompt: payload.prompt,
        model: payload.model,
        effort: payload.effort,
        surface: payload.surface,
        attachments: payload.attachments,
      });
      if (submission.provider !== 'chatgpt' || submission.prepareForObservation === undefined) {
        throw new SessionPlaneDomainError('capability.unsupported', 'Provider cannot inspect assisted preparation state');
      }
      if (snapshot.pageKey !== submission.pageKey) {
        snapshot = this.#persistPageKey(actor, pending, submission.pageKey);
      }
      const pageKey = submission.pageKey;
      return await this.#pageMutex.runExclusive(pageKey, async () => {
        this.#requirePreparationOwner(input);
        await submission.prepareForObservation?.();
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
    readonly decision: 'choose' | 'reveal' | 'cancel';
    readonly purpose?: PreparationPurpose;
    readonly snapshotId?: string;
    readonly ref?: string;
    readonly value?: number | undefined;
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
      const initial = this.#requirePreparationOwner(input);
      const initialSnapshot = this.#requireSnapshot(input.sessionId);
      const pageKey = initialSnapshot.pageKey;
      if (pageKey === null) throw new SessionPlaneDomainError('browser.unavailable', 'Exact preparation page is unavailable');
      return await this.#pageMutex.runExclusive(pageKey, async () => {
        const current = this.#requirePreparationOwner(input);
        const snapshot = this.#requireSnapshot(input.sessionId);
        if (snapshot.pageKey !== pageKey) throw new SessionPlaneDomainError('session.generation-superseded', 'Preparation page changed before decision');
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
          if (input.purpose === undefined || input.snapshotId === undefined || input.ref === undefined || operation === undefined) {
            throw new SessionPlaneDomainError('input.invalid', 'Choosing a target requires purpose, snapshotId, ref, and a decision handler');
          }
          const selected = await operation(snapshot, parseOutboxPayload(current));
          if (input.decision === 'choose' && selected.choice?.purpose !== input.purpose) {
            throw new SessionPlaneDomainError('input.invalid', 'Preparation purpose does not match the observed choice');
          }
          if (input.decision === 'reveal' && selected.choice !== null) {
            throw new SessionPlaneDomainError('internal.invariant-violation', 'Revealing choices cannot record a selected value');
          }
          this.#requirePreparationOwner(input);
          if (selected.choice !== null) {
            const state = parsePreparationState(current);
            choices = { ...state.choices, [selected.choice.purpose]: selected.choice };
          }
          result = selected.result;
        }

        let eventSequence = 0;
        this.#database.transaction(() => {
          if (input.decision === 'choose') {
            if (choices === null) throw new SessionPlaneDomainError('internal.invariant-violation', 'A choice must store its selected target');
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

  async #recordPreparationRequired(actor: SessionActor, outbox: OutboxRecord, cause: unknown): Promise<SessionSnapshot> {
    const classified = classifyPreSubmitError(cause);
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    const state = {
      kind: 'pending-preparation',
      choices: parsePreparationState(outbox).choices,
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
          reason: 'agent-preparation-required',
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
    throw new SessionPlaneDomainError(
      'provider.preparation-required',
      'Provider UI needs a caller decision before the same request can continue',
      { promptSubmitted: false, requestId: outbox.requestId, sessionId: outbox.sessionId, generation: outbox.generation, snapshot },
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

  #prepareOutbox(
    actor: SessionActor,
    sessionId: string,
    input: SessionSendInput,
    payload: Readonly<Record<string, unknown>>,
    requestHash: string,
  ): PreparedOutbox {
    let outbox!: OutboxRecord;
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const session = this.#sessions.getSession(sessionId);
      if (session === null) {
        throw new SessionPlaneDomainError('input.session-not-found', `Unknown session: ${sessionId}`);
      }
      if (!['created', 'ready', 'complete'].includes(session.sessionState)) {
        throw new SessionPlaneDomainError(
          'session.busy',
          `Session ${sessionId} already has active generation ${session.currentGeneration}`,
        );
      }
      const team = this.#directory.getTeam(session.teamId);
      const generation = session.currentGeneration + 1;
      const timestamp = this.#now().toISOString();
      const deadlineAt = new Date(
        this.#now().getTime() + input.sessionDeadlineSec * 1_000,
      ).toISOString();
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
            resultJson: JSON.stringify(snapshot),
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

  async #runRequestExclusive<Result>(
    requestKey: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#requestTails.get(requestKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#requestTails.set(requestKey, tail);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#requestTails.get(requestKey) === tail) {
        this.#requestTails.delete(requestKey);
      }
    }
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
  const attachments = value.attachments;
  if (
    typeof value.prompt !== 'string' ||
    !(value.model === null || typeof value.model === 'string') ||
    !(value.effort === null || typeof value.effort === 'string') ||
    !(value.surface === null || typeof value.surface === 'string') ||
    !Number.isSafeInteger(value.sessionDeadlineSec) ||
    !Array.isArray(attachments) ||
    !attachments.every((item) => item !== null && typeof item === 'object' &&
      typeof (item as Record<string, unknown>).path === 'string' &&
      typeof (item as Record<string, unknown>).name === 'string' &&
      Number.isSafeInteger((item as Record<string, unknown>).sizeBytes) &&
      typeof (item as Record<string, unknown>).sha256 === 'string')
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
