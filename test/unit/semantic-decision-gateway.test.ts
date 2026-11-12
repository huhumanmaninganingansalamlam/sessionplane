import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { SemanticDecisionGateway } from '../../src/core/semantic-decision-gateway.ts';
import type { ExactSendIntent } from '../../src/core/durable-task-kernel.ts';
import type {
  SemanticActRequest, SemanticActResult, SemanticCapabilityManifest,
  SemanticObservation, SemanticProviderAdapter, SemanticTaskContext,
  SemanticVerification, SemanticExactQuery,
} from '../../src/providers/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../../src/providers/semantic-provider-registry.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TaskKernelRepository } from '../../src/storage/task-kernel-repository.ts';

const MANIFEST: SemanticCapabilityManifest = {
  providerKey: 'fixture-provider', browserRequired: false, contractVersion: 1,
  supports: ['conversation', 'question', 'permission', 'model_choice'],
};

type Mode = 'question' | 'free_text' | 'model' | 'power' | 'model-unready' | 'page_race' | 'permission' |
  'human' | 'oversized' | 'none';

class FakeSemanticAdapter implements SemanticProviderAdapter {
  readonly providerKey = 'fixture-provider';
  readonly capabilities = MANIFEST;
  readonly store: TaskKernelRepository;
  mode: Mode = 'question';
  observed = 0;
  clicks = 0;
  currentActionRef: string | null = null;
  throwAfterConsume = false;
  holdAction: Promise<void> | null = null;

