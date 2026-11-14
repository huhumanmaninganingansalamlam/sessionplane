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

type Mode = 'question' | 'free_text' | 'model' | 'model-verified' | 'power' | 'model-unready' | 'page_race' | 'surface_unverified' | 'permission' |
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
  expiresOffsetMs = 120_000;
  holdAction: Promise<void> | null = null;

  constructor(store: TaskKernelRepository) { this.store = store; }

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    this.observed++;
    const actionRef = 'action-' + this.observed;
    this.currentActionRef = actionRef;
    const blocker = this.mode === 'page_race' || this.mode === 'surface_unverified' ? 'unsupported'
      : this.mode === 'permission' ? 'provider_permission'
      : this.mode === 'human' ? 'human_verification'
        : this.mode === 'none' || this.mode === 'model' ||
          this.mode === 'model-verified' || this.mode === 'power' ||
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
        expiresAt: new Date(Date.now() + this.expiresOffsetMs).toISOString(),
      }] : [];
    return {
      providerKey: this.providerKey, surface: 'chat',
      capabilityManifest: this.capabilities,
      snapshotId: 'snapshot-' + this.observed,
      observedAt: new Date().toISOString(),
      blocker, progress: 'idle',
      reason: this.mode === 'surface_unverified' ? 'chat-surface-unverified'
        : this.mode === 'page_race'
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
      actions: action,
      verifiedModel: this.mode === 'model-verified' ? 'Pro' : null,
      evidenceBytes: 500,
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

function fixture(t: TestContext, options: { plannedInitial?: boolean; requiredModel?: string } = {}) {
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
  if (options.plannedInitial !== true) {
    store.beginDispatch('task-1', 'alice', 'initial-1');
    store.acknowledgeAttempt({ taskId: 'task-1', clientId: 'alice',
      attemptId: 'initial-1', externalTurnId: 'turn-1' });
  }
  const context: SemanticTaskContext = {
    projectId: 'project', slotId: 'main', slotRevision: 1, taskId: 'task-1',
    providerConversationId: 'conv-1',
    submittedUserMessageId: options.plannedInitial ? null : 'user-1',
    submittedUserTurnId: options.plannedInitial ? null : 'turn-1',
    pageLease: options.plannedInitial ? {
      projectId: 'project', slotId: 'main', slotRevision: 1, taskId: 'task-1',
      pageKey: 'fixture-owned-page', targetId: 'fixture-owned-target', bindingEpoch: 1,
    } : null,
    ...(options.requiredModel ? { requiredModel: options.requiredModel } : {}),
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

test('owned canonical Main load failure offers a bounded read-only refresh without a second POST', async t => {
  const env = fixture(t, { plannedInitial: true });
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'surface_unverified';
  const gateway = env.getGateway(adapter);
  const first = await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  });
  assert.equal(first?.kind, 'adapter_unsupported');
  assert.equal(first?.reason, 'chat-surface-unverified');
  assert.deepEqual(first?.options, []);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
  await assert.rejects(() => gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: first!.decisionId,
    requestId: 'invented-post', actionRef: 'invented-send',
  }), /does not authorize/);

  const stillBlocked = await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: first!.decisionId,
    requestId: 'bound-load-refresh-1',
  });
  assert.equal(stillBlocked.kind, 'refresh_required');
  assert.equal(stillBlocked.packet?.reason, 'chat-surface-unverified');
  assert.notEqual(stillBlocked.packet?.decisionId, first?.decisionId);
  assert.deepEqual(await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: first!.decisionId,
    requestId: 'bound-load-refresh-1',
  }), stillBlocked, 'a replay can only read the next pending packet');
  assert.equal(adapter.clicks, 0);
  assert.equal(env.store.getFullTask('task-1', 'alice').attempts.length, 1);
  assert.equal(env.store.getFullTask('task-1', 'alice').attempts[0]!.state, 'planned');

  adapter.mode = 'none';
  assert.deepEqual(await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice',
    decisionId: stillBlocked.packet!.decisionId,
    requestId: 'bound-load-refresh-2',
  }), { kind: 'refresh_required', packet: null });
  assert.equal(env.store.getTask('task-1', 'alice').state, 'working');
  assert.equal(env.store.getFullTask('task-1', 'alice').attempts.length, 1);
  assert.equal(env.store.getFullTask('task-1', 'alice').attempts[0]!.state, 'planned');
  assert.equal(adapter.clicks, 0, 'refresh must never click a provider control');

  const submitted = fixture(t);
  const submittedAdapter = new FakeSemanticAdapter(submitted.store);
  submittedAdapter.mode = 'surface_unverified';
  const submittedGateway = submitted.getGateway(submittedAdapter);
  const submittedPacket = await submittedGateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  });
  await assert.rejects(() => submittedGateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice',
    decisionId: submittedPacket!.decisionId, requestId: 'wrong-boundary',
  }), /Current decision is not refreshable/);
  assert.equal(submitted.store.getFullTask('task-1', 'alice').attempts[0]!.state, 'acknowledged');
});

