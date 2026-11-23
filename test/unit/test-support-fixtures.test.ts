import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskKernelFixture, seedOwnedTaskSlot,
  seedAcknowledgedTask, seedPendingDecision } from '../support/task-kernel-fixture.ts';
import { createDecisionEvidence, createDecisionFixture } from
  '../support/semantic-decision-fixture.ts';
import { seedExactTurn } from '../support/chatgpt-semantic-fixture.ts';

test('small explicit fixture preserves ACK, pending Decision and bytes after SQLite reopen', t => {
  const env = createTaskKernelFixture(t, { prefix: 'sessionplane-fixture-proof-' });
  seedOwnedTaskSlot(env.store);
  const originalPrompt = 'Literal Ω\n**unchanged**\n';
  const seeded = seedAcknowledgedTask(env.store, {
    taskId: 'task-fixture', attemptId: 'attempt-fixture',
    requestId: 'request-fixture', prompt: originalPrompt,
    externalTurnId: 'exact-provider-turn',
  });
  assert.equal(seeded.task.originalPrompt,originalPrompt);
  assert.equal(seeded.attempts[0]?.state,'acknowledged');
  assert.equal(seeded.attempts[0]?.externalTurnId,'exact-provider-turn');
  assert.equal(seeded.results.length,0);
  const context = seedExactTurn({
    taskId: 'task-fixture', conversationId: 'exact-conversation',
    userMessageId: 'user-anchor', userTurnId: 'exact-provider-turn',
    projectId: 'project-1',
  });
  const packet = {
    taskId: 'task-fixture', taskRevision: seeded.task.revision,
    decisionId: 'decision-fixture', kind: 'provider_question' as const,
    reason: 'fixture-review', humanOnly: false,
    observedAt: '2026-11-23T00:00:00.000Z',
    expiresAt: '2026-11-23T00:30:00.000Z',
    snapshotId: null, questionText: 'Proceed?', permission: null,
    requestedModel: null, options: [], controls: [],
    evidenceSections: [], observedControls: [],
    resumePoint: 'fixture-same-task', evidenceBytes: 0,
  };
  const v2 = createDecisionFixture({
    context, attemptId: 'attempt-fixture', packet,
    evidence: createDecisionEvidence({ original_request: originalPrompt,
      provider_question: 'Proceed?' }),
  });
  assert.equal(v2.schemaVersion,2);
  seedPendingDecision(env.store, {
    taskId: 'task-fixture', clientId: 'alice', decisionId: packet.decisionId,
    audience: 'agent', contextJson: JSON.stringify(v2),
  });
  const reopened = env.reopen();
  const persisted = reopened.tasks.readTaskAggregate('task-fixture','alice');
  assert.equal(persisted.task.state,'agent_input_required');
  assert.equal(persisted.task.pendingDecisionId,'decision-fixture');
  assert.equal(persisted.attempts[0]?.externalTurnId,'exact-provider-turn');
  assert.equal(persisted.decisions[0]?.contextJson,JSON.stringify(v2));
  assert.equal(persisted.results.length,0);
});
