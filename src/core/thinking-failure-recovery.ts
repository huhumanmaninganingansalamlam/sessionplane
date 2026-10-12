import type { CoreMaintenance } from './maintenance.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderSubmissionError, type PreparationTarget } from '../providers/provider-adapter.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import { KeyedMutex } from '../scheduler/keyed-mutex.ts';
import { OutboxRepository, type OutboxRecord } from '../storage/outbox-repository.ts';
import { ReceiptRepository } from '../storage/receipt-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import type { SessionPlaneDatabase } from '../storage/database.ts';
import type { SubmissionService, FailureContinuation } from './submission-service.ts';
import type { SessionUiService } from './session-ui-service.ts';

/** One specialized opt-in chain, using the ordinary durable submission/preparation path. */
export class ThinkingFailureRecovery {
  readonly #outbox: OutboxRepository;
  readonly #sessions: SessionRepository;
  readonly #receipts: ReceiptRepository;
  readonly #mutex = new KeyedMutex();
  readonly #controller = new AbortController();
  readonly #pending = new Set<Promise<void>>();
  readonly services: { maintenance?: CoreMaintenance; database: SessionPlaneDatabase; submissions: SubmissionService; ui: SessionUiService };
  readonly now: () => number;
  constructor(services: ThinkingFailureRecovery['services'], now: () => number = Date.now) {
    this.services = services; this.now = now;
    this.#outbox = new OutboxRepository(services.database);
    this.#sessions = new SessionRepository(services.database.raw);
    this.#receipts = new ReceiptRepository(services.database);
  }

