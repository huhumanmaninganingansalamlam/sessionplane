import type { KernelStores } from '../storage/kernel/create-kernel-stores.ts';

/** A transport can read Task and immutable binding evidence, not mutate the
 * kernel's Attempt/Decision/Timer ownership indirectly. */
export type PublicTaskReadPort = Pick<KernelStores, 'tasks' | 'projects' | 'attempts'>;
export type TaskRevisionReadPort = Pick<KernelStores, 'tasks'>;
