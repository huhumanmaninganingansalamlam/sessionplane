import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DurableTaskKernel } from '../../src/core/durable-task-kernel.ts';
import { SemanticExactTaskPort } from '../../src/core/semantic-exact-task-port.ts';
import { restoreSemanticPageBindings } from '../../src/core/semantic-core-runtime.ts';
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
  postDraftUnavailableObservations = 0;

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    assert.equal(context.pageLease, null, 'non-browser provider does not invent Chrome');
    this.observations++;
    const snapshotId = `snapshot-${++this.#generation}`;
    const purpose = this.#draft
      ? context.submittedUserMessageId !== null && context.submittedUserTurnId !== null
        ? 'continue' as const : 'submit' as const
      : 'compose' as const;
    const evidenceHash = hash(JSON.stringify({ snapshotId, purpose, context }));
    const unavailable = this.#draft !== '' && this.postDraftUnavailableObservations-- > 0;
    return {
      providerKey: this.providerKey, surface: 'chat', snapshotId, observedAt: SENT_AT,
      capabilityManifest: this.capabilities, progress: 'idle', blocker: 'none', reason: null,
      turn: { submittedUserFound: false, laterUserFound: false, submittedUserMessageId: null,
        answerMessageId: null, partialAnswer: null },
      questionText: null, evidenceBytes: 150,
      actions: unavailable ? [] : [{
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
  kernel = new DurableTaskKernel(store, [port()]);
  const pendingAck = await kernel.recoverAck('task-1', 'alice', 'attempt-1');
  assert.equal(pendingAck.state, 'uncertain', 'read-only pending ACK cannot resubmit');
  const deferrals = store.getFullTask('task-1', 'alice').events
    .filter(row => row.event.type === 'observation.deferred');
  assert.equal(deferrals.length, 1, 'the actual backend ACK reason must survive Core restart');
  assert.equal((deferrals[0]!.event as { reason: string }).reason,
    'ack:attempt-1:pending:not-yet-visible');
  await kernel.recoverAck('task-1', 'alice', 'attempt-1');
  assert.equal(store.getTask('task-1', 'alice').revision, pendingAck.revision,
    'repeated identical paced ACK checks cannot flood the journal');
  assert.equal(adapter.sends, 1, 'ACK reconciliation must never replay an original POST');
  adapter.ackReady = true;
  kernel = new DurableTaskKernel(store, [port()]);
  const observedBefore = adapter.observations;
  const recovered = await kernel.recoverAck('task-1', 'alice', 'attempt-1');
  assert.equal(recovered.state, 'working');
  assert.equal(adapter.sends, 1, 'recovery never mutates the provider');
  assert.equal(adapter.observations, observedBefore, 'recovery never observes a UI page');
  // A forged FINAL from an adapter cannot complete an acknowledged attempt
  // if its exact outgoing dispatch journal has been lost.
  const forged = new FakeSemanticProvider();
  forged.recover = async () => ({
    kind: 'exact_final', externalTurnId: 'turn-1', answerText: 'unproven final',
  });
  const withoutJournal = new SemanticExactTaskPort({ adapter: forged,
    resolveContext, dispatchJournal: { record: journal.record, read: () => null },
  });
  const unproven = await new DurableTaskKernel(store, [withoutJournal]).observeFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'attempt-1',
    resultId: 'result-no-proof', completeTask: true,
  });
  assert.equal(unproven, null, 'FINAL requires durable exact POST evidence');
  assert.equal(store.getFullTask('task-1', 'alice').results.length, 0);
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

test('semantic Core waits for an asynchronously enabled exact continuation Send control', async () => {
  const adapter = new FakeSemanticProvider();
  adapter.postDraftUnavailableObservations = 2;
  const intent: ExactSendIntent = {
    clientId: 'alice', projectId: 'project-1', slotId: 'main', slotRevision: 1,
    providerConversationId: 'conv-1', taskId: 'task-1',
    attemptId: 'attempt-1', kind: 'continuation', content: '계속',
  };
  let journalWrites = 0;
  const port = new SemanticExactTaskPort({
    adapter,
    resolveContext: query => ({
      projectId: query.projectId, slotId: query.slotId,
      slotRevision: query.slotRevision, taskId: query.taskId,
      providerConversationId: query.providerConversationId,
      submittedUserMessageId: 'prior-message', submittedUserTurnId: 'prior-turn',
      pageLease: null,
    }),
    dispatchJournal: {
      record: () => { journalWrites++; },
      read: () => null,
    },
  });
  assert.deepEqual(await port.sendOnce(intent), {
    kind: 'uncertain', reason: 'canonical-ack-still-unverified',
  });
  assert.equal(adapter.observations, 4,
    'one compose observation plus bounded read-only readiness observations');
  assert.equal(adapter.sends, 1, 'the exact continuation is sent only once');
  assert.equal(journalWrites, 1, 'the one provider POST receives one evidence write');
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
  assert.equal((await kernel.dispatch('task-1', 'alice', 'attempt-1')).state, 'working');
  assert.equal(store.getFullTask('task-1', 'alice').attempts[0]!.state, 'planned',
    'known unbound conversation remains safely sendable after preparation');
  assert.equal(fake.sends, 0);
  assert.equal(fake.observations, 0);
  await assert.rejects(kernel.recoverAck('task-1', 'alice', 'attempt-1'),
    /Only previously dispatched attempts/, 'a planned attempt needs preparation, not ACK recovery');
  assert.equal(fake.recovered, 0);
});

test('semantic Core port rejects a foreign provider observation after drafting', async () => {
  class DriftingProvider extends FakeSemanticProvider {
    override async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
      const snapshot = await super.observe(context);
      return this.observations === 2
        ? { ...snapshot, providerKey: 'foreign-semantic' } : snapshot;
    }
  }
  const adapter = new DriftingProvider();
  const intent: ExactSendIntent = {
    clientId: 'alice', projectId: 'project-1', slotId: 'main', slotRevision: 1,
    providerConversationId: 'conv-1', taskId: 'task-1',
    attemptId: 'attempt-1', kind: 'initial', content: 'original question 1',
  };
  let journalWrites = 0;
  const port = new SemanticExactTaskPort({
    adapter,
    resolveContext: query => ({
      projectId: query.projectId, slotId: query.slotId,
      slotRevision: query.slotRevision, taskId: query.taskId,
      providerConversationId: query.providerConversationId,
      submittedUserMessageId: null, submittedUserTurnId: null, pageLease: null,
    }),
    dispatchJournal: {
      record: () => { journalWrites++; },
      read: () => null,
    },
  });
  assert.equal((await port.sendOnce(intent)).kind, 'uncertain');
  assert.equal(adapter.observations, 2);
  assert.equal(adapter.sends, 0, 'never dispatch an action from a foreign provider snapshot');
  assert.equal(journalWrites, 0);
});