  observe(snapshot: SessionSnapshot, signal?: AbortSignal): Promise<void> {
    if (this.#controller.signal.aborted || this.#mutex.isBusy(snapshot.sessionId)) return Promise.resolve();
    const release = this.services.maintenance?.enter();
    if (this.services.maintenance && !release) return Promise.resolve();
    const operation = this.#mutex.runExclusive(snapshot.sessionId, async () => {
      try { await this.#continue(snapshot, AbortSignal.any([this.#controller.signal, ...(signal ? [signal] : [])])); }
      catch (error) {
        // Evidence/preparation uncertainty pauses this chain; never manufacture eligibility or replay.
        if (error instanceof Error && error.name === 'AbortError') return;
        const known = error instanceof SessionPlaneDomainError || error instanceof ProviderSubmissionError;
        const request = this.#outbox.getByGeneration(snapshot.sessionId, snapshot.generation);
        if (request) {
          const rootRequestRef = JSON.parse(request.payloadJson).failureContinuation?.rootRequestRef ?? request.outboxId;
          this.#receipts.execute({ clientId: request.clientId, requestId: `thinking-failure-paused:${rootRequestRef}`,
            method: 'session.thinking-failure.paused', payload: { rootRequestRef },
            operation: () => ({ state: 'paused', requestRef: request.outboxId,
              errorCode: known ? error.errorCode : 'provider.failure-unverified',
              message: known ? error.message : 'Automatic continuation inspection failed; preserve the request and inspect it' }) });
        }
      }
    });
    this.#pending.add(operation);
    void operation.finally(() => { this.#pending.delete(operation); release?.(); }).catch(() => undefined);
    return operation;
  }

  restore(): void {
    for (const request of this.#outbox.listByStates(['submitted', 'prepared'])) {
      const snapshot = this.#sessions.getSnapshot(request.sessionId);
      if (snapshot?.generation === request.generation && JSON.parse(request.payloadJson).thinkingFailureRecovery === true) {
        void this.observe(snapshot).catch(() => undefined);
      }
    }
  }

  async close() {
    this.#controller.abort();
    await Promise.allSettled([...this.#pending]);
  }

  async validateContinuation(snapshot: SessionSnapshot, continuation: FailureContinuation) {
    if (this.#controller.signal.aborted) throw new ProviderSubmissionError(
      'provider.preparation-required', 'Automatic continuation owner is closing; preserve the prepared request');
    const predecessor = this.#outbox.getById(continuation.failedRequestRef);
    const result = predecessor && this.#sessions.getGenerationResult(predecessor.sessionId, predecessor.generation);
    const configuration = predecessor && this.#receipts.get(predecessor.clientId, `thinking-failure-configuration:${predecessor.outboxId}`);
    if (!predecessor || predecessor.sessionId !== snapshot.sessionId || predecessor.generation !== snapshot.generation - 1 ||
        result?.reason !== 'thinking-failed-reconciled' || result.errorCode !== 'provider.execution-failed' ||
        !result.promptSubmitted || result.submissionState !== 'submitted' || !configuration ||
        continuation.deadlineAt !== this.#sessions.getSession(snapshot.sessionId)?.deadlineAt ||
        Date.parse(continuation.deadlineAt) <= this.now()) {
      throw new ProviderSubmissionError('provider.preparation-required', 'Preserved failed predecessor/deadline/configuration proof is unavailable');
    }
    try {
      await this.services.ui.verifyFailureContinuation(snapshot, { ...snapshot, ...result }, JSON.parse(configuration.resultJson).model);
    } catch (error) {
      if (!(error instanceof SessionPlaneDomainError)) throw error;
      throw new ProviderSubmissionError('provider.preparation-required', error.message);
    }
  }

  async #continue(snapshot: SessionSnapshot, signal: AbortSignal) {
    const request = this.#outbox.getByGeneration(snapshot.sessionId, snapshot.generation);
    if (!request || snapshot.provider !== 'chatgpt' || signal.aborted) return;
    const payload = JSON.parse(request.payloadJson);
    if (payload.thinkingFailureRecovery !== true) return;
    const rootRequestRef = payload.failureContinuation?.rootRequestRef ?? request.outboxId;
    if (this.#receipts.get(request.clientId, `thinking-failure-paused:${rootRequestRef}`)) return;
    if (snapshot.submissionState === 'prepared' && payload.failureContinuation) {
      await this.#prepare(request, payload.failureContinuation);
      return;
    }
    if (snapshot.submissionState !== 'submitted' || !snapshot.promptSubmitted ||
        (!snapshot.terminal && snapshot.errorCode !== 'provider.actionable-alert') ||
        (snapshot.terminal && snapshot.reason !== 'thinking-failed-reconciled')) return;
    const configuration = this.#receipts.get(request.clientId, `thinking-failure-configuration:${request.outboxId}`);
    if (!configuration) throw new SessionPlaneDomainError('provider.failure-unverified',
      'Preserved combined model/version/effort evidence is unavailable');
    const deadlineAt = this.#sessions.getSession(snapshot.sessionId)!.deadlineAt;
    if (!deadlineAt || Date.parse(deadlineAt) <= this.now()) throw new SessionPlaneDomainError(
      'session.deadline-expired', 'Automatic Thinking-failed continuation reached its original deadline');
    const decisionId = `thinking-failure-reconcile:${request.outboxId}`;
    if (!snapshot.terminal) await this.services.ui.reconcileFailure({ ...owner(request), decisionId });
    const failed = this.#sessions.getSnapshot(snapshot.sessionId)!;
    if (failed.generation !== snapshot.generation || failed.reason !== 'thinking-failed-reconciled' || !failed.terminal) return;
    const attempt = (payload.failureContinuation?.attempt ?? 0) + 1;
    // Back off only after an actual reconciled failure, anchored to its durable completion time.
    const completedAt = this.#sessions.getGenerationResult(snapshot.sessionId, snapshot.generation)!.completedAt!;
    const notBefore = Date.parse(completedAt) + Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6));
    await delay(Math.max(0, notBefore - this.now()), undefined, { signal });
    if (signal.aborted || this.#sessions.getSnapshot(snapshot.sessionId)!.generation !== failed.generation) return;
    if (Date.parse(deadlineAt) <= this.now()) throw new SessionPlaneDomainError(
      'session.deadline-expired', 'Automatic Thinking-failed continuation reached its original deadline');
    const model: PreparationTarget = JSON.parse(configuration.resultJson).model;
    // Reinspect after backoff: manual follow-up/final/active generation/draft wins over automation.
    await this.services.submissions.inspectSubmission(owner(request), async current => {
      await this.services.ui.verifyFailureContinuation(current, failed, model);
    });
    const continuation: FailureContinuation = { rootRequestRef: payload.failureContinuation?.rootRequestRef ?? request.outboxId,
      failedRequestRef: request.outboxId, attempt, deadlineAt };
    const requestId = `thinking-failure-continue:${request.outboxId}`;
    try {
      await this.services.submissions.send({ clientId: request.clientId, requestId, sessionId: request.sessionId,
        expectedGeneration: request.generation, prompt: '계속', model: payload.model, effort: payload.effort,
        surface: payload.surface, sessionDeadlineSec: payload.sessionDeadlineSec,
        thinkingFailureRecovery: true, failureContinuation: continuation });
    } catch (error) {
      if (!(error instanceof SessionPlaneDomainError) || error.errorCode !== 'provider.preparation-required') throw error;
    }
    const child = this.#outbox.getByRequest(request.clientId, requestId)!;
    if (child.submissionState === 'prepared') await this.#prepare(child, continuation);
    else if (child.submissionState !== 'submitted') throw new SessionPlaneDomainError(
      child.errorCode ?? 'provider.failure-unverified', 'Continuation submission is not confirmed; inspect the saved successor without resending');
  }

  async #prepare(request: OutboxRecord, continuation: FailureContinuation) {
    if (this.#controller.signal.aborted) return;
    if (Date.parse(continuation.deadlineAt) <= this.now()) throw new SessionPlaneDomainError(
      'session.deadline-expired', 'Automatic continuation preparation reached its original deadline');
    const predecessor = this.#outbox.getById(continuation.failedRequestRef)!;
    const configuration = this.#receipts.get(predecessor.clientId, `thinking-failure-configuration:${predecessor.outboxId}`);
    if (!configuration) throw new SessionPlaneDomainError('provider.failure-unverified',
      'Preserved continuation configuration evidence is unavailable');
    await this.validateContinuation(this.#sessions.getSnapshot(request.sessionId)!, continuation);
    await this.services.ui.prepareFailureContinuation(owner(request), JSON.parse(configuration.resultJson).model);
  }
}

function owner(request: OutboxRecord) {
  return { clientId: request.clientId, requestId: request.requestId, sessionId: request.sessionId, generation: request.generation };
}