  constructor(store: TaskKernelRepository) { this.store = store; }

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    this.observed++;
    const actionRef = 'action-' + this.observed;
    this.currentActionRef = actionRef;
    const blocker = this.mode === 'page_race' ? 'unsupported'
      : this.mode === 'permission' ? 'provider_permission'
      : this.mode === 'human' ? 'human_verification'
        : this.mode === 'none' || this.mode === 'model' || this.mode === 'power' ||
          this.mode === 'model-unready' ? 'none'
          : 'provider_question';
    const action = this.mode === 'question' || this.mode === 'free_text' ||
      this.mode === 'model' || this.mode === 'power' || this.mode === 'oversized' ? [{
        actionRef, purpose: this.mode === 'power'
          ? 'choose_reasoning_effort' as const : this.mode === 'model'
          ? 'open_model_chooser' as const : 'answer_question' as const,
        effect: 'Apply exact current choice',
        risk: this.mode === 'model' || this.mode === 'power'
          ? 'configuration_only' as const : 'send_once' as const,
        input: this.mode === 'model' || this.mode === 'power' ? { kind: 'none' as const } :
          this.mode === 'free_text' ? { kind: 'text' as const, maxLength: 20 } :
          { kind: 'option' as const, options: [
            { value: 'Proceed', enabled: true }, { value: 'Decline', enabled: false },
          ] },
        evidenceHash: 'evidence-' + this.observed,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      }] : [];
    return {
      providerKey: this.providerKey, surface: 'chat',
      capabilityManifest: this.capabilities,
      snapshotId: 'snapshot-' + this.observed,
      observedAt: new Date().toISOString(),
      blocker, progress: 'idle',
      reason: this.mode === 'page_race'
        ? 'semantic-observation-superseded-by-page-operation'
        : blocker === 'none' ? null : this.mode === 'human'
        ? 'human-verification-required' : this.mode === 'permission'
          ? 'tool-arguments-unverified' : 'provider-question-requires-decision',
      turn: { submittedUserFound: true, laterUserFound: false,
        submittedUserMessageId: context.submittedUserMessageId,
        answerMessageId: null, partialAnswer: null },
      questionText: this.mode === 'oversized' ? 'Q'.repeat(16_000) :
        blocker === 'provider_question' ? 'Choose the exact operation' : null,
      permission: this.mode === 'permission' ? {
        appName: 'HostSpan', toolName: 'file_read', visibleSummary: 'Read a file',
        argumentsSummary: null, detailState: 'redacted', evidenceHash: 'permission-hash',
        canGrant: false,
      } : null,
      actions: action, evidenceBytes: 500,
    };
  }

  async act(request: SemanticActRequest): Promise<SemanticActResult> {
    if (this.currentActionRef !== request.actionRef) {
      return { kind: 'stale', reason: 'fixture-restarted-or-action-changed' };
    }
    if (!request.authorizedDecisionId) {
      return { kind: 'authorization_required', reason: 'missing-durable-decision' };
    }
    const full = this.store.getFullTask(request.context.taskId, 'alice');
    const row = full.decisions.find(decision => decision.decisionId === request.authorizedDecisionId);
    if (!row || row.status !== 'resolved' || row.resolutionJson === null) {
      return { kind: 'authorization_required', reason: 'unresolved-decision' };
    }
    const resolution: unknown = JSON.parse(row.resolutionJson);
    if (!resolution || typeof resolution !== 'object' ||
        (resolution as { input?: unknown }).input !== (request.input ?? null) ||
        !this.store.consumeDecisionAction(request.context.taskId, 'alice', row.decisionId)) {
      return { kind: 'authorization_required', reason: 'unconsumed-decision' };
    }
    this.clicks++;
    if (this.throwAfterConsume) throw new Error('Injected crash after durable action consumption');
    if (this.holdAction) await this.holdAction;
    return { kind: 'performed', effect: this.mode === 'power' ? 'reasoning_effort_selected'
      : this.mode === 'model' ? 'model_menu_opened' : 'question_answered' };
  }

  async verify(_query: SemanticExactQuery): Promise<SemanticVerification> {
    return { kind: 'pending', reason: 'fixture-no-provider-get' };
  }
  async recover(_query: SemanticExactQuery): Promise<SemanticVerification> {
    return { kind: 'pending', reason: 'fixture-no-provider-get' };
  }
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'sessionplane-agent-gateway-'));
  const file = join(dir, 'state.sqlite');
  let db = SessionPlaneDatabase.open(file);
  let store = new TaskKernelRepository(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  store.openProject({ projectId: 'project', projectKey: 'gateway.fixture',
    displayName: 'Gateway', clientId: 'alice' });
  store.openSlot({ projectId: 'project', clientId: 'alice', slotId: 'main',
    roleKey: 'Main', providerKey: 'fixture-provider' });
  store.startTask({ taskId: 'task-1', projectId: 'project', slotId: 'main',
    expectedSlotRevision: 1, clientId: 'alice', requestId: 'request-1',
    prompt: 'Provider question prompt' });
  store.observeConversation({ projectId: 'project', slotId: 'main',
    expectedRevision: 1, clientId: 'alice', taskId: 'task-1',
    providerConversationId: 'conv-1' });
  store.planAttempt({ taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    kind: 'initial', turnKey: 'root', content: 'Provider question prompt' });
  store.beginDispatch('task-1', 'alice', 'initial-1');
  store.acknowledgeAttempt({ taskId: 'task-1', clientId: 'alice',
    attemptId: 'initial-1', externalTurnId: 'turn-1' });
  const context: SemanticTaskContext = {
    projectId: 'project', slotId: 'main', slotRevision: 1, taskId: 'task-1',
    providerConversationId: 'conv-1', submittedUserMessageId: 'user-1',
    submittedUserTurnId: 'turn-1', pageLease: null,
  };
  const getGateway = (adapter: FakeSemanticAdapter) => new SemanticDecisionGateway({
    repository: store, providers: new SemanticProviderRegistry([adapter]),
    resolveContext: (_intent: ExactSendIntent) => context,
  });
  return {
    get store() { return store; },
    getGateway,
    reopen() {
      db.close();
      db = SessionPlaneDatabase.open(file);
      store = new TaskKernelRepository(db);
      return store;
    },
  };
}

