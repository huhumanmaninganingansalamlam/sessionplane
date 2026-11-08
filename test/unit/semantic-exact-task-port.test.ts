import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DurableTaskKernel } from '../../src/core/durable-task-kernel.ts';
import { SemanticExactTaskPort } from '../../src/core/semantic-exact-task-port.ts';
import type { ExactSendIntent, ExactTurnQuery } from '../../src/core/durable-task-kernel.ts';
import type {
  SemanticActRequest, SemanticActResult, SemanticDispatchEvidence,
  SemanticExactQuery, SemanticObservation, SemanticProviderAdapter,
  SemanticTaskContext, SemanticVerification,
} from '../../src/providers/semantic-adapter.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TaskKernelRepository } from '../../src/storage/task-kernel-repository.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const SENT_AT = '2026-11-08T10:00:00.000Z';

class FakeSemanticProvider implements SemanticProviderAdapter {
  readonly providerKey = 'fixture-semantic';
  readonly capabilities = {
    providerKey: 'fixture-semantic', browserRequired: false, contractVersion: 1 as const,
    supports: ['conversation'] as const,
  };
  #draft = '';
  #generation = 0;
  #consumed = new Set<string>();
  sends = 0;
  observations = 0;
  recovered = 0;
  ackReady = false;
  finalTurn = 'turn-1';
  finalText = 'Exact answer after restart';

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    assert.equal(context.pageLease, null, 'non-browser provider does not invent Chrome');
    this.observations++;
    const snapshotId = `snapshot-${++this.#generation}`;
    const purpose = this.#draft ? 'submit' as const : 'compose' as const;
    const evidenceHash = hash(JSON.stringify({ snapshotId, purpose, context }));
    return {
      providerKey: this.providerKey, surface: 'chat', snapshotId, observedAt: SENT_AT,
      capabilityManifest: this.capabilities, progress: 'idle', blocker: 'none', reason: null,
      turn: { submittedUserFound: false, laterUserFound: false, submittedUserMessageId: null,
        answerMessageId: null, partialAnswer: null },
      questionText: null, evidenceBytes: 150,
      actions: [{
        actionRef: `action-${this.#generation}`, purpose,
        effect: purpose === 'compose' ? 'Write draft' : 'Send exact draft',
        risk: purpose === 'compose' ? 'draft_only' : 'send_once',
        evidenceHash, expiresAt: '2099-01-01T00:00:00.000Z',
        input: purpose === 'compose' ? { kind: 'text', maxLength: 16000 } : { kind: 'none' },
      }],
    };
  }
  async act(request: SemanticActRequest): Promise<SemanticActResult> {
    const key = `${request.snapshotId}/${request.actionRef}`;
    if (this.#consumed.has(key) ||
      request.snapshotId !== `snapshot-${this.#generation}` ||
      request.actionRef !== `action-${this.#generation}`) {
      return { kind: 'stale', reason: 'used-or-foreign-action' };
    }
    this.#consumed.add(key);
    if (!this.#draft) {
      this.#draft = request.input ?? '';
      return { kind: 'performed', effect: 'draft_updated' };
    }
    assert.equal(request.authorizedAttemptId, 'attempt-1');
    assert.equal(request.expectedContentSha256, hash(this.#draft));
    this.sends++;
    const evidence: SemanticDispatchEvidence = {
      conversationId: 'conv-1', messageId: 'message-1', parentMessageId: 'root-1',
      textHash: hash(this.#draft), observedAt: SENT_AT,
    };
    return { kind: 'dispatched_unverified', effect: 'send', attempts: [evidence] };
  }
  async verify(_query: SemanticExactQuery): Promise<SemanticVerification> {
    return { kind: 'pending', reason: 'canonical-ack-late' };
  }
  async recover(query: SemanticExactQuery): Promise<SemanticVerification> {
    this.recovered++;
    assert.equal(query.context.pageLease, null);
    if (query.kind === 'ack') {
      assert.equal(query.prompt, 'original question 1');
      assert.equal(query.attempts?.length, 1);
      return this.ackReady ? {
        kind: 'verified_ack', externalTurnId: 'turn-1', messageId: 'message-1',
      } : { kind: 'pending', reason: 'not-yet-visible' };
    }
    assert.equal(query.context.submittedUserMessageId, 'message-1');
    assert.equal(query.context.submittedUserTurnId, 'turn-1');
    return { kind: 'exact_final', externalTurnId: this.finalTurn, answerText: this.finalText };
  }
}

test('semantic Core bridge persists exact dispatch evidence and recovers ACK/FINAL without replay', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-port-'));
  const path = join(dir, 'kernel.sqlite');
  let db = SessionPlaneDatabase.open(path);
  let store = new TaskKernelRepository(db, () => SENT_AT);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  store.openProject({ projectId: 'project-1', projectKey: 'sessionplane.demo',
    displayName: 'SessionPlane', clientId: 'alice' });
  store.openSlot({ projectId: 'project-1', slotId: 'main', roleKey: 'Main',
    providerKey: 'fixture-semantic', clientId: 'alice' });
  store.startTask({ taskId: 'task-1', projectId: 'project-1', slotId: 'main',
    expectedSlotRevision: 1, clientId: 'alice', requestId: 'request-1',
    prompt: 'original question 1' });
  store.observeConversation({ taskId: 'task-1', projectId: 'project-1',
    slotId: 'main', expectedRevision: 1, clientId: 'alice',
    providerConversationId: 'conv-1' });
  store.planAttempt({ taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1',
    kind: 'initial', turnKey: 'original', content: 'original question 1' });

  const adapter = new FakeSemanticProvider();
  const resolveContext = (intent: ExactSendIntent): SemanticTaskContext => ({
    projectId: intent.projectId, slotId: intent.slotId,
    slotRevision: intent.slotRevision, taskId: intent.taskId,
    providerConversationId: intent.providerConversationId,
    submittedUserMessageId: null, submittedUserTurnId: null, pageLease: null,
  });
  const journal = {
    record(intent: ExactSendIntent, evidence: SemanticDispatchEvidence) {
      store.recordDispatchEvidence({ taskId: intent.taskId, clientId: intent.clientId,
        attemptId: intent.attemptId, evidence });
    },
    read(query: ExactTurnQuery): SemanticDispatchEvidence | null {
      return store.getDispatchEvidence({ taskId: query.taskId, clientId: query.clientId,
        attemptId: query.attemptId });
    },
  };
  const port = () => new SemanticExactTaskPort({
    adapter, resolveContext, dispatchJournal: journal,
  });
  let kernel = new DurableTaskKernel(store, [port()]);
  const first = await kernel.dispatch('task-1', 'alice', 'attempt-1');
  assert.equal(first.state, 'uncertain', 'a clicked send without backend ACK stays uncertain');
  assert.equal(adapter.sends, 1);
  const stored = store.getDispatchEvidence({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1',
  });
  assert.equal(stored?.messageId, 'message-1');
  assert.equal(stored?.textHash, hash('original question 1'));
  assert.ok(store.getFullTask('task-1', 'alice').events.some(
    event => event.event.type === 'attempt.dispatch_evidence_recorded'));
  const replayRevision = store.getTask('task-1', 'alice').revision;
  store.recordDispatchEvidence({ taskId: 'task-1', clientId: 'alice',
    attemptId: 'attempt-1', evidence: stored! });
  assert.equal(store.getTask('task-1', 'alice').revision, replayRevision,
    'idempotent evidence write cannot advance task revision');
  assert.throws(() => store.recordDispatchEvidence({ taskId: 'task-1', clientId: 'alice',
    attemptId: 'attempt-1', evidence: { ...stored!, messageId: 'another-message' } }),
  /Conflicting/);
  await assert.rejects(() => kernel.dispatch('task-1', 'alice', 'attempt-1'), /no replay/);

  db.close();
  db = SessionPlaneDatabase.open(path);
  store = new TaskKernelRepository(db, () => SENT_AT);
  assert.equal(store.getDispatchEvidence({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1',
  })?.messageId, 'message-1', 'provider request evidence survives Core restart');
  adapter.ackReady = true;
  kernel = new DurableTaskKernel(store, [port()]);
  const observedBefore = adapter.observations;
  const recovered = await kernel.recoverAck('task-1', 'alice', 'attempt-1');
  assert.equal(recovered.state, 'working');
  assert.equal(adapter.sends, 1, 'recovery never mutates the provider');
  assert.equal(adapter.observations, observedBefore, 'recovery never observes a UI page');
  adapter.finalTurn = 'foreign-turn';
  const foreign = await kernel.observeFinal({ taskId: 'task-1', clientId: 'alice',
    attemptId: 'attempt-1', resultId: 'result-wrong', completeTask: true });
  assert.equal(foreign, null);
  assert.equal(store.getFullTask('task-1', 'alice').results.length, 0);
  adapter.finalTurn = 'turn-1';
  const result = await kernel.observeFinal({ taskId: 'task-1', clientId: 'alice',
    attemptId: 'attempt-1', resultId: 'result-1', completeTask: true });
  assert.equal(result?.answerText, 'Exact answer after restart');
  assert.equal(store.getTask('task-1', 'alice').state, 'completed');
  assert.equal(adapter.sends, 1);

  // Future providers may legitimately reuse opaque conversation/message IDs.
  // The collision key is provider-scoped, never ChatGPT-global.
  store.openSlot({ projectId: 'project-1', clientId: 'alice', slotId: 'review',
    roleKey: 'Reviewer', providerKey: 'alternate-semantic' });
  store.startTask({ taskId: 'task-2', projectId: 'project-1', clientId: 'alice',
    slotId: 'review', expectedSlotRevision: 1, requestId: 'request-2',
    prompt: 'original question 1' });
  store.observeConversation({ taskId: 'task-2', projectId: 'project-1',
    clientId: 'alice', slotId: 'review', expectedRevision: 1,
    providerConversationId: 'conv-1' });
  store.planAttempt({ taskId: 'task-2', clientId: 'alice', attemptId: 'attempt-2',
    kind: 'initial', turnKey: 'original', content: 'original question 1' });
  store.beginDispatch('task-2', 'alice', 'attempt-2');
  store.recordDispatchEvidence({ taskId: 'task-2', clientId: 'alice',
    attemptId: 'attempt-2', evidence: stored! });
  assert.equal(store.getDispatchEvidence({ taskId: 'task-2', clientId: 'alice',
    attemptId: 'attempt-2' })?.messageId, 'message-1');

  // ACL and immutable binding also protect the private dispatch journal.
  assert.throws(() => store.getDispatchEvidence({
    taskId: 'task-1', clientId: 'mallory', attemptId: 'attempt-1',
  }), /access denied/);
});

test('unbound new conversation is not submitted or re-created optimistically', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'sessionplane-unbound-semantic-'));
  const db = SessionPlaneDatabase.open(join(dir, 'kernel.sqlite'));
  const store = new TaskKernelRepository(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  store.openProject({ projectId: 'project-1', projectKey: 'unbound.demo',
    displayName: 'Demo', clientId: 'alice' });
  store.openSlot({ projectId: 'project-1', slotId: 'main', roleKey: 'Main',
    providerKey: 'fixture-semantic', clientId: 'alice' });
  store.startTask({ taskId: 'task-1', projectId: 'project-1', slotId: 'main',
    expectedSlotRevision: 1, clientId: 'alice', requestId: 'request-1', prompt: 'one' });
  store.planAttempt({ taskId: 'task-1', clientId: 'alice',
    attemptId: 'attempt-1', kind: 'initial', turnKey: 'original', content: 'one' });
  const fake = new FakeSemanticProvider();
  const port = new SemanticExactTaskPort({ adapter: fake,
    resolveContext: intent => ({
      projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
      taskId: intent.taskId, providerConversationId: intent.providerConversationId,
      submittedUserMessageId: null, submittedUserTurnId: null, pageLease: null,
    }),
    dispatchJournal: {
      record: () => { throw new Error('No dispatch should be recorded'); },
      read: () => null,
    },
  });
  const kernel = new DurableTaskKernel(store, [port]);
  assert.equal((await kernel.dispatch('task-1', 'alice', 'attempt-1')).state, 'uncertain');
  assert.equal(fake.sends, 0);
  assert.equal(fake.observations, 0);
  assert.equal((await kernel.recoverAck('task-1', 'alice', 'attempt-1')).state, 'uncertain');
  assert.equal(fake.recovered, 0);
});
