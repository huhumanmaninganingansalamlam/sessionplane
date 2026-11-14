import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BrowserOwner } from '../../src/browser/browser-owner.ts';
import type { PageRegistry } from '../../src/browser/page-registry.ts';
import { PublicTaskPreparationService } from '../../src/core/public-task-preparation.ts';
import type { TeamDirectory } from '../../src/core/team-directory.ts';
import type { ActorScheduler } from '../../src/scheduler/actor-scheduler.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TaskKernelRepository } from '../../src/storage/task-kernel-repository.ts';

test('public root preparation visits every waiting Task after repeated Core/SQLite restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-public-prepare-restart-'));
  const file = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ids = Array.from({ length: 12 }, (_, index) =>
    'prepared-' + String(index).padStart(2, '0'));
  const db = SessionPlaneDatabase.open(file);
  try {
    const store = new TaskKernelRepository(db);
    store.openProject({ projectId: 'project', projectKey: 'prepare.fixture',
      displayName: 'Synthetic preparation', clientId: 'agent' });
    for (const taskId of ids) {
      store.openSlot({ projectId: 'project', clientId: 'agent',
        slotId: taskId, roleKey: taskId, providerKey: 'synthetic-not-chatgpt' });
      store.startTask({ taskId, projectId: 'project', slotId: taskId,
        expectedSlotRevision: 1, clientId: 'agent',
        requestId: 'start-' + taskId, prompt: 'fixture-' + taskId });
      store.planAttempt({ taskId, clientId: 'agent',
        attemptId: 'attempt-' + taskId, kind: 'initial', turnKey: 'root',
        content: 'fixture-' + taskId });
      db.raw.prepare(
        'INSERT INTO kernel_public_task_policies' +
        '(task_id,policy_json,input_sha256,accepted_revision,created_at)' +
        ' VALUES(?,?,?,?,?)',
      ).run(taskId, JSON.stringify({ enabled: false }),
        'synthetic-policy-hash', 1, '2026-11-12T00:00:00.000Z');
    }
  } finally { db.close(); }

  const visited: string[] = [];
  for (let scan = 0; scan < ids.length; scan++) {
    const reopened = SessionPlaneDatabase.open(file);
    try {
      const service = new PublicTaskPreparationService({
        repository: new TaskKernelRepository(reopened),
        teams: {} as TeamDirectory,
        scheduler: {} as ActorScheduler,
        // Provider key is deliberately unsupported; no browser call, target,
        // tab, conversation, POST or scheduling mutation is possible.
        browserOwner: { status: { state: 'ready' } } as unknown as BrowserOwner,
        pages: {} as PageRegistry,
        chatgptUrl: 'https://chatgpt.com',
      });
      const outcome = await service.prepareNext();
      assert.equal(outcome.kind, 'waiting');
      if (outcome.taskId !== null) visited.push(outcome.taskId);
    } finally { reopened.close(); }
  }
  assert.deepEqual(visited, ids,
    'a fresh Core per tick must not repeatedly choose the first unbound Task');
});

test('root/bound preparation priority and bounded conversation cursor survive reopen independently', t => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-public-preparation-phase-'));
  const file = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ids = Array.from({ length: 12 }, (_, index) =>
    'bound-' + String(index).padStart(2, '0'));
  let db = SessionPlaneDatabase.open(file);
  let store = new TaskKernelRepository(db);
  try {
    store.openProject({ projectId: 'project', projectKey: 'bound.fixture',
      displayName: 'Synthetic bound preparations', clientId: 'agent' });
    for (const taskId of ids) {
      store.openSlot({ projectId: 'project', clientId: 'agent',
        slotId: taskId, roleKey: taskId, providerKey: 'chatgpt' });
      store.startTask({ taskId, projectId: 'project', slotId: taskId,
        expectedSlotRevision: 1, clientId: 'agent',
        requestId: 'start-' + taskId, prompt: 'fixture-' + taskId });
      store.observeConversation({ projectId: 'project', slotId: taskId,
        expectedRevision: 1, clientId: 'agent', taskId,
        providerConversationId: 'conversation-' + taskId });
      store.planAttempt({ taskId, clientId: 'agent',
        attemptId: 'attempt-' + taskId, kind: 'initial', turnKey: 'root',
        content: 'fixture-' + taskId });
      db.raw.prepare(
        'INSERT INTO kernel_public_task_policies' +
        '(task_id,policy_json,input_sha256,accepted_revision,created_at)' +
        ' VALUES(?,?,?,?,?)',
      ).run(taskId, JSON.stringify({ enabled: false }),
        'synthetic-policy-hash', 1, '2026-11-12T00:00:00.000Z');
    }
    const before = ids.map(taskId => store.getTask(taskId, 'agent').revision);
    assert.equal(store.claimPublicPreparationPrefersBound(), false);
    assert.deepEqual(store.listPendingPublicInitials(8).map(row => row.taskId), ids.slice(0, 8));
    assert.deepEqual(store.listPendingPublicBoundPreparations(8).map(row => row.taskId),
      ids.slice(0, 8), 'the bound preparation scanner must have its own cursor');

    db.close();
    db = SessionPlaneDatabase.open(file);
    store = new TaskKernelRepository(db);
    assert.equal(store.claimPublicPreparationPrefersBound(), true);
    const wrapped = [...ids.slice(8), ...ids.slice(0, 4)];
    assert.deepEqual(store.listPendingPublicInitials(8).map(row => row.taskId), wrapped);
    assert.deepEqual(store.listPendingPublicBoundPreparations(8).map(row => row.taskId), wrapped);
    assert.equal(store.claimPublicPreparationPrefersBound(), false);
    assert.deepEqual(ids.map(taskId => store.getTask(taskId, 'agent').revision), before,
      'preparation ordering cannot publish a provider action or Task event');
    const cursorKinds = (db.raw.prepare(
      'SELECT scan_kind AS kind FROM kernel_public_scan_cursors ORDER BY scan_kind',
    ).all() as { kind: string }[]).map(row => row.kind);
    assert.deepEqual(cursorKinds, ['bound_prepare', 'initial']);
  } finally { db.close(); }
});