test('agent question persists, rejects disabled options and consumes one exact typed decision', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const packet = await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  });
  assert.equal(packet?.kind, 'provider_question');
  assert.equal(packet?.questionText, 'Choose the exact operation');
  assert.equal(packet?.options.length, 1);
  assert.equal(packet?.humanOnly, false);
  assert.equal(packet?.evidenceBytes, Buffer.byteLength(JSON.stringify(packet)));
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.deepEqual(gateway.get('task-1', 'alice'), packet);
  assert.equal((await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))?.decisionId, packet?.decisionId);
  assert.equal(adapter.observed, 1, 'repeat reads do not invalidate an actionable snapshot');
  const request = {
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet!.decisionId, requestId: 'decision-request-1',
    actionRef: packet!.options[0]!.actionRef,
  };
  await assert.rejects(gateway.decide({ ...request, input: 'Decline' }),
    /enabled decision schema/);
  assert.equal(adapter.clicks, 0);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.deepEqual(await gateway.decide({ ...request, input: 'Proceed' }),
    { kind: 'performed', effect: 'question_answered' });
  assert.equal(adapter.clicks, 1);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'working');
  assert.deepEqual(await gateway.decide({ ...request, input: 'Proceed' }),
    { kind: 'performed', effect: 'question_answered' });
  assert.equal(adapter.clicks, 1);
  await assert.rejects(gateway.decide({ ...request,
    requestId: 'different-request', input: 'Proceed' }), /different request/);
  assert.throws(() => gateway.get('task-1', 'mallory'), /access denied/);
});

test('offline pending decision survives SQLite reopen, then read-only refresh changes the action ref', async t => {
  const env = fixture(t);
  const oldAdapter = new FakeSemanticAdapter(env.store);
  const old = env.getGateway(oldAdapter);
  const packet = (await old.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  assert.equal(oldAdapter.clicks, 0);
  env.reopen();
  const freshAdapter = new FakeSemanticAdapter(env.store);
  const recovered = env.getGateway(freshAdapter);
  assert.deepEqual(recovered.get('task-1', 'alice'), packet);
  assert.equal(freshAdapter.observed, 0, 'reconnect never implicitly opens the provider');
  const next = (await recovered.refresh({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId,
  }))!;
  assert.equal(next.kind, 'provider_question');
  assert.notEqual(next.decisionId, packet.decisionId);
  assert.equal(freshAdapter.observed, 1);
  await assert.rejects(recovered.decide({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId, requestId: 'stale', actionRef: packet.options[0]!.actionRef,
    input: 'Proceed',
  }), /different request/);
  const selected = await recovered.decide({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: next.decisionId, requestId: 'fresh',
    actionRef: next.options[0]!.actionRef, input: 'Proceed',
  });
  assert.deepEqual(selected, { kind: 'performed', effect: 'question_answered' });
  assert.equal(freshAdapter.clicks, 1);
  assert.equal(oldAdapter.clicks, 0);
});

test('permission remains read-only; human verification is agent-delivered, not forged approval', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'permission';
  const gateway = env.getGateway(adapter);
  const pending = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  assert.equal(pending.kind, 'tool_permission');
  assert.equal(pending.humanOnly, false);
  assert.equal(pending.permission?.canGrant, false);
  assert.equal(pending.permission?.detailState, 'redacted');
  assert.deepEqual(pending.options, []);
  await assert.rejects(gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice',
    decisionId: pending.decisionId, requestId: 'no-permission-refresh',
  }), /not refreshable/, 'Empty permission packets are not model-refresh grants');
  await assert.rejects(gateway.decide({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: pending.decisionId, requestId: 'not-authorized',
    actionRef: 'invented-permission-grant',
  }), /does not authorize/);
  assert.equal(adapter.clicks, 0);
  adapter.mode = 'human';
  const changed = (await gateway.refresh({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: pending.decisionId,
  }))!;
  assert.equal(changed.kind, 'human_verification');
  assert.equal(changed.humanOnly, true);
  assert.deepEqual(changed.options, []);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'human_input_required');
  assert.deepEqual(gateway.get('task-1', 'alice'), changed);
});

