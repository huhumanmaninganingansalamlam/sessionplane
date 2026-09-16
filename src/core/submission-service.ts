import { createHash } from 'node:crypto';

import type { PageMutationMutex } from '../browser/page-mutex.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { CurrentGenerationUpdate } from '../domain/generation.ts';
import { isTerminalSessionState, type SessionSnapshot } from '../domain/session.ts';
import {
  ProviderSubmissionError,
  type ProviderAdapterRegistry,
  type ProviderSubmission,
  type ProviderSubmissionAcknowledgement,
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
  readonly sessionDeadlineSec: number;
}

interface PreparedOutbox {
  readonly outbox: OutboxRecord;
  readonly snapshot: SessionSnapshot;
  readonly eventSequence: number;
}

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
  readonly #requestTails = new Map<string, Promise<void>>();

  constructor(options: {
    readonly database: SessionPlaneDatabase;
    readonly directory: TeamDirectory;
    readonly scheduler: ActorScheduler;
    readonly pageMutex: PageMutationMutex;
    readonly adapters: ProviderAdapterRegistry;
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
    this.#now = options.now ?? (() => new Date());
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

  async send(input: SessionSendInput): Promise<SessionSnapshot> {
    const prompt = validatePrompt(input.prompt);
    const model = normalizeOptional(input.model);
    const payload = {
      selector:
        input.sessionId === undefined
          ? { teamId: input.teamId, roleKey: input.roleKey }
          : { sessionId: input.sessionId },
      prompt,
      model,
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
        return await actor.enqueue(async () =>
          await this.#replay(actor, this.#outbox.requireById(existing.outboxId)),
        );
      }

      const selected = this.#resolveSession(input);
      const actor = this.#scheduler.actorFor(selected.sessionId);
      return await actor.enqueue(async () =>
        await this.#sendLocked(actor, selected.sessionId, input, payload, requestHash),
      );
    });
  }

  async #sendLocked(
    actor: SessionActor,
    sessionId: string,
    input: SessionSendInput,
    payload: Readonly<Record<string, unknown>>,
    requestHash: string,
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
    let submission: ProviderSubmission;
    try {
      const adapter = this.#adapters.require(prepared.snapshot.provider);
      submission = await adapter.openSubmission({
        session: prepared.snapshot,
        generation: prepared.snapshot.generation,
        prompt: input.prompt,
        model: normalizeOptional(input.model),
      });
    } catch (error) {
      return await this.#failPreSubmit(actor, prepared.outbox, error);
    }

    this.#persistPageKey(actor, prepared.outbox, submission.pageKey);
    return await this.#pageMutex.runExclusive(submission.pageKey, async () => {
      try {
        await submission.prepare();
      } catch (error) {
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
        { promptSubmitted: false },
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
        await submission.submitOnce();
      } catch (error) {
        submitError = error;
      }

      let acknowledgement: ProviderSubmissionAcknowledgement | null = null;
      try {
        acknowledgement = await submission.captureAcknowledgement();
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
      promptSubmitted: false,
      snapshot,
    });
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

function classifyPreSubmitError(error: unknown): { readonly errorCode: string; readonly message: string } {
  if (error instanceof ProviderSubmissionError) {
    return { errorCode: error.errorCode, message: error.message };
  }
  if (error instanceof SessionPlaneDomainError) {
    return { errorCode: error.errorCode, message: error.message };
  }
  return {
    errorCode: 'browser.unavailable',
    message: error instanceof Error ? error.message : 'Provider preparation failed',
  };
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

