/** One-shot late binding: no silent no-op callback during runtime assembly. */
export interface ResumeTaskInput {
  readonly taskId: string;
  readonly clientId: string;
  readonly attemptId: string;
  readonly mode: "wait" | "resume" | "provider_effect";
}
export type ResumeTaskHandler = (input: ResumeTaskInput) => Promise<void>;
export class TaskResumeBinding {
  #handler: ResumeTaskHandler | null = null;
  bind(handler: ResumeTaskHandler): void {
    if (this.#handler !== null) throw new Error("Task resume binding already installed");
    this.#handler = handler;
  }
  async run(input: ResumeTaskInput): Promise<void> {
    if (this.#handler === null) throw new Error("Task resume binding is not installed");
    await this.#handler(input);
  }
}

import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import type { DurableTaskKernel } from '../durable-task-kernel.ts';
import type { ManagedContinuationService } from '../managed-continuation.ts';

/** A verified action resumes the original Task through its existing kernel.
 * No placeholder callback, browser-owned poller or unjournaled POST exists.
 */
export function createTaskResumeHandler(services: {
  readonly repository: Pick<KernelStores, 'tasks'>;
  readonly kernel: DurableTaskKernel;
  readonly managedContinuation: ManagedContinuationService;
}): ResumeTaskHandler {
  const { repository, kernel, managedContinuation } = services;
  return async ({ taskId, clientId, attemptId, mode }) => {
    if (mode === 'wait' || mode === 'resume') {
      managedContinuation.resumeAfterAgentDecision({ taskId, clientId, attemptId, mode });
    }
    if (mode === 'provider_effect') {
      const full = repository.tasks.readTaskAggregate(taskId, clientId);
      const attempt = full.attempts.find(row => row.attemptId === attemptId);
      if (full.task.state === 'working' && !full.task.cancelRequested &&
          attempt?.state === 'planned') {
        await kernel.dispatch(taskId, clientId, attemptId);
      }
    }
    await managedContinuation.tick();
  };
}