test('public model reinspection recovers an unready root exactly once, never grants an action', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'model-unready';
  const gateway = env.getGateway(adapter);
  const stale = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(stale.kind, 'model_choice');
  assert.equal(stale.requestedModel, 'Pro');
  assert.deepEqual(stale.options, []);
  assert.equal(adapter.clicks, 0);
  adapter.mode = 'model';
  const refreshInput = {
    taskId: 'task-1', clientId: 'alice',
    decisionId: stale.decisionId, requestId: 'read-only-refresh-once',
  };
  const refreshed = await gateway.refreshCurrent(refreshInput);
  assert.equal(refreshed.kind, 'refresh_required');
  if (refreshed.kind !== 'refresh_required') throw new Error('Missing refresh packet');
  assert.equal(refreshed.packet?.kind, 'model_choice');
  assert.equal(refreshed.packet?.requestedModel, 'Pro');
  assert.equal(refreshed.packet?.options[0]?.purpose, 'open_model_chooser');
  assert.notEqual(refreshed.packet?.decisionId, stale.decisionId);
  assert.equal(adapter.observed, 2);
  assert.equal(adapter.clicks, 0, 'A read-only refresh must never act on the UI');
  const replay = await gateway.refreshCurrent(refreshInput);
  assert.equal(replay.kind, 'refresh_required');
  if (replay.kind !== 'refresh_required') throw new Error('Missing replay packet');
  assert.equal(replay.packet?.decisionId, refreshed.packet?.decisionId);
  assert.equal(adapter.observed, 2, 'A matching requestId cannot reobserve twice');
  await assert.rejects(gateway.refreshCurrent({ ...refreshInput, requestId: 'other-request' }),
    /different request/);
  await assert.rejects(gateway.refreshCurrent({
    ...refreshInput, decisionId: refreshed.packet!.decisionId,
  }), /not refreshable/, 'A still-valid actionable model choice must not be revoked');
  assert.equal(adapter.clicks, 0);
});

