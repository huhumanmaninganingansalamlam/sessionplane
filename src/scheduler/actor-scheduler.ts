import type { CurrentGenerationUpdate } from '../domain/generation.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import { ActorRegistry } from '../core/actor-registry.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { EventRepository } from '../storage/event-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import {
  SessionActor,
  type SessionWaitOptions,
  type SessionWaitSnapshot,
} from './session-actor.ts';

export interface StartGenerationInput {
  readonly sessionId: string;
  readonly expectedGeneration?: number;
  readonly teamBriefVersion: number;
  readonly promptHash: string;
  readonly deadlineAt?: string | null;
}

export class ActorScheduler {
  readonly #database: SessionPlaneDatabase;
  readonly #sessions: SessionRepository;
  readonly #events: EventRepository;
  readonly #actors = new ActorRegistry<SessionActor>();
  readonly #now: () => Date;

  constructor(database: SessionPlaneDatabase, options: { readonly now?: () => Date } = {}) {
    this.#database = database;
    this.#sessions = new SessionRepository(database.raw);
    this.#events = new EventRepository(database.raw);
    this.#now = options.now ?? (() => new Date());
  }

  get actorCount(): number {
    return this.#actors.size;
  }

  get totalQueueDepth(): number {
    let total = 0;
    for (const [, actor] of this.#actors.entries()) {
      total += actor.queueDepth;
    }
    return total;
  }

  get totalSubscriberCount(): number {
    let total = 0;
    for (const [, actor] of this.#actors.entries()) {
      total += actor.subscriberCount;
    }
    return total;
  }

  restore(): number {
    for (const sessionId of this.#sessions.listNonterminalSessionIds()) {
      this.actorFor(sessionId);
    }
    return this.#actors.size;
  }

  actorFor(sessionId: string): SessionActor {
    return this.#actors.getOrCreate(sessionId, () => {
      const snapshot = this.#requireSnapshot(sessionId);
      return new SessionActor(snapshot, this.#events.latestSequenceForSession(sessionId));
    });
  }

  waitSession(sessionId: string, options: SessionWaitOptions): Promise<SessionWaitSnapshot> {
    return this.actorFor(sessionId).wait(options);
  }

  async startGeneration(input: StartGenerationInput): Promise<SessionSnapshot> {
    const actor = this.actorFor(input.sessionId);
    return await actor.enqueue(() => {
      let eventSequence = 0;
      this.#database.transaction(() => {
        const session = this.#sessions.getSession(input.sessionId);
        if (session === null) {
          throw new SessionPlaneDomainError(
            'input.session-not-found',
            `Unknown session: ${input.sessionId}`,
          );
        }
        if (
          input.expectedGeneration !== undefined &&
          input.expectedGeneration !== session.currentGeneration
        ) {
          throw new SessionPlaneDomainError(
            'session.generation-superseded',
            `Expected generation ${input.expectedGeneration}; current generation is ${session.currentGeneration}`,
          );
        }
        if (['cancelled', 'superseded', 'failed'].includes(session.sessionState)) {
          throw new SessionPlaneDomainError(
            'input.invalid',
            `Cannot start a generation in ${session.sessionState} session ${session.sessionId}`,
          );
        }

        const generation = session.currentGeneration + 1;
        const timestamp = this.#now().toISOString();
        this.#sessions.insertGeneration({
          sessionId: session.sessionId,
          generation,
          teamBriefVersion: input.teamBriefVersion,
          promptHash: input.promptHash,
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
        const advanced = this.#sessions.advanceGeneration({
          sessionId: session.sessionId,
          expectedGeneration: session.currentGeneration,
          nextGeneration: generation,
          deadlineAt: input.deadlineAt ?? null,
          updatedAt: timestamp,
        });
        if (!advanced) {
          throw new SessionPlaneDomainError(
            'session.generation-superseded',
            `Generation changed while starting work for session ${session.sessionId}`,
          );
        }
        eventSequence = this.#events.append({
          teamId: session.teamId,
          roleId: session.roleId,
          sessionId: session.sessionId,
          generation,
          eventType: 'generation.started',
          payload: { teamBriefVersion: input.teamBriefVersion },
          createdAt: timestamp,
        });
      });

      const snapshot = this.#requireSnapshot(input.sessionId);
      actor.publish(snapshot, eventSequence);
      return snapshot;
    });
  }

  async updateGeneration(
    sessionId: string,
    generation: number,
    update: CurrentGenerationUpdate,
    eventType = 'generation.updated',
  ): Promise<SessionSnapshot> {
    const actor = this.actorFor(sessionId);
    return await actor.enqueue(() => {
      const previous = this.#requireSnapshot(sessionId);
      if (previous.generation !== generation) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Generation ${generation} is stale; current generation is ${previous.generation}`,
        );
      }
      if (
        previous.terminal &&
        update.sessionState !== undefined &&
        update.sessionState !== previous.sessionState
      ) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          'A terminal generation cannot be changed in place',
        );
      }

      let eventSequence = 0;
      this.#database.transaction(() => {
        const timestamp = this.#now().toISOString();
        const updated = this.#sessions.updateCurrentGeneration(
          sessionId,
          generation,
          update,
          timestamp,
        );
        if (!updated) {
          throw new SessionPlaneDomainError(
            'session.generation-superseded',
            `Generation ${generation} is no longer current for session ${sessionId}`,
          );
        }
        const session = this.#sessions.getSession(sessionId);
        if (session === null) {
          throw new SessionPlaneDomainError('input.session-not-found', `Unknown session: ${sessionId}`);
        }
        eventSequence = this.#events.append({
          teamId: session.teamId,
          roleId: session.roleId,
          sessionId,
          generation,
          eventType,
          payload: summarizeUpdate(update),
          createdAt: timestamp,
        });
      });

      const snapshot = this.#requireSnapshot(sessionId);
      actor.publish(snapshot, eventSequence);
      return snapshot;
    });
  }

  close(): void {
    for (const [, actor] of this.#actors.entries()) {
      actor.close();
    }
  }

  #requireSnapshot(sessionId: string): SessionSnapshot {
    const snapshot = this.#sessions.getSnapshot(sessionId);
    if (snapshot === null) {
      throw new SessionPlaneDomainError('input.session-not-found', `Unknown session: ${sessionId}`);
    }
    return snapshot;
  }
}

function summarizeUpdate(update: CurrentGenerationUpdate): Readonly<Record<string, unknown>> {
  return {
    ...(update.sessionState === undefined ? {} : { sessionState: update.sessionState }),
    ...(update.providerState === undefined ? {} : { providerState: update.providerState }),
    ...(update.observationTransport === undefined
      ? {}
      : { observationTransport: update.observationTransport }),
    ...(update.submissionState === undefined
      ? {}
      : { submissionState: update.submissionState }),
    hasConversationId: update.conversationId !== undefined && update.conversationId !== null,
    hasSubmittedUserMessageId:
      update.submittedUserMessageId !== undefined && update.submittedUserMessageId !== null,
    hasResponseMessageId: update.responseMessageId !== undefined && update.responseMessageId !== null,
    hasAnswer: update.answerText !== undefined && update.answerText !== null,
  };
}