test('semantic Core port requires a stable declared conversation capability before dispatch', async () => {
  const fake = new FakeSemanticProvider();
  const intent: ExactSendIntent = {
    clientId: 'alice', projectId: 'project-1', slotId: 'main', slotRevision: 1,
    providerConversationId: 'conv-1', taskId: 'task-1',
    attemptId: 'attempt-1', kind: 'initial', content: 'original question 1',
  };
  const context = (query: ExactSendIntent): SemanticTaskContext => ({
    projectId: query.projectId, slotId: query.slotId,
    slotRevision: query.slotRevision, taskId: query.taskId,
    providerConversationId: query.providerConversationId,
    submittedUserMessageId: null, submittedUserTurnId: null, pageLease: null,
  });
  let journalWrites = 0;
  const port = (adapter: SemanticProviderAdapter) => new SemanticExactTaskPort({
    adapter, resolveContext: context,
    dispatchJournal: { record: () => { journalWrites++; }, read: () => null },
  });
  const withoutConversation: SemanticProviderAdapter = {
    providerKey: fake.providerKey,
    capabilities: { ...fake.capabilities, supports: [] },
    observe: query => fake.observe(query),
    act: request => fake.act(request),
    verify: query => fake.verify(query),
    recover: query => fake.recover(query),
  };
  const unsupportedPort = port(withoutConversation);
  assert.equal((await unsupportedPort.sendOnce(intent)).kind, 'uncertain');
  assert.deepEqual(await unsupportedPort.recoverAck({ ...intent, externalTurnId: null }), {
    kind: 'unavailable', reason: 'semantic-conversation-capability-unavailable',
  });
  assert.deepEqual(await unsupportedPort.observeFinal({ ...intent, externalTurnId: 'turn-1' }), {
    kind: 'unavailable', reason: 'semantic-conversation-capability-unavailable',
  });
  assert.equal(fake.observations, 0, 'unsupported adapters are never asked to draft');
  assert.equal(fake.recovered, 0, 'unsupported adapters cannot perform backend recovery');

  const driftingManifest: SemanticProviderAdapter = {
    ...withoutConversation,
    capabilities: fake.capabilities,
    observe: async query => ({
      ...(await fake.observe(query)),
      capabilityManifest: { ...fake.capabilities, supports: [] },
    }),
  };
  assert.equal((await port(driftingManifest).sendOnce(intent)).kind, 'uncertain');
  assert.equal(fake.observations, 1, 'an unsupported observation must not be acted on');
  assert.equal(fake.sends, 0);
  assert.equal(journalWrites, 0);
});