test('transient unsubmitted Pro root page race can be refreshed read-only, not clicked', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sessionplane-model-race-'));
  const db = SessionPlaneDatabase.open(join(directory, 'state.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = new TaskKernelRepository(db);
  store.openProject({ projectId: 'project-race', projectKey: 'root-race',
    displayName: 'Race', clientId: 'alice' });
  store.openSlot({ projectId: 'project-race', slotId: 'main',
    roleKey: 'Main', providerKey: 'fixture-provider', clientId: 'alice' });
  store.startTask({ taskId: 'task-race', projectId: 'project-race', slotId: 'main',
    expectedSlotRevision: 1, clientId: 'alice', requestId: 'root-1', prompt: 'Only once' });
  store.planAttempt({ taskId: 'task-race', clientId: 'alice',
    attemptId: 'attempt-race', kind: 'initial', turnKey: 'root', content: 'Only once' });
  const context: SemanticTaskContext = {
    taskId: 'task-race', projectId: 'project-race', slotId: 'main', slotRevision: 1,
    providerConversationId: null, submittedUserMessageId: null,
    submittedUserTurnId: null, requiredModel: 'Pro',
    pageLease: { projectId: 'project-race', slotId: 'main', slotRevision: 1,
      taskId: 'task-race', pageKey: 'isolated-root', targetId: 'single-target',
      bindingEpoch: 1 },
  };
  const adapter = new FakeSemanticAdapter(store);
  adapter.mode = 'page_race';
  const gateway = new SemanticDecisionGateway({
    repository: store, providers: new SemanticProviderRegistry([adapter]),
    resolveContext: () => context,
  });
  const first = (await gateway.inspect({ taskId: 'task-race', clientId: 'alice',
    attemptId: 'attempt-race', modelChoice: true, modelIntent: 'Pro' }))!;
  assert.equal(first.kind, 'adapter_unsupported');
  assert.equal(first.reason, 'semantic-observation-superseded-by-page-operation');
  assert.deepEqual(first.options, []);
  adapter.mode = 'model';
  const request = {
    taskId: 'task-race', clientId: 'alice',
    decisionId: first.decisionId, requestId: 'read-only-reobserve-1',
  };
  const refreshed = await gateway.refreshCurrent(request);
  assert.equal(refreshed.kind, 'refresh_required');
  if (refreshed.kind !== 'refresh_required') throw new Error('Missing refreshed packet');
  assert.equal(refreshed.packet?.kind, 'model_choice');
  assert.equal(refreshed.packet?.requestedModel, 'Pro');
  assert.equal(refreshed.packet?.options[0]?.purpose, 'open_model_chooser');
  assert.equal(adapter.clicks, 0, 'A race refresh must not mutate the provider UI');
  const previousObserved = adapter.observed;
  assert.equal((await gateway.refreshCurrent(request)).kind, 'refresh_required');
  assert.equal(adapter.observed, previousObserved);
  await assert.rejects(gateway.refreshCurrent({ ...request, requestId: 'different-id' }),
    /different request/);
  assert.equal(store.getFullTask('task-race', 'alice').attempts[0]?.state, 'planned');
});

test('bounded free-text and oversized evidence never broaden a provider action', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'free_text';
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  assert.equal(packet.options[0]?.inputSchema.kind, 'text');
  const request = {
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    requestId: 'free-text', decisionId: packet.decisionId,
    actionRef: packet.options[0]!.actionRef,
  };
  await assert.rejects(gateway.decide({ ...request, input: 'x'.repeat(21) }),
    /enabled decision schema/);
  assert.deepEqual(await gateway.decide({ ...request, input: 'exact answer' }),
    { kind: 'performed', effect: 'question_answered' });
  adapter.mode = 'oversized';
  const next = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  assert.equal(next.kind, 'adapter_unsupported');
  assert.equal(next.reason, 'decision-evidence-requires-bounded-expansion');
  assert.deepEqual(next.options, []);
  assert.equal(next.questionText, null);
  assert.ok(next.evidenceBytes <= 12 * 1024);
});

test('model choices require explicit inspection; unrelated idle chat does not create a decision', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'model';
  const gateway = env.getGateway(adapter);
  assert.equal(await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }), null);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true,
  }))!;
  assert.equal(packet.kind, 'model_choice');
  assert.equal(packet.options[0]?.purpose, 'open_model_chooser');
  await assert.rejects(gateway.decide({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId, actionRef: packet.options[0]!.actionRef,
    requestId: 'bad-model', input: 'Pro',
  }), /enabled decision schema/);
  assert.deepEqual(await gateway.decide({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId, actionRef: packet.options[0]!.actionRef,
    requestId: 'open-model',
  }), { kind: 'performed', effect: 'model_menu_opened' });
});

test('replayed successful decision returns its exact durable effect after Core reopen', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  const request = {
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId, requestId: 'exact-request',
    actionRef: packet.options[0]!.actionRef, input: 'Proceed',
  };
  assert.deepEqual(await gateway.decide(request),
    { kind: 'performed', effect: 'question_answered' });
  assert.equal(adapter.clicks, 1);
  env.reopen();
  const fresh = new FakeSemanticAdapter(env.store);
  const resumed = env.getGateway(fresh);
  assert.deepEqual(await resumed.decide(request),
    { kind: 'performed', effect: 'question_answered' },
    'idempotent replay must return the original durable success, not a generic resolved marker');
  assert.equal(fresh.clicks, 0, 'replay cannot run a provider action again');
  assert.equal(env.store.getFullTask('task-1', 'alice').events
    .filter(event => event.event.type === 'decision.outcome_recorded').length, 1);
});

