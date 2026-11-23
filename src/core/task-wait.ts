import { setTimeout as pause } from 'node:timers/promises';

import type { TaskRecord } from '../storage/kernel/create-kernel-stores.ts';
import type { TaskRevisionReadPort } from './kernel-consumer-ports.ts';

export interface TaskRevisionWait {
  readonly taskId: string;
  readonly clientId: string;
  readonly afterRevision: number;
  readonly waitMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Disposable client observation only. This function owns no task, attempt,
 * timer or provider action. Aborting a wait never cancels the durable task;
 * clients may reconnect and resume from a revision in the authoritative DB.
 */
export async function waitForTaskRevision(
  store: TaskRevisionReadPort,
  input: TaskRevisionWait,
): Promise<TaskRecord> {
  if (!Number.isSafeInteger(input.afterRevision) || input.afterRevision < 0 ||
    !Number.isSafeInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > 300_000) {
    throw new Error('Invalid revision wait bounds');
  }
  let task = store.tasks.getTask(input.taskId, input.clientId);
  if (task.revision > input.afterRevision || input.waitMs === 0) return task;

  const deadline = performance.now() + input.waitMs;
  while (true) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return store.tasks.getTask(input.taskId, input.clientId);
    await pause(Math.min(remaining, 250), undefined, { signal: input.signal });
    task = store.tasks.getTask(input.taskId, input.clientId);
    if (task.revision > input.afterRevision) return task;
  }
}
