import type { DurableTaskKernel } from '../durable-task-kernel.ts';
import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';

export type ContinuationRepository =
  Pick<KernelStores, 'projects' | 'tasks' | 'attempts' | 'timers' | 'scans'>;

export interface ContinuationAgentReviewInput {
  readonly taskId: string;
  readonly clientId: string;
  readonly attemptId: string;
  readonly cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress';
}
export interface ContinuationServices {
  readonly repository: ContinuationRepository;
  readonly kernel: DurableTaskKernel;
  readonly now: () => Date;
  readonly bindAttempt: (input: {
    taskId: string; clientId: string; attemptId: string; sourceAttemptId: string;
  }) => void | Promise<void>;
  readonly bindInitialAttempt?: (input: {
    taskId: string; clientId: string; attemptId: string;
  }) => void | Promise<void>;
  readonly bindRootAttempt?: (input: {
    taskId: string; clientId: string; attemptId: string;
  }) => void | Promise<void>;
  readonly inspectModelIntent?: (input: {
    taskId: string; clientId: string; attemptId: string; modelIntent: string;
  }) => boolean | Promise<boolean>;
  readonly preparePublicTask?: () => Promise<void>;
  readonly requestAgentReview?: (input: ContinuationAgentReviewInput) => Promise<void>;
}

export interface ContinuationReviewReport {
  readonly timersClaimed: number;
  readonly dispatchesAttempted: number;
  readonly deferred: number;
}