test('semantic ACK recovery rejects a turn conflicting with the exact task context', async () => {
  const fake = new FakeSemanticProvider();
  fake.ackReady = true;
  const evidence: SemanticDispatchEvidence = {
    conversationId: 'conv-1', messageId: 'message-1', parentMessageId: 'root-1',
    textHash: hash('original question 1'), observedAt: SENT_AT,
  };
  const query: ExactTurnQuery = {
    clientId: 'alice', projectId: 'project-1', slotId: 'main', slotRevision: 1,
    providerConversationId: 'conv-1', taskId: 'task-1', attemptId: 'attempt-1',
    kind: 'initial', content: 'original question 1', externalTurnId: null,
  };
  let resolvedTurn: string | null = 'foreign-turn';
  const port = new SemanticExactTaskPort({
    adapter: fake,
    resolveContext: intent => ({
      projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
      taskId: intent.taskId, providerConversationId: intent.providerConversationId,
      submittedUserMessageId: 'message-1', submittedUserTurnId: resolvedTurn, pageLease: null,
    }),
    dispatchJournal: { record: () => { throw new Error('Recovery must not write'); }, read: () => evidence },
  });
  assert.equal((await port.recoverAck(query)).kind, 'unavailable',
    'a canonical ACK cannot overwrite a conflicting bound turn');
  resolvedTurn = 'turn-1';
  assert.deepEqual(await port.recoverAck(query), { kind: 'verified_ack', externalTurnId: 'turn-1' });
  resolvedTurn = null;
  assert.deepEqual(await port.recoverAck(query), { kind: 'verified_ack', externalTurnId: 'turn-1' });
  assert.equal(fake.sends, 0, 'ACK recovery remains read-only');
});

