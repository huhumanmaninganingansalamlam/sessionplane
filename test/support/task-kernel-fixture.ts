import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { createKernelStores, type KernelStores } from '../../src/storage/kernel/create-kernel-stores.ts';

/** One exact disposable SQLite owner. Core restart keeps the same DB file
 * and clock but creates new stores, so test data is never silently reset.
 */
export function createTaskKernelFixture(
  t: TestContext, input: {
    prefix?: string; now?: string;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), input.prefix ?? 'sessionplane-kernel-'));
  const file = join(dir, 'kernel-test.sqlite');
  const now = () => input.now ?? '2026-11-08T00:00:00.000Z';
  let database = SessionPlaneDatabase.open(file);
  let store = createKernelStores(database, now);
  t.after(() => { database.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    file,
    get store() { return store; },
    get database() { return database; },
    reopen() {
      database.close();
      database = SessionPlaneDatabase.open(file);
      store = createKernelStores(database, now);
      return store;
    },
  };
}

export function seedOwnedTaskSlot(
  store: KernelStores, input: {
    projectId?: string; projectKey?: string; clientId?: string;
    slotId?: string; providerKey?: string;
  } = {},
) {
  const projectId = input.projectId ?? 'project-1';
  const clientId = input.clientId ?? 'alice';
  store.projects.openProject({
    projectId, projectKey: input.projectKey ?? 'sessionplane.dev',
    displayName: 'SessionPlane', clientId,
  });
  return store.projects.openConversationSlot({
    projectId, clientId, slotId: input.slotId ?? 'main',
    roleKey: 'Main', providerKey: input.providerKey ?? 'chatgpt-fixture',
  });
}

/** Explicitly capture the ACK as an Attempt, not as a fabricated FINAL. */
export function seedAcknowledgedTask(
  store: KernelStores, input: {
    taskId: string; attemptId: string; projectId?: string; slotId?: string;
    clientId?: string; requestId: string; prompt: string;
    externalTurnId: string;
  },
) {
  const clientId = input.clientId ?? 'alice';
  const taskId = input.taskId;
  const slotId = input.slotId ?? 'main';
  store.tasks.createTask({
    taskId, projectId: input.projectId ?? 'project-1',
    slotId, expectedSlotRevision: 1, clientId,
    requestId: input.requestId, prompt: input.prompt,
  });
  store.attempts.planAttempt({
    taskId, clientId, attemptId: input.attemptId,
    kind: 'initial', turnKey: 'exact:' + input.attemptId,
    content: input.prompt,
  });
  store.attempts.reserveAttemptDispatch(taskId, clientId, input.attemptId);
  store.attempts.acknowledgeAttempt({ taskId, clientId,
    attemptId: input.attemptId, externalTurnId: input.externalTurnId });
  return store.tasks.readTaskAggregate(taskId, clientId);
}

export function seedPendingDecision(
  store: KernelStores, input: {
    taskId: string; clientId: string; decisionId: string;
    audience: 'agent' | 'human'; contextJson: string;
  },
) {
  store.decisions.createDecision(input);
  return store.tasks.getTask(input.taskId, input.clientId);
}