test('resolved decision with no effect receipt is uncertain, even after restart', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  const request = {
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId, requestId: 'crashed-after-reservation',
    actionRef: packet.options[0]!.actionRef, input: 'Proceed',
  };
  env.store.resolveDecision({
    taskId: request.taskId, clientId: request.clientId, decisionId: request.decisionId,
    resolutionJson: JSON.stringify({
      kind: 'semantic_action', requestId: request.requestId,
      actionRef: request.actionRef, input: request.input,
    }),
  });
  env.reopen();
  const resumedAdapter = new FakeSemanticAdapter(env.store);
  const resumed = env.getGateway(resumedAdapter);
  assert.deepEqual(await resumed.decide(request),
    { kind: 'uncertain', reason: 'decision-effect-receipt-pending' },
    'durable reservation is not proof that the provider acted');
  assert.equal(resumedAdapter.clicks, 0);
  assert.equal(env.store.getFullTask('task-1', 'alice').decisions[0]?.actionConsumed, false);
});

test('concurrent matching decide calls execute once and never claim premature success', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  const request = {
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId, requestId: 'concurrent-request',
    actionRef: packet.options[0]!.actionRef, input: 'Proceed',
  };
  let finish!: () => void;
  adapter.holdAction = new Promise<void>(resolve => { finish = resolve; });
  const first = gateway.decide(request);
  assert.equal(adapter.clicks, 1, 'the first request reserved the exact action');
  assert.deepEqual(await gateway.decide(request),
    { kind: 'uncertain', reason: 'decision-effect-receipt-pending' },
    'a concurrent duplicate must not claim success before the effect is known');
  assert.equal(adapter.clicks, 1);
  finish();
  assert.deepEqual(await first, { kind: 'performed', effect: 'question_answered' });
  assert.deepEqual(await gateway.decide(request),
    { kind: 'performed', effect: 'question_answered' });
  assert.equal(adapter.clicks, 1);
});

test('provider error after durable consumption persists uncertain receipt without replay', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.throwAfterConsume = true;
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  const request = {
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId, requestId: 'provider-throws',
    actionRef: packet.options[0]!.actionRef, input: 'Proceed',
  };
  const first = await gateway.decide(request);
  assert.deepEqual(first, { kind: 'uncertain', reason: 'semantic-decision-effect-unverified' });
  assert.equal(adapter.clicks, 1);
  env.reopen();
  const reopened = new FakeSemanticAdapter(env.store);
  assert.deepEqual(await env.getGateway(reopened).decide(request), first);
  assert.equal(reopened.clicks, 0);
});

test('uncertain Pro Power effect remains blocked after a fresh observation and Core reopen', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'power';
  adapter.throwAfterConsume = true;
  const gateway = env.getGateway(adapter);
  const first = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(first.kind, 'model_choice');
  assert.equal(first.options.length, 1);
  assert.equal(first.options[0]!.purpose, 'choose_reasoning_effort');
  const request = {
    taskId: 'task-1', clientId: 'alice', decisionId: first.decisionId,
    requestId: 'only-power-click', actionRef: first.options[0]!.actionRef,
  };
  const failed = await gateway.decideCurrent(request);
  assert.deepEqual(failed, { kind: 'uncertain', reason: 'semantic-decision-effect-unverified' });
  assert.equal(adapter.clicks, 1);
  assert.deepEqual(await gateway.decideCurrent(request), failed,
    'idempotent recovery reads the prior outcome, never repeats the click');
  env.reopen();
  const freshAdapter = new FakeSemanticAdapter(env.store);
  freshAdapter.mode = 'power';
  const fresh = env.getGateway(freshAdapter);
  const blocked = (await fresh.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(blocked.kind, 'model_choice');
  assert.equal(blocked.requestedModel, 'Pro');
  assert.equal(blocked.reason, 'reasoning-effort-previous-action-uncertain');
  assert.deepEqual(blocked.options, [], 'no new one-shot Power action may be published');
  assert.equal(freshAdapter.clicks, 0);
  assert.equal(fresh.get('task-1', 'alice')?.decisionId, blocked.decisionId);
});

