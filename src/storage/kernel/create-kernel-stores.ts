import type { SessionPlaneDatabase } from '../database.ts';
import { KernelTransactionContext } from './transaction-context.ts';
import { ProjectSlotStore } from './project-slot-store.ts';
import { TaskStore } from './task-store.ts';
import { AttemptJournal } from './attempt-journal.ts';
import { DecisionJournal } from './decision-journal.ts';
import { TimerStore } from './timer-store.ts';
import { BackendReadPacingStore } from './backend-read-pacing-store.ts';
import { PublicScanStore } from './public-scan-store.ts';

export type * from './records.ts';

/** Exactly one shared DB and clock; transactions remain owned by the called store. */
export function createKernelStores(
  database: SessionPlaneDatabase, now: () => string = () => new Date().toISOString(),
) {
  const context = new KernelTransactionContext(database, now);
  const projects = new ProjectSlotStore(context);
  return {
    projects,
    tasks: new TaskStore(context),
    attempts: new AttemptJournal(context, projects),
    decisions: new DecisionJournal(context),
    timers: new TimerStore(context),
    pacing: new BackendReadPacingStore(context),
    scans: new PublicScanStore(context),
  } as const;
}

export type KernelStores = ReturnType<typeof createKernelStores>;
