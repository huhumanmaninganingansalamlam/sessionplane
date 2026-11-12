import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test('public Main and explicitly opened second logical slot have independent revisions, leases, answers and cancellation', {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sp-two-actual-logical-slots-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, startBrowser: false, logger });
  const clientId = 'slot-isolation-owner';
  const rpc = (method: string, params: Record<string, unknown>) => callRpc<any>({
    socketPath: config.socketPath, method, params,
    timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes,
  });
  try {
    const project = await rpc('project.open', {
      clientId, requestId: 'one-project-open',
      projectKey: 'one-project-with-two-explicit-slots',
      displayName: 'Two independent conversation slots',
      provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
    });
    assert.equal(project.mainConversationSlotId, 'main');
    const projectId = project.projectId;
    assert.equal(core.semanticTaskRepository.getConversationRevision(projectId, 'main', clientId), 1);

    // An explicit role is a fixture setup, not a new public role-creation
    // surface or a real Expert account/browser generation.
    core.teamDirectory.createRole({
      teamId: projectId, roleKey: 'reviewer', roleType: 'reviewer',
      displayName: 'Fixture only: reviewer', reportsToRoleKey: 'main',
    });
    const second = core.semanticTaskRepository.openSlot({
      projectId, clientId, slotId: 'reviewer', roleKey: 'reviewer',
      providerKey: 'chatgpt',
    });
    assert.equal(second.revision, 1);
    assert.equal(core.semanticTaskRepository.getConversationRevision(projectId, 'reviewer', clientId), 1);
    const revisionCount = () => Number(core.database.raw.prepare(
      'SELECT COUNT(*) AS count FROM kernel_public_slot_revisions WHERE project_id=?'
    ).get(projectId)!.count);
    assert.equal(revisionCount(), 2);

    const mainInput = {
      clientId, requestId: 'main-original', projectId,
      expectedConversationRevision: 1, prompt: 'Independent Main exact question',
    };
    const reviewerInput = {
      clientId, requestId: 'reviewer-original', projectId,
      conversationSlotId: 'reviewer', expectedConversationRevision: 1,
      prompt: 'Independent reviewer exact question',
    };
    const [main, reviewer] = await Promise.all([
      rpc('task.start', mainInput), rpc('task.start', reviewerInput),
    ]);
    assert.equal(main.conversationSlotId, 'main');
    assert.equal(reviewer.conversationSlotId, 'reviewer');
    assert.notEqual(main.taskId, reviewer.taskId);
    assert.equal(main.conversationRevision, 2);
    assert.equal(reviewer.conversationRevision, 2);
    assert.equal(core.semanticTaskRepository.getConversationRevision(projectId, 'main', clientId), 2);
    assert.equal(core.semanticTaskRepository.getConversationRevision(projectId, 'reviewer', clientId), 2);
    assert.equal((await rpc('task.start', reviewerInput)).taskId, reviewer.taskId);
    assert.equal((await rpc('task.start', mainInput)).taskId, main.taskId);

    const mainTask = core.semanticTaskRepository.getFullTask(main.taskId, clientId);
    const reviewerTask = core.semanticTaskRepository.getFullTask(reviewer.taskId, clientId);
    assert.equal(mainTask.attempts.length, 1);
    assert.equal(reviewerTask.attempts.length, 1);
    assert.equal(mainTask.attempts[0]!.state, 'planned');
    assert.equal(reviewerTask.attempts[0]!.state, 'planned');
    assert.equal(mainTask.attempts[0]!.content, mainInput.prompt);
    assert.equal(reviewerTask.attempts[0]!.content, reviewerInput.prompt);
    assert.equal(core.teamDirectory.getCurrentSession(projectId, 'main').roleKey, 'main');
    assert.equal(core.teamDirectory.getCurrentSession(projectId, 'reviewer').roleKey, 'reviewer');

    await assert.rejects(rpc('task.start', {
      ...reviewerInput, requestId: 'reviewer-busy',
      expectedConversationRevision: 2,
    }), (error: any) => error.data?.errorCode === 'conversation_busy');
    await assert.rejects(rpc('task.start', {
      ...reviewerInput, requestId: 'reviewer-stale',
      expectedConversationRevision: 1,
    }), (error: any) => error.data?.errorCode === 'conversation_conflict');
    await assert.rejects(rpc('task.start', {
      ...reviewerInput, requestId: 'invented-role', conversationSlotId: 'unregistered',
    }), (error: any) => error.data?.errorCode === 'invalid_request');
    await assert.rejects(rpc('task.start', {
      ...reviewerInput, clientId: 'foreign-owner', requestId: 'foreign-role',
    }), (error: any) => error.data?.errorCode === 'invalid_request');
    assert.equal(revisionCount(), 2,
      'Invented and foreign owner roles cannot allocate public revision rows');

    // Only reviewer completes. Main must remain unresolved, then its own
    // independent cancellation cannot affect the finished reviewer result.
    const attempt = reviewerTask.attempts[0]!;
    core.semanticTaskRepository.beginDispatch(reviewer.taskId, clientId, attempt.attemptId);
    core.semanticTaskRepository.acknowledgeAttempt({
      taskId: reviewer.taskId, clientId, attemptId: attempt.attemptId,
      externalTurnId: 'reviewer-proven-turn',
    });
    core.semanticTaskRepository.recordFinal({
      taskId: reviewer.taskId, clientId, attemptId: attempt.attemptId,
      resultId: 'reviewer-exact-final',
      externalTurnId: 'reviewer-proven-turn',
      answerText: 'Reviewer answer, never Main answer',
      completeTask: true,
    });
    const result = await rpc('task.get', {
      clientId, taskId: reviewer.taskId, view: 'result',
    });
    assert.equal(result.state, 'completed');
    assert.equal(result.result.answerText, 'Reviewer answer, never Main answer');
    assert.equal(result.conversationSlotId, 'reviewer');
    const unaffected = await rpc('task.get', {
      clientId, taskId: main.taskId, view: 'result',
    });
    assert.equal(unaffected.state, 'working');
    assert.equal(unaffected.resultAvailable, false);
    assert.equal(unaffected.conversationSlotId, 'main');

    const canceled = await rpc('task.cancel', {
      clientId, taskId: main.taskId, requestId: 'cancel-main-only',
    });
    assert.equal(canceled.state, 'canceled');
    assert.equal(canceled.cancelOutcome, 'not_submitted');
    assert.equal((await rpc('task.get', {
      clientId, taskId: reviewer.taskId, view: 'result',
    })).result.answerText, 'Reviewer answer, never Main answer');

    const reviewerNext = await rpc('task.start', {
      ...reviewerInput, requestId: 'reviewer-next',
      expectedConversationRevision: 2, prompt: 'Second reviewer question',
    });
    assert.equal(reviewerNext.conversationSlotId, 'reviewer');
    assert.equal(reviewerNext.conversationRevision, 3);
    assert.equal(core.semanticTaskRepository.getConversationRevision(projectId, 'main', clientId), 2);
    assert.equal(core.semanticTaskRepository.getConversationRevision(projectId, 'reviewer', clientId), 3);
    assert.equal((await rpc('task.get', { clientId, taskId: main.taskId })).state, 'canceled');
    assert.equal(revisionCount(), 2, 'An explicit role cannot generate new identity rows on task retry');
    assert.equal(core.semanticTaskRepository.getFullTask(reviewerNext.taskId, clientId).attempts.length, 1);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a historical explicitly owned slot without public revision metadata is admitted exactly once', {
  timeout: 30_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sp-historical-slot-recovery-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const clientId = 'historical-slot-owner';
  let core = await startCore({ config, startBrowser: false, logger });
  const rpc = (method: string, params: Record<string, unknown>) => callRpc<any>({
    socketPath: config.socketPath, method, params, timeoutMs: 10_000,
    maxLineBytes: config.rpcMaxLineBytes,
  });
  try {
    const project = await rpc('project.open', {
      clientId, requestId: 'open-historical-project', projectKey: 'historical-slot',
      displayName: 'Historical independent slot',
      provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
    });
    core.teamDirectory.createRole({
      teamId: project.projectId, roleKey: 'expert.backend',
      roleType: 'expert', reportsToRoleKey: 'main',
    });
    core.semanticTaskRepository.openSlot({
      projectId: project.projectId, clientId, slotId: 'expert.backend',
      roleKey: 'expert.backend', providerKey: 'chatgpt',
    });
    core.semanticTaskRepository.replaceBinding({
      projectId: project.projectId, clientId, slotId: 'expert.backend',
      expectedRevision: 1, providerKey: 'chatgpt',
      providerConversationId: 'historical-verified-conversation',
    });
    // Simulates an explicit role/slot that was written under schema 12
    // and subsequently upgraded to public admission metadata in schema 13.
    // Historical binding revision is 2; it must not be reset to 1.
    core.database.raw.prepare(
      'DELETE FROM kernel_public_slot_revisions WHERE project_id=? AND slot_id=?'
    ).run(project.projectId, 'expert.backend');
    assert.equal(core.semanticTaskRepository.getConversationRevision(
      project.projectId, 'expert.backend', clientId), 2);
    await core.close();
    core = await startCore({ config, startBrowser: false, logger });
    const input = {
      clientId, projectId: project.projectId,
      conversationSlotId: 'expert.backend',
      expectedConversationRevision: 2,
      requestId: 'old-slot-first-public-question',
      prompt: 'Once-only question on an upgraded historical slot',
    };
    const persistedRow = () => core.database.raw.prepare(
      'SELECT revision FROM kernel_public_slot_revisions WHERE project_id=? AND slot_id=?'
    ).get(project.projectId, 'expert.backend') as { revision: number } | undefined;
    await assert.rejects(rpc('task.start', {
      ...input, clientId: 'foreign-role-owner', requestId: 'foreign-slot-injection',
    }), (error: any) => error.data?.errorCode === 'invalid_request');
    assert.equal(persistedRow(), undefined,
      'A foreign owner cannot create a missing historical public slot counter');
    await assert.rejects(rpc('task.start', {
      ...input, requestId: 'stale-slot-guess',
      expectedConversationRevision: 1,
    }), (error: any) => error.data?.errorCode === 'conversation_conflict');
    assert.equal(persistedRow(), undefined,
      'A failed compare-and-swap rolls back the lazy metadata repair');
    const admitted = await rpc('task.start', input);
    assert.equal(admitted.conversationSlotId, 'expert.backend');
    assert.equal(admitted.conversationRevision, 3);
    assert.equal(admitted.submission.attempted, false);
    assert.equal((await rpc('task.start', input)).taskId, admitted.taskId);
    assert.equal(core.semanticTaskRepository.getConversationRevision(
      project.projectId, 'expert.backend', clientId), 3);
    assert.equal(core.semanticTaskRepository.getConversationRevision(
      project.projectId, 'main', clientId), 1);
    const entry = core.database.raw.prepare(
      'SELECT revision FROM kernel_public_slot_revisions WHERE project_id=? AND slot_id=?'
    ).get(project.projectId, 'expert.backend') as { revision: number };
    assert.equal(entry.revision, 3);
    const task = core.semanticTaskRepository.getFullTask(admitted.taskId, clientId);
    assert.equal(task.attempts.length, 1);
    assert.equal(task.attempts[0]!.state, 'planned');
    assert.equal(task.attempts[0]!.content, input.prompt);
    assert.equal(task.task.slotRevision, 2,
      'Public admission revision never rewrites historical provider-binding identity');
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