test('a legacy pending Power packet cannot bypass the uncertain-effect barrier via direct decide', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'power';
  adapter.throwAfterConsume = true;
  const gateway = env.getGateway(adapter);
  const original = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  const outcome = await gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: original.decisionId,
    requestId: 'original-one-shot-power', actionRef: original.options[0]!.actionRef,
  });
  assert.equal(outcome.kind, 'uncertain');
  assert.equal(adapter.clicks, 1);
  const stored = env.store.getFullTask('task-1', 'alice').decisions
    .find(row => row.decisionId === original.decisionId)!;
  const prior = JSON.parse(stored.contextJson);
  const legacyId = 'legacy-pending-before-guard';
  prior.packet.decisionId = legacyId;
  env.store.requireDecision({
    taskId: 'task-1', clientId: 'alice', decisionId: legacyId,
    audience: 'agent', contextJson: JSON.stringify(prior),
  });
  const pending = gateway.get('task-1', 'alice')!;
  assert.equal(pending.options[0]!.purpose, 'choose_reasoning_effort');
  await assert.rejects(gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: legacyId,
    requestId: 'different-power-attempt', actionRef: pending.options[0]!.actionRef,
  }), /previous reasoning effort action has an uncertain external effect/i);
  assert.equal(adapter.clicks, 1, 'direct RPC must not dispatch a second external click');
  const record = env.store.getFullTask('task-1', 'alice');
  assert.equal(record.task.pendingDecisionId, legacyId);
  assert.equal(record.decisions.find(row => row.decisionId === legacyId)?.status, 'pending',
    'rejected direct action must not consume or rewrite the older packet');
  const refreshed = await gateway.refresh({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: legacyId, modelChoice: true, requestId: 'read-only-reconcile',
  });
  assert.equal(refreshed?.kind, 'model_choice');
  assert.equal(refreshed?.reason, 'reasoning-effort-previous-action-uncertain');
  assert.deepEqual(refreshed?.options, [], 'read-only refresh cannot grant another Power click');
  assert.equal(adapter.clicks, 1);
});

test('a changed unconsumed provider action yields exactly one fresh durable packet', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  const request = {
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId, requestId: 'now-stale',
    actionRef: packet.options[0]!.actionRef, input: 'Proceed',
  };
  adapter.currentActionRef = 'different-action';
  const first = await gateway.decide(request);
  assert.equal(first.kind, 'refresh_required');
  if (first.kind !== 'refresh_required') throw new Error('Expected fresh packet');
  assert.notEqual(first.packet?.decisionId, packet.decisionId);
  assert.equal(adapter.clicks, 0);
  assert.deepEqual(await gateway.decide(request), first,
    'the same request receives its exact persisted refresh outcome');
  assert.equal(adapter.observed, 2, 'replay must not inspect provider a third time');
});

test('decision refuses a mismatched attempt before consuming its one-shot action', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  await assert.rejects(gateway.decide({
    taskId: 'task-1', clientId: 'alice', attemptId: 'foreign-attempt',
    decisionId: packet.decisionId, requestId: 'wrong-attempt',
    actionRef: packet.options[0]!.actionRef, input: 'Proceed',
  }), /attempt/i);
  assert.equal(adapter.clicks, 0);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
});


test('model intent appears in bounded agent packet and survives explicit refresh', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'model';
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(packet.kind, 'model_choice');
  assert.equal(packet.requestedModel, 'Pro');
  assert.equal(packet.options[0]?.purpose, 'open_model_chooser');
  assert.equal(packet.evidenceBytes, Buffer.byteLength(JSON.stringify(packet)));
  const next = (await gateway.refresh({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: packet.decisionId,
  }))!;
  assert.notEqual(next.decisionId, packet.decisionId);
  assert.equal(next.requestedModel, 'Pro',
    'refresh must not accidentally drop the requested model');
  assert.equal(adapter.clicks, 0, 'model inspection does not click');
});