test('persistent canonical 429 creates a reasoned, agent-first decision on the original ACK', async t => {
  const env = fixture(t);
  const gateway = env.getGateway(new FakeSemanticAdapter(env.store));
  const packet = await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    cause: 'persistent_backend_read_throttle',
  });
  assert.equal(packet?.kind, 'recovery_choice');
  assert.equal(packet?.reason, 'canonical-final-rate-limit-persistent');
  assert.equal(packet?.humanOnly, false, 'agent decides whether human assistance is necessary');
  assert.deepEqual(packet?.options, [], 'transport throttle cannot license a replay POST');
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.equal((await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    cause: 'persistent_backend_read_throttle',
  }))?.decisionId, packet?.decisionId, 'repeat scans preserve the pending decision');
});

test('unanswered continuation creates durable agent review; refresh is read-only and late FINAL completes', async t => {
  const env = fixture(t);
  env.store.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    kind: 'continuation', turnKey: 'managed-continue-1', content: '계속',
  });
  env.store.beginDispatch('task-1', 'alice', 'continue-1');
  env.store.acknowledgeAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    externalTurnId: 'turn-2',
  });
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'none';
  const gateway = env.getGateway(adapter);
  const packet = await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
  });
  assert.equal(packet?.kind, 'recovery_choice');
  assert.equal(packet?.reason, 'managed-continuation-no-final-after-approved-continue');
  assert.equal(packet?.humanOnly, false);
  assert.deepEqual(packet?.options, []);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.equal(gateway.get('task-1', 'alice')?.decisionId, packet?.decisionId);
  await assert.rejects(() => gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    requestId: 'cannot-retry-post', actionRef: 'invented-send',
  }), /does not authorize/);
  const refreshed = await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    requestId: 'agent-refresh-1',
  });
  assert.deepEqual(refreshed, { kind: 'refresh_required', packet: null });
  assert.equal(env.store.getTask('task-1', 'alice').state, 'working');
  assert.equal(adapter.clicks, 0);
  assert.deepEqual(await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    requestId: 'agent-refresh-1',
  }), refreshed, 'same request replays the read-only result');

  const second = await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
  });
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.throws(() => env.store.recordFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    resultId: 'nonterminal-wrong', externalTurnId: 'turn-2',
    answerText: 'Pending review must persist', completeTask: false,
  }), /Invalid task transition/);
  assert.equal(env.store.getTask('task-1', 'alice').pendingDecisionId, second!.decisionId);
  env.store.recordFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    resultId: 'result-final-1', externalTurnId: 'turn-2',
    answerText: 'Exact FINAL finally arrived', completeTask: true,
  });
  const completed = env.store.getFullTask('task-1', 'alice');
  assert.equal(completed.task.state, 'completed');
  assert.equal(completed.task.pendingDecisionId, null);
  assert.equal(completed.decisions.find(row => row.decisionId === second!.decisionId)?.status,
    'superseded');
  assert.equal(gateway.get('task-1', 'alice'), null);
  assert.equal(adapter.clicks, 0);
});

