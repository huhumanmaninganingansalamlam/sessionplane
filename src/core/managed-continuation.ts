import type { DurableTaskKernel } from './durable-task-kernel.ts';
import type { KernelStores, TimerRecord } from '../storage/kernel/create-kernel-stores.ts';
import { activateContinuation, resumeAfterAgentDecision } from './continuation/continuation-effects.ts';
import { runContinuationTick } from './continuation/continuation-scheduler.ts';
import type { ContinuationServices, ContinuationReviewReport, ContinuationAgentReviewInput } from './continuation/continuation-services.ts';
export { CONTINUATION_INTERVAL_MS, CONTINUATION_READ_RETRY_MIN_MS, CONTINUATION_DUE_READ_RESERVATION_MS } from './continuation/continuation-policy.ts';
export type { ContinuationReviewReport } from './continuation/continuation-services.ts';

/** Core-owned lifecycle only; scheduling/observations/effects have separate explicit ownership. */
export class ManagedContinuationService {
  readonly #services: ContinuationServices;
  readonly #canRun: () => boolean;
  #interval: ReturnType<typeof setInterval> | null = null;
  #active: Promise<ContinuationReviewReport> | null = null;
  #closed = false;

constructor(input: {
    repository: Pick<KernelStores, 'projects' | 'tasks' | 'attempts' | 'timers' | 'scans'>;
    kernel: DurableTaskKernel;
    now?: () => Date;
    canRun?: () => boolean;
    bindAttempt?: (input: {
      taskId: string; clientId: string; attemptId: string; sourceAttemptId: string;
    }) => void | Promise<void>;
    bindInitialAttempt?: (input: {
      taskId: string; clientId: string; attemptId: string;
    }) => void | Promise<void>;
    bindRootAttempt?: (input: {
      taskId: string; clientId: string; attemptId: string;
    }) => void | Promise<void>;
    inspectModelIntent?: (input: {
      taskId: string; clientId: string; attemptId: string; modelIntent: string;
    }) => boolean | Promise<boolean>;
    preparePublicTask?: () => Promise<void>;
    requestAgentReview?: (input: ContinuationAgentReviewInput) => Promise<void>;
  }) {
    this.#services = {
      repository: input.repository, kernel: input.kernel,
      now: input.now ?? (() => new Date()),
      bindAttempt: input.bindAttempt ?? (() => undefined),
      ...(input.bindInitialAttempt ? { bindInitialAttempt: input.bindInitialAttempt } : {}),
      ...(input.bindRootAttempt ? { bindRootAttempt: input.bindRootAttempt } : {}),
      ...(input.inspectModelIntent ? { inspectModelIntent: input.inspectModelIntent } : {}),
      ...(input.preparePublicTask ? { preparePublicTask: input.preparePublicTask } : {}),
      ...(input.requestAgentReview ? { requestAgentReview: input.requestAgentReview } : {}),
    };
    this.#canRun = input.canRun ?? (() => true);
  }

  activate(input: {
    taskId: string; clientId: string; sourceAttemptId: string;
    approvalRef: string; message: string; agentReviewAfterMs?: number;
  }): TimerRecord {
    return activateContinuation(this.#services, input);
  }

  resumeAfterAgentDecision(input: {
    taskId: string; clientId: string; attemptId: string; mode: 'wait' | 'resume';
  }): TimerRecord {
    return resumeAfterAgentDecision(this.#services, input);
  }

  start(pollMs = 30_000): void {
    if (this.#closed) throw new Error('Managed continuation service is closed');
    if (this.#interval !== null) return;
    if (!Number.isInteger(pollMs) || pollMs < 100) throw new Error('Invalid Core tick interval');
    this.#interval = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, pollMs);
    this.#interval.unref();
    void this.tick().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#interval !== null) clearInterval(this.#interval);
    this.#interval = null;
    await this.#active?.catch(() => undefined);
  }

  tick(): Promise<ContinuationReviewReport> {
    if (this.#closed || !this.#canRun()) {
      return Promise.resolve({ timersClaimed: 0, dispatchesAttempted: 0, deferred: 0 });
    }
    if (this.#active !== null) return this.#active;
    const work = runContinuationTick(this.#services);
    this.#active = work;
    void work.finally(() => {
      if (this.#active === work) this.#active = null;
    }).catch(() => undefined);
    return work;
  }

}