interface FixtureOptions {
  conversationId?: string | null;
  liveConversationId?: string | null;
  liveUrl?: string;
  liveTargetId?: string;
  duplicateTarget?: boolean;
  terminalSession?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const conversationId = options.conversationId === undefined ? 'exact-conversation' : options.conversationId;
  const liveConversationId = options.liveConversationId === undefined ? conversationId : options.liveConversationId;
  const targetId = options.liveTargetId ?? 'native-target-123';
  const url = options.liveUrl ??
    (liveConversationId === null ? 'https://chatgpt.com/' : `https://chatgpt.com/c/${liveConversationId}`);
  const page = {
    pageKey: 'new-controller-page', targetId, url,
    conversationId: liveConversationId,
    sessionId: null as string | null, generation: null as number | null,
    state: 'unbound', expectedConversationId: null as string | null,
  };
  const actions: string[] = [];
  const duplicates = options.duplicateTarget ?
    [{ ...page, pageKey: 'conflicting-page' }] : [];
  const pageRegistry = {
    listBindings() { return [page, ...duplicates]; },
    refreshPage() { return { ...page }; },
    findByConversation(id: string) {
      return [page, ...duplicates].filter(binding => binding.conversationId === id);
    },
    bindPage(key: string, owner: { sessionId: string; generation: number; conversationId: string }) {
      assert.equal(key, page.pageKey);
      assert.deepEqual(owner, { sessionId: 'session-exact', generation: 4, conversationId });
      actions.push('bind-exact-conversation');
      page.sessionId = owner.sessionId; page.generation = owner.generation;
      page.expectedConversationId = owner.conversationId; page.state = 'owned';
      return page;
    },
    reservePage(key: string, owner: { sessionId: string; generation: number; conversationId: null }) {
      assert.equal(key, page.pageKey);
      assert.equal(owner.conversationId, null);
      actions.push('reserve-original-root');
      page.sessionId = owner.sessionId; page.generation = owner.generation;
      page.state = 'reserved';
      return page;
    },
    reserveUnknownConversationCandidate(key: string, owner: {
      sessionId: string; generation: number; targetId: string;
    }) {
      assert.equal(key, page.pageKey);
      assert.equal(owner.targetId, 'native-target-123');
      actions.push('reserve-read-only-candidate');
      page.sessionId = owner.sessionId; page.generation = owner.generation;
      page.state = 'identity_lost';
      return page;
    },
  };
  const input = {
    repository: {
      listCurrentPublicPageOwners() {
        return [{ taskId: 'task-exact', projectId: 'project', slotId: 'main',
          slotRevision: 1, providerConversationId: conversationId }];
      },
    },
    teamDirectory: {
      getCurrentSession() {
        return { sessionId: 'session-exact', teamId: 'project', roleKey: 'main',
          provider: 'chatgpt', generation: 4, terminal: !!options.terminalSession,
          pageKey: 'previous-controller-page', conversationId };
      },
    },
    pageBindings: {
      get(key: string) {
        assert.equal(key, 'previous-controller-page');
        return { pageKey: key, targetId: 'native-target-123', sessionId: 'session-exact',
          generation: 4, conversationId };
      },
    },
    pageRegistry,
    actorScheduler: {
      async updateGeneration(sessionId: string, generation: number,
        update: { pageKey: string }) {
        assert.equal(sessionId, 'session-exact');
        assert.equal(generation, 4);
        assert.deepEqual(update, { pageKey: 'new-controller-page' });
        actions.push('record-new-page-key');
      },
    },
    chatgptUrl: 'https://chatgpt.com',
  };
  return { input: input as unknown as Parameters<typeof restoreSemanticPageBindings>[0], actions };
}

test('Core adoption restores only the original native target and exact canonical conversation', async () => {
  const { input, actions } = fixture({ terminalSession: true });
  const report = await restoreSemanticPageBindings(input);
  assert.deepEqual(report, { scanned: 1, rebound: 1, held: 0 });
  assert.deepEqual(actions, ['bind-exact-conversation', 'record-new-page-key']);
});

test('a root POST without canonical ACK remains a read-only candidate on the retained target', async () => {
  const { input, actions } = fixture({
    conversationId: null, liveConversationId: 'unverified-page-conversation',
  });
  assert.deepEqual(await restoreSemanticPageBindings(input),
    { scanned: 1, rebound: 1, held: 0 });
  assert.deepEqual(actions, ['reserve-read-only-candidate', 'record-new-page-key']);
  assert.ok(!actions.includes('bind-exact-conversation'));
});

test('a retained unsubmitted root is reserved without opening or navigating a page', async () => {
  const { input, actions } = fixture({ conversationId: null, liveConversationId: null });
  assert.deepEqual(await restoreSemanticPageBindings(input),
    { scanned: 1, rebound: 1, held: 0 });
  assert.deepEqual(actions, ['reserve-original-root', 'record-new-page-key']);
});

test('a changed native target, foreign conversation or duplicate target is held without mutation', async () => {
  for (const options of [
    { liveTargetId: 'different-target' },
    { liveConversationId: 'foreign-conversation' },
    { duplicateTarget: true },
    { liveUrl: 'https://evil.example/c/exact-conversation' },
  ]) {
    const { input, actions } = fixture(options);
    assert.deepEqual(await restoreSemanticPageBindings(input),
      { scanned: 1, rebound: 0, held: 1 }, JSON.stringify(options));
    assert.deepEqual(actions, [], JSON.stringify(options));
  }
});