test('agent-first stall packet persists without a live browser context', async t => {
  const env = fixture(t);
  env.store.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-lost-page',
    kind: 'continuation', turnKey: 'managed-lost-page', content: '계속',
  });
  env.store.beginDispatch('task-1', 'alice', 'continue-lost-page');
  env.store.acknowledgeAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-lost-page',
    externalTurnId: 'turn-lost-page',
  });
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = new SemanticDecisionGateway({
    repository: env.store, providers: new SemanticProviderRegistry([adapter]),
    resolveContext: () => { throw new Error('Owned page disappeared'); },
  });
  const packet = await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-lost-page',
  });
  assert.equal(packet?.kind, 'recovery_choice');
  assert.equal(packet?.humanOnly, false);
  assert.deepEqual(packet?.options, []);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.equal(gateway.get('task-1', 'alice')?.decisionId, packet?.decisionId);
  assert.equal(adapter.observed, 0);
  assert.equal(adapter.clicks, 0);
});


test('an unsendable approved Continue becomes a durable actionless agent packet before POST', async t => {
  const env = fixture(t);
  const approval = JSON.stringify({
    contract: 'approved_continuation_v1', approvalRef: 'verified-original',
    sourceAttemptId: 'initial-1', message: '계속', intervalMs: 1_200_000,
  });
  env.store.scheduleTimer({
    taskId: 'task-1', clientId: 'alice', timerId: 'continuation-due:initial-1',
    kind: 'continuation_due', dueAt: new Date(Date.now() - 10_000).toISOString(),
    contextJson: approval,
  });
  assert.equal(env.store.claimDueTimers(new Date().toISOString(), 1, 'continuation_due').length, 1);
  env.store.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-planned',
    kind: 'continuation', turnKey: 'managed-unable-to-send', content: '계속',
  });
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'none';
  const gateway = env.getGateway(adapter);
  const packet = await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-planned',
  });
  assert.equal(packet?.kind, 'recovery_choice');
  assert.equal(packet?.reason, 'managed-continuation-safe-send-unavailable');
  assert.equal(packet?.humanOnly, false);
  assert.deepEqual(packet?.options, []);
  const full = env.store.getFullTask('task-1', 'alice');
  assert.equal(full.task.state, 'agent_input_required');
  assert.equal(full.attempts[1]!.state, 'planned');
  assert.equal(full.attempts[1]!.dispatchedAt, null);
  assert.equal(adapter.observed, 0);
  assert.equal(adapter.clicks, 0);
  const refreshed = await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    requestId: 'read-only-after-unsafe-send',
  });
  assert.equal(refreshed.kind, 'refresh_required');
  const resumed = env.store.getFullTask('task-1', 'alice');
  assert.equal(resumed.attempts[1]!.state, 'planned');
  assert.equal(resumed.task.state, 'working');
  const timer = resumed.timers.find(row =>
    row.timerId === 'continuation-agent-resume:' + packet!.decisionId);
  assert.equal(timer?.status, 'pending');
  assert.equal(timer?.contextJson, approval);
  assert.deepEqual(await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    requestId: 'read-only-after-unsafe-send',
  }), refreshed, 'same read-only request must not schedule another timer');
  assert.equal(env.store.getFullTask('task-1', 'alice').attempts.length, 2);
});

test('an exact initial ACK with a foreign later turn requires agent judgment, not Continue', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const packet = await env.getGateway(adapter).requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  });
  assert.equal(packet?.kind, 'recovery_choice');
  assert.equal(packet?.reason, 'managed-continuation-later-user-boundary');
  assert.deepEqual(packet?.options, []);
  assert.equal(env.store.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.equal(env.store.getFullTask('task-1', 'alice').attempts.length, 1);
  assert.equal(adapter.clicks, 0);
});

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

