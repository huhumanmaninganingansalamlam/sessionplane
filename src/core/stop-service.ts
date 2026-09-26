import type { PageMutationMutex } from '../browser/page-mutex.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import type { ProviderAdapterRegistry } from '../providers/provider-adapter.ts';
import type { ActorScheduler } from '../scheduler/actor-scheduler.ts';
import type { SessionActor } from '../scheduler/session-actor.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import { EventRepository } from '../storage/event-repository.ts';
import { hashCanonical } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import type { TeamDirectory } from './team-directory.ts';

export interface SessionStopInput {
  readonly clientId: string;
  readonly requestId: string;
  readonly expectedGeneration?: number;
  readonly sessionId?: string;
  readonly teamId?: string;
  readonly roleKey?: string;
}

function parseSnapshot(value: string): SessionSnapshot {
  try {
    return JSON.parse(value) as SessionSnapshot;
  } catch (error) {
    throw new SessionPlaneDomainError(
      'internal.invariant-violation',
      'Stored stop receipt is not valid JSON',
      error,
    );
  }
}

interface StopReceiptRow {
  readonly method: string;
  readonly requestHash: string;
  readonly status: string;
  readonly resultJson: string;
}

export class StopService {
  readonly #database: SessionPlaneDatabase;
  readonly #directory: TeamDirectory;
  readonly #scheduler: ActorScheduler;
  readonly #pageMutex: PageMutationMutex;
  readonly #adapters: ProviderAdapterRegistry;
  readonly #sessions: SessionRepository;
  readonly #events: EventRepository;
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
    this.#now = options.now ?? (() => new Date());
  }

  async stop(input: SessionStopInput): Promise<SessionSnapshot> {
    const payload = {
      ...(input.expectedGeneration === undefined ? {} : { expectedGeneration: input.expectedGeneration }),
      selector:
        input.sessionId === undefined
          ? { teamId: input.teamId, roleKey: input.roleKey }
          : { sessionId: input.sessionId },
    };
    const requestHash = hashCanonical({ method: 'session.stop', payload });
    const requestKey = JSON.stringify([input.clientId, input.requestId]);
    return await this.#runRequestExclusive(requestKey, async () => {
      const existing = this.#getReceipt(input.clientId, input.requestId);
      if (existing !== null) {
        this.#assertReceipt(existing, input.clientId, input.requestId, requestHash);
        const snapshot = parseSnapshot(existing.resultJson);
        const actor = this.#scheduler.actorFor(snapshot.sessionId);
        return await actor.enqueue(() => this.#replay(existing, snapshot));
      }

      const selected = this.#resolveSession(input);
      const actor = this.#scheduler.actorFor(selected.sessionId);
      return await actor.enqueue(() =>
        this.#stopLocked(actor, selected.sessionId, input, requestHash),
      );
    });
  }

  async #stopLocked(
    actor: SessionActor,
    sessionId: string,
    input: SessionStopInput,
    requestHash: string,
  ): Promise<SessionSnapshot> {
    const current = this.#requireSnapshot(sessionId);
    if (input.expectedGeneration !== undefined && current.generation !== input.expectedGeneration) {
      throw new SessionPlaneDomainError('session.generation-superseded', 'Stop request belongs to an older generation');
    }
    if (current.terminal) {
      this.#storeCompleteReceipt(input, requestHash, current);
      return current;
    }
    if (current.generation <= 0) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        `Session ${sessionId} has no active generation to stop`,
      );
    }

    const adapter = this.#adapters.require(current.provider);
    const operation = await adapter.openStop({
      session: current,
      generation: current.generation,
    });
    return await this.#pageMutex.runExclusive(operation.pageKey, async () => {
      const available = await operation.prepare();
      if (!available) {
        const refreshed = this.#requireSnapshot(sessionId);
        this.#storeCompleteReceipt(input, requestHash, refreshed);
        return refreshed;
      }

      this.#storeAttemptedReceipt(input, requestHash, current);
      try {
        await operation.stopOnce();
      } catch (error) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          'Stop mutation outcome is unknown and automatic retry is forbidden',
          {
            mutation: 'session.stop',
            outcome: 'unknown',
            automaticRetry: false,
            snapshot: current,
            causeType: error instanceof Error ? error.name : typeof error,
          },
        );
      }

      return this.#completeStop(actor, current, input);
    });
  }

  #completeStop(
    actor: SessionActor,
    current: SessionSnapshot,
    input: SessionStopInput,
  ): SessionSnapshot {
    let snapshot!: SessionSnapshot;
    let eventSequence = 0;
    this.#database.transaction(() => {
      const timestamp = this.#now().toISOString();
      if (
        !this.#sessions.updateCurrentGeneration(
          current.sessionId,
          current.generation,
          {
            sessionState: 'cancelled',
            providerState: 'stopped',
            observationTransport: 'fresh',
            completedAt: timestamp,
            nextCheckAt: null,
            reason: 'explicit-stop',
            errorCode: 'provider.response-stopped',
          },
          timestamp,
        )
      ) {
        throw new SessionPlaneDomainError(
          'session.generation-superseded',
          `Generation ${current.generation} is no longer current`,
        );
      }
      snapshot = this.#requireSnapshot(current.sessionId);
      eventSequence = this.#events.append({
        teamId: snapshot.teamId,
        roleId: snapshot.roleId,
        sessionId: snapshot.sessionId,
        generation: snapshot.generation,
        eventType: 'generation.stopped',
        payload: { providerState: 'stopped' },
        createdAt: timestamp,
      });
      const updated = this.#database.raw
        .prepare(`
          UPDATE request_receipts
          SET status = 'complete', result_json = ?, updated_at = ?
          WHERE client_id = ? AND request_id = ?
            AND method = 'session.stop' AND status = 'attempted'
        `)
        .run(
          JSON.stringify(snapshot),
          timestamp,
          input.clientId,
          input.requestId,
        );
      if (Number(updated.changes) !== 1) {
        throw new SessionPlaneDomainError(
          'internal.invariant-violation',
          'Stop receipt could not be completed',
        );
      }
    });
    actor.publish(snapshot, eventSequence);
    return snapshot;
  }

  #replay(receipt: StopReceiptRow, snapshot: SessionSnapshot): SessionSnapshot {
    if (receipt.status === 'complete') {
      return snapshot;
    }
    throw new SessionPlaneDomainError(
      'internal.invariant-violation',
      'The original stop request has an ambiguous outcome and will not be repeated',
      {
        mutation: 'session.stop',
        outcome: 'unknown',
        automaticRetry: false,
        snapshot,
      },
    );
  }

  #resolveSession(input: SessionStopInput): SessionSnapshot {
    if (input.sessionId !== undefined) {
      return this.#directory.getSession(input.sessionId);
    }
    if (input.teamId === undefined || input.roleKey === undefined) {
      throw new SessionPlaneDomainError(
        'input.invalid',
        'session.stop requires either sessionId or teamId + roleKey',
      );
    }
    return this.#directory.getCurrentSession(input.teamId, input.roleKey);
  }

  #getReceipt(clientId: string, requestId: string): StopReceiptRow | null {
    const row = this.#database.raw
      .prepare(`
        SELECT method, request_hash AS requestHash, status, result_json AS resultJson
        FROM request_receipts
        WHERE client_id = ? AND request_id = ?
      `)
      .get(clientId, requestId) as StopReceiptRow | undefined;
    return row ?? null;
  }

  #assertReceipt(
    receipt: StopReceiptRow,
    clientId: string,
    requestId: string,
    requestHash: string,
  ): void {
    if (receipt.method !== 'session.stop' || receipt.requestHash !== requestHash) {
      throw new SessionPlaneDomainError(
        'input.idempotency-conflict',
        `Request ${clientId}/${requestId} was already used with different input`,
      );
    }
  }

  #storeAttemptedReceipt(
    input: SessionStopInput,
    requestHash: string,
    snapshot: SessionSnapshot,
  ): void {
    const timestamp = this.#now().toISOString();
    this.#database.raw
      .prepare(`
        INSERT INTO request_receipts(
          client_id, request_id, method, result_json, created_at,
          request_hash, status, updated_at
        ) VALUES (?, ?, 'session.stop', ?, ?, ?, 'attempted', ?)
      `)
      .run(
        input.clientId,
        input.requestId,
        JSON.stringify(snapshot),
        timestamp,
        requestHash,
        timestamp,
      );
  }

  #storeCompleteReceipt(
    input: SessionStopInput,
    requestHash: string,
    snapshot: SessionSnapshot,
  ): void {
    const timestamp = this.#now().toISOString();
    this.#database.raw
      .prepare(`
        INSERT INTO request_receipts(
          client_id, request_id, method, result_json, created_at,
          request_hash, status, updated_at
        ) VALUES (?, ?, 'session.stop', ?, ?, ?, 'complete', ?)
      `)
      .run(
        input.clientId,
        input.requestId,
        JSON.stringify(snapshot),
        timestamp,
        requestHash,
        timestamp,
      );
  }

  #requireSnapshot(sessionId: string): SessionSnapshot {
    const snapshot = this.#sessions.getSnapshot(sessionId);
    if (snapshot === null) {
      throw new SessionPlaneDomainError('input.session-not-found', `Unknown session: ${sessionId}`);
    }
    return snapshot;
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
}