test('read-only refresh clears a stale model chooser after exact external selection without a new click', async t => {
  const env = fixture(t, { plannedInitial: true, requiredModel: 'Pro' });
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'model';
  adapter.expiresOffsetMs = -1_000;
  const gateway = env.getGateway(adapter);
  const original = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(original.kind, 'model_choice');
  assert.equal(original.options[0]?.purpose, 'open_model_chooser');
  adapter.mode = 'model-verified'; // External user changed the UI; no Core click.
  const input = {
    taskId: 'task-1', clientId: 'alice',
    decisionId: original.decisionId, requestId: 'read-only-external-model',
  };
  assert.deepEqual(await gateway.refreshCurrent(input),
    { kind: 'refresh_required', packet: null });
  const after = env.store.getFullTask('task-1', 'alice');
  assert.equal(after.task.pendingDecisionId, null);
  assert.equal(after.task.state, 'working');
  assert.equal(after.attempts[0]?.state, 'planned');
  assert.equal(adapter.clicks, 0);
  assert.deepEqual(await gateway.refreshCurrent(input),
    { kind: 'refresh_required', packet: null },
    'idempotent replay must not create another model packet when Pro is verified');
  assert.equal(env.store.getFullTask('task-1', 'alice').decisions.length, 1);
});

test('historically uncertain Power choice can be reconciled only by current exact external Pro evidence', async t => {
  const env = fixture(t, { plannedInitial: true, requiredModel: 'Pro' });
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'power';
  adapter.throwAfterConsume = true;
  const gateway = env.getGateway(adapter);
  const original = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(original.options[0]?.purpose, 'choose_reasoning_effort');
  const first = await gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice',
    decisionId: original.decisionId, requestId: 'one-uncertain-power',
    actionRef: original.options[0]!.actionRef,
  });
  assert.equal(first.kind, 'uncertain');
  assert.equal(adapter.clicks, 1);
  // A new Core process must reconstruct the barrier from SQLite, not from
  // the adapter's volatile action-ref cache or a surviving agent session.
  env.reopen();
  const restartedAdapter = new FakeSemanticAdapter(env.store);
  restartedAdapter.mode = 'power';
  const restartedGateway = env.getGateway(restartedAdapter);
  const blocked = (await restartedGateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(blocked.reason, 'reasoning-effort-previous-action-uncertain');
  assert.deepEqual(blocked.options, []);
  const request = { taskId: 'task-1', clientId: 'alice',
    decisionId: blocked.decisionId, requestId: 'read-only-review-pro' };
  // First refresh without verified Pro retains the durable barrier.
  const noPro = await restartedGateway.refreshCurrent(request);
  assert.equal(noPro.kind, 'refresh_required');
  assert.equal(noPro.packet?.reason, 'reasoning-effort-previous-action-uncertain');
  assert.deepEqual(noPro.packet?.options, []);
  assert.equal(adapter.clicks, 1);
  // A separate later read-only refresh observes the user's external Pro
  // selection; it never replays the historically uncertain Power click.
  restartedAdapter.mode = 'model-verified';
  const reconcile = { taskId: 'task-1', clientId: 'alice',
    decisionId: noPro.packet!.decisionId, requestId: 'read-only-now-exact-pro' };
  assert.deepEqual(await restartedGateway.refreshCurrent(reconcile),
    { kind: 'refresh_required', packet: null });
  assert.deepEqual(await restartedGateway.refreshCurrent(reconcile),
    { kind: 'refresh_required', packet: null });
  const after = env.store.getFullTask('task-1', 'alice');
  assert.equal(after.task.pendingDecisionId, null);
  assert.equal(after.task.state, 'working');
  assert.equal(after.attempts[0]?.state, 'planned');
  assert.equal(adapter.clicks, 1, "historical Core's one uncertain click remains the only click");
  assert.equal(restartedAdapter.clicks, 0,
    'read-only restart/reconciliation may not execute any new provider click');
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
