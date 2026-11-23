import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
import { createKernelStores, type KernelStores } from '../../src/storage/kernel/create-kernel-stores.ts';

const MANIFEST: SemanticCapabilityManifest = {
  providerKey: 'fixture-provider', browserRequired: false, contractVersion: 1,
  supports: ['conversation', 'question', 'permission', 'model_choice'],
};

type Mode = 'question' | 'free_text' | 'model' | 'model-verified' | 'power' | 'model-unready' | 'page_race' | 'surface_unverified' | 'permission' |
  'human' | 'oversized' | 'multi_model' | 'many_model' | 'none';

class FakeSemanticAdapter implements SemanticProviderAdapter {
  readonly providerKey = 'fixture-provider';
  readonly capabilities = MANIFEST;
  readonly store: KernelStores;
  mode: Mode = 'question';
  observed = 0;
  clicks = 0;
  currentActionRef: string | null = null;
  throwAfterConsume = false;
  expiresOffsetMs = 120_000;
  holdAction: Promise<void> | null = null;

  constructor(store: KernelStores) { this.store = store; }

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    this.observed++;
    const actionRef = 'action-' + this.observed;
    this.currentActionRef = actionRef;
    const blocker = this.mode === 'page_race' || this.mode === 'surface_unverified' ? 'unsupported'
      : this.mode === 'permission' ? 'provider_permission'
      : this.mode === 'human' ? 'human_verification'
        : this.mode === 'none' || this.mode === 'model' ||
          this.mode === 'model-verified' || this.mode === 'power' ||
          this.mode === 'model-unready' || this.mode === 'multi_model' ||
          this.mode === 'many_model' ? 'none'
          : 'provider_question';
    const action = this.mode === 'question' || this.mode === 'free_text' ||
      this.mode === 'model' || this.mode === 'power' || this.mode === 'oversized' || this.mode === 'multi_model' ? [{
        actionRef, purpose: this.mode === 'power'
          ? 'choose_reasoning_effort' as const : this.mode === 'model' || this.mode === 'multi_model'
          ? 'open_model_chooser' as const : 'answer_question' as const,
        effect: 'Apply exact current choice',
        risk: this.mode === 'model' || this.mode === 'multi_model' || this.mode === 'power'
          ? 'configuration_only' as const : 'send_once' as const,
        input: this.mode === 'model' || this.mode === 'multi_model' || this.mode === 'power' ? { kind: 'none' as const } :
          this.mode === 'free_text' ? { kind: 'text' as const, maxLength: 20 } :
          { kind: 'option' as const, options: [
            { value: 'Proceed', enabled: true }, { value: 'Decline', enabled: false },
          ] },
        evidenceHash: 'evidence-' + this.observed,
        expiresAt: new Date(Date.now() + this.expiresOffsetMs).toISOString(),
      }] : [];
    if (this.mode === 'multi_model') {
      action.push({
        actionRef: actionRef + '-close', purpose: 'close_model_chooser' as const,
        effect: 'Close the exact current model chooser', risk: 'configuration_only' as const,
        input: { kind: 'none' as const }, evidenceHash: 'evidence-close-' + this.observed,
        expiresAt: new Date(Date.now() + this.expiresOffsetMs).toISOString(),
      });
    }
    if (this.mode === 'many_model') {
      for (let index = 0; index < 80; index++) {
        action.push({
          actionRef: `${actionRef}-candidate-${index}`,
          purpose: 'open_model_chooser' as const,
          effect: `Inspect exact current model control ${index}`,
          risk: 'configuration_only' as const,
          input: { kind: 'none' as const },
          evidenceHash: `evidence-${this.observed}-${index}`,
          expiresAt: new Date(Date.now() + this.expiresOffsetMs).toISOString(),
        });
      }
    }
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
    if (this.mode === 'many_model'
      ? !request.actionRef.startsWith(this.currentActionRef + '-candidate-')
      : this.currentActionRef !== request.actionRef) {
      return { kind: 'stale', reason: 'fixture-restarted-or-action-changed' };
    }
    if (!request.authorizedDecisionId) {
      return { kind: 'authorization_required', reason: 'missing-durable-decision' };
    }
    const full = this.store.tasks.readTaskAggregate(request.context.taskId, 'alice');
    const row = full.decisions.find(decision => decision.decisionId === request.authorizedDecisionId);
    if (!row || row.status !== 'resolved' || row.resolutionJson === null) {
      return { kind: 'authorization_required', reason: 'unresolved-decision' };
    }
    const resolution: unknown = JSON.parse(row.resolutionJson);
    if (!resolution || typeof resolution !== 'object' ||
        (resolution as { input?: unknown }).input !== (request.input ?? null) ||
        !this.store.decisions.consumeDecisionAction(request.context.taskId, 'alice', row.decisionId)) {
      return { kind: 'authorization_required', reason: 'unconsumed-decision' };
    }
    this.clicks++;
    if (this.throwAfterConsume) throw new Error('Injected crash after durable action consumption');
    if (this.holdAction) await this.holdAction;
    return { kind: 'performed', effect: this.mode === 'power' ? 'reasoning_effort_selected'
      : this.mode === 'model' || this.mode === 'many_model'
        ? 'model_menu_opened' : 'question_answered' };
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
  let store = createKernelStores(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  store.projects.openProject({ projectId: 'project', projectKey: 'gateway.fixture',
    displayName: 'Gateway', clientId: 'alice' });
  store.projects.openConversationSlot({ projectId: 'project', clientId: 'alice', slotId: 'main',
    roleKey: 'Main', providerKey: 'fixture-provider' });
  store.tasks.createTask({ taskId: 'task-1', projectId: 'project', slotId: 'main',
    expectedSlotRevision: 1, clientId: 'alice', requestId: 'request-1',
    prompt: 'Provider question prompt' });
  store.projects.bindObservedConversation({ projectId: 'project', slotId: 'main',
    expectedRevision: 1, clientId: 'alice', taskId: 'task-1',
    providerConversationId: 'conv-1' });
  store.attempts.planAttempt({ taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    kind: 'initial', turnKey: 'root', content: 'Provider question prompt' });
  if (options.plannedInitial !== true) {
    store.attempts.reserveAttemptDispatch('task-1', 'alice', 'initial-1');
    store.attempts.acknowledgeAttempt({ taskId: 'task-1', clientId: 'alice',
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
  const getGateway = (adapter: FakeSemanticAdapter, onTaskResumed?: (input: {
    taskId: string; clientId: string; attemptId: string;
    mode: 'wait' | 'resume' | 'provider_effect';
  }) => Promise<void>) => new SemanticDecisionGateway({
    repository: store, providers: new SemanticProviderRegistry([adapter]),
    resolveContext: (_intent: ExactSendIntent) => context,
    ...(onTaskResumed ? { onTaskResumed } : {}),
  });
  return {
    get store() { return store; },
    getGateway,
    reopen() {
      db.close();
      db = SessionPlaneDatabase.open(file);
      store = createKernelStores(db);
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
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
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
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').attempts.length, 1);
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').attempts[0]!.state, 'planned');

  adapter.mode = 'none';
  assert.deepEqual(await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice',
    decisionId: stillBlocked.packet!.decisionId,
    requestId: 'bound-load-refresh-2',
  }), { kind: 'refresh_required', packet: null });
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'working');
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').attempts.length, 1);
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').attempts[0]!.state, 'planned');
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
  assert.equal(submitted.store.tasks.readTaskAggregate('task-1', 'alice').attempts[0]!.state, 'acknowledged');
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
  assert.ok((packet?.controls?.length ?? 0) > 0, 'agent handoff must expose safe task controls');
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.equal((await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    cause: 'persistent_backend_read_throttle',
  }))?.decisionId, packet?.decisionId, 'repeat scans preserve the pending decision');
});

test('persistent 429 review can be explicitly reobserved after restart without any provider action', async t => {
  const env = fixture(t);
  const initial = env.getGateway(new FakeSemanticAdapter(env.store));
  const packet = await initial.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    cause: 'persistent_backend_read_throttle',
  });
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
  env.reopen();
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'none';
  const resumed = env.getGateway(adapter);
  await assert.rejects(() => resumed.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    requestId: 'forged-action', actionRef: 'invented-provider-action',
  }), /stale|option|decision/i);
  const refresh = {
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    requestId: 'explicit-read-only-review',
  };
  assert.deepEqual(await resumed.refreshCurrent(refresh),
    { kind: 'refresh_required', packet: null });
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'working');
  assert.equal(env.store.tasks.getTask('task-1', 'alice').pendingDecisionId, null);
  assert.deepEqual(await resumed.refreshCurrent(refresh),
    { kind: 'refresh_required', packet: null }, 'replayed receipt is read-only');
  await assert.rejects(() => resumed.refreshCurrent({
    ...refresh, requestId: 'another-agent-request',
  }), /different request|stale/i);
  assert.equal(adapter.clicks, 0);
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').attempts.length, 1);
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').attempts[0]!.state, 'acknowledged');
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').results.length, 0);
});

test('unanswered continuation creates durable agent review; refresh is read-only and late FINAL completes', async t => {
  const env = fixture(t);
  env.store.attempts.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    kind: 'continuation', turnKey: 'managed-continue-1', content: '계속',
  });
  env.store.attempts.reserveAttemptDispatch('task-1', 'alice', 'continue-1');
  env.store.attempts.acknowledgeAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    externalTurnId: 'turn-2',
  });
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'none';
  const gateway = env.getGateway(adapter);
  const packet = await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    cause: 'repeated_no_progress',
  });
  assert.equal(packet?.kind, 'recovery_choice');
  assert.equal(packet?.reason, 'managed-continuation-no-progress-policy-reached');
  assert.equal(packet?.humanOnly, false);
  assert.ok(packet?.controls.some(control => control.purpose === 'resume'),
    'stalled continuation must expose an actual resume path');
  const historyPage = gateway.readEvidence({
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    section: 'current_attempt', maxBytes: 12 * 1024,
  });
  const history = JSON.parse(historyPage.text) as { attemptHistory: unknown[] };
  assert.equal(history.attemptHistory.length, 2);
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
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
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'working');
  assert.equal(adapter.clicks, 0);
  assert.deepEqual(await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet!.decisionId,
    requestId: 'agent-refresh-1',
  }), refreshed, 'same request replays the read-only result');

  const second = await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
  });
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.throws(() => env.store.tasks.recordTaskFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    resultId: 'nonterminal-wrong', externalTurnId: 'turn-2',
    answerText: 'Pending review must persist', completeTask: false,
  }), /Invalid task transition/);
  assert.equal(env.store.tasks.getTask('task-1', 'alice').pendingDecisionId, second!.decisionId);
  env.store.tasks.recordTaskFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    resultId: 'result-final-1', externalTurnId: 'turn-2',
    answerText: 'Exact FINAL finally arrived', completeTask: true,
  });
  const completed = env.store.tasks.readTaskAggregate('task-1', 'alice');
  assert.equal(completed.task.state, 'completed');
  assert.equal(completed.task.pendingDecisionId, null);
  assert.equal(completed.decisions.find(row => row.decisionId === second!.decisionId)?.status,
    'superseded');
  assert.equal(gateway.get('task-1', 'alice'), null);
  assert.equal(adapter.clicks, 0);
});

test('agent-first stall packet persists without a live browser context', async t => {
  const env = fixture(t);
  env.store.attempts.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-lost-page',
    kind: 'continuation', turnKey: 'managed-lost-page', content: '계속',
  });
  env.store.attempts.reserveAttemptDispatch('task-1', 'alice', 'continue-lost-page');
  env.store.attempts.acknowledgeAttempt({
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
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
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
  env.store.timers.scheduleTaskTimer({
    taskId: 'task-1', clientId: 'alice', timerId: 'continuation-due:initial-1',
    kind: 'continuation_due', dueAt: new Date(Date.now() - 10_000).toISOString(),
    contextJson: approval,
  });
  assert.equal(env.store.timers.claimDueTaskTimers(new Date().toISOString(), 1, 'continuation_due').length, 1);
  env.store.attempts.planAttempt({
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
  const full = env.store.tasks.readTaskAggregate('task-1', 'alice');
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
  const resumed = env.store.tasks.readTaskAggregate('task-1', 'alice');
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
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').attempts.length, 2);
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
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').attempts.length, 1);
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
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
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
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
  assert.deepEqual(await gateway.decide({ ...request, input: 'Proceed' }),
    { kind: 'performed', effect: 'question_answered' });
  assert.equal(adapter.clicks, 1);
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'working');
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
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'human_input_required');
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
  const store = createKernelStores(db);
  store.projects.openProject({ projectId: 'project-race', projectKey: 'root-race',
    displayName: 'Race', clientId: 'alice' });
  store.projects.openConversationSlot({ projectId: 'project-race', slotId: 'main',
    roleKey: 'Main', providerKey: 'fixture-provider', clientId: 'alice' });
  store.tasks.createTask({ taskId: 'task-race', projectId: 'project-race', slotId: 'main',
    expectedSlotRevision: 1, clientId: 'alice', requestId: 'root-1', prompt: 'Only once' });
  store.attempts.planAttempt({ taskId: 'task-race', clientId: 'alice',
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
  assert.equal(store.tasks.readTaskAggregate('task-race', 'alice').attempts[0]?.state, 'planned');
});

test('transient unsubmitted Pro root Chat hydration can be refreshed without any provider POST', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'sessionplane-model-race-'));
  const db = SessionPlaneDatabase.open(join(directory, 'state.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const store = createKernelStores(db);
  store.projects.openProject({ projectId: 'project-race', projectKey: 'root-race',
    displayName: 'Race', clientId: 'alice' });
  store.projects.openConversationSlot({ projectId: 'project-race', slotId: 'main',
    roleKey: 'Main', providerKey: 'fixture-provider', clientId: 'alice' });
  store.tasks.createTask({ taskId: 'task-race', projectId: 'project-race', slotId: 'main',
    expectedSlotRevision: 1, clientId: 'alice', requestId: 'root-1', prompt: 'Only once' });
  store.attempts.planAttempt({ taskId: 'task-race', clientId: 'alice',
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
  adapter.mode = 'surface_unverified';
  const gateway = new SemanticDecisionGateway({
    repository: store, providers: new SemanticProviderRegistry([adapter]),
    resolveContext: () => context,
  });
  const first = (await gateway.inspect({ taskId: 'task-race', clientId: 'alice',
    attemptId: 'attempt-race', modelChoice: true, modelIntent: 'Pro' }))!;
  assert.equal(first.kind, 'adapter_unsupported');
  assert.equal(first.reason, 'chat-surface-unverified');
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
  assert.equal(store.tasks.readTaskAggregate('task-race', 'alice').attempts[0]?.state, 'planned');
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
  assert.equal(next.kind, 'provider_question');
  assert.equal(next.reason, 'provider-question-requires-decision');
  assert.equal(next.options.length, 1, 'large evidence must not delete the executable choice');
  assert.match(next.questionText ?? '', /^Q+$/,
    'the default packet keeps a useful question page instead of replacing it with unsupported');
});

test('multiple relevant provider actions are all preserved for agent selection', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'multi_model';
  const packet = (await env.getGateway(adapter).inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1', modelChoice: true,
  }))!;
  assert.equal(packet.kind, 'model_choice');
  assert.deepEqual(packet.options.map(option => option.purpose),
    ['open_model_chooser', 'close_model_chooser']);
});

test('large decision evidence is paged without deleting the exact provider action', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'oversized';
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  const section = packet.evidenceSections.find(item => item.section === 'provider_question')!;
  assert.equal(section.totalBytes, 16_000);
  assert.ok(section.nextCursor !== null);
  assert.equal(packet.options.length, 1);
  assert.ok(packet.evidenceBytes <= 12 * 1024,
    'default packet stays bounded while full evidence remains pageable');
  let cursor = 0;
  let restored = '';
  do {
    const page = gateway.readEvidence({
      taskId: 'task-1', clientId: 'alice', decisionId: packet.decisionId,
      section: 'provider_question', cursor, maxBytes: 1024,
    });
    restored += page.text;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  } while (true);
  assert.equal(restored, 'Q'.repeat(16_000));
});

test('large candidate catalogs stay bounded, page fully, and later exact actions remain selectable', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'many_model';
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1', modelChoice: true,
  }))!;
  assert.equal(packet.optionCount, 80);
  assert.ok(packet.options.length > 0 && packet.options.length < 80);
  assert.ok(packet.evidenceBytes <= 12 * 1024);
  let cursor = 0;
  let json = '';
  while (true) {
    const page = gateway.readEvidence({
      taskId: 'task-1', clientId: 'alice', decisionId: packet.decisionId,
      section: 'decision_options', cursor, maxBytes: 2_048,
    });
    json += page.text;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const catalog = JSON.parse(json) as Array<{ actionRef: string }>;
  assert.equal(catalog.length, 80);
  const last = catalog.at(-1)!;
  assert.ok(!packet.options.some(option => option.actionRef === last.actionRef));
  assert.deepEqual(await gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet.decisionId,
    requestId: 'select-paged-action', actionRef: last.actionRef,
  }), { kind: 'performed', effect: 'model_menu_opened' });
  assert.equal(adapter.clicks, 1);
});

test('agent resume control resolves the same Task and triggers Core progress exactly once', async t => {
  const env = fixture(t);
  env.store.attempts.planAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    kind: 'continuation', turnKey: 'continue-1', content: '계속',
  });
  env.store.attempts.reserveAttemptDispatch('task-1', 'alice', 'continue-1');
  env.store.attempts.acknowledgeAttempt({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
    externalTurnId: 'continue-turn-1',
  });
  const resumed: string[] = [];
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter, async input => { resumed.push(input.mode); });
  const packet = (await gateway.requireNoProgressReview({
    taskId: 'task-1', clientId: 'alice', attemptId: 'continue-1',
  }))!;
  const resume = packet.controls.find(control => control.purpose === 'resume')!;
  const selected = {
    taskId: 'task-1', clientId: 'alice', decisionId: packet.decisionId,
    requestId: 'resume-same-task', actionRef: resume.actionRef,
  };
  assert.deepEqual(await gateway.decideCurrent(selected),
    { kind: 'performed', effect: 'task_resumed' });
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'working');
  assert.equal(env.store.tasks.getTask('task-1', 'alice').pendingDecisionId, null);
  assert.deepEqual(resumed, ['resume']);
  assert.deepEqual(await gateway.decideCurrent(selected),
    { kind: 'performed', effect: 'task_resumed' });
  assert.deepEqual(resumed, ['resume'], 'idempotent replay never schedules progress twice');
});

test('agent can escalate an exact decision to a durable human request', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  const escalate = packet.controls.find(control => control.purpose === 'request_human')!;
  const selection = {
    taskId: 'task-1', clientId: 'alice', decisionId: packet.decisionId,
    requestId: 'ask-human', actionRef: escalate.actionRef,
  };
  assert.deepEqual(await gateway.decideCurrent(selection),
    { kind: 'performed', effect: 'human_assistance_requested' });
  assert.deepEqual(await gateway.decideCurrent(selection),
    { kind: 'performed', effect: 'human_assistance_requested' },
    'a lost response replays the atomic receipt without creating another human request');
  const current = env.store.tasks.getTask('task-1', 'alice');
  assert.equal(current.state, 'human_input_required');
  const human = gateway.get('task-1', 'alice')!;
  assert.equal(human.humanOnly, true);
  assert.equal(human.reason, 'agent-requested-human-assistance');
  assert.equal(human.options.length, 0);
  assert.ok(human.controls.some(control => control.purpose === 'reobserve'));
  const full = env.store.tasks.readTaskAggregate('task-1', 'alice');
  assert.equal(full.decisions.filter(row => row.audience === 'human').length, 1);
  const source = full.decisions.find(row => row.decisionId === packet.decisionId)!;
  assert.equal(source.status, 'resolved');
  assert.equal(source.actionConsumed, true);
  assert.deepEqual((JSON.parse(source.resolutionJson!) as any).outcome,
    { kind: 'performed', effect: 'human_assistance_requested' });
  assert.deepEqual(full.events.slice(-4).map(row => row.event.type), [
    'decision.resolved', 'decision.action_consumed',
    'decision.outcome_recorded', 'decision.required',
  ]);
});

test('human assistance resolution is reobserved and resumes the same Task without a provider replay', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'human';
  const gateway = env.getGateway(adapter);
  const packet = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  assert.equal(packet.humanOnly, true);
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'human_input_required');
  const reobserve = packet.controls.find(control => control.purpose === 'reobserve')!;
  adapter.mode = 'none';
  assert.deepEqual(await gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: packet.decisionId,
    requestId: 'human-action-completed', actionRef: reobserve.actionRef,
  }), { kind: 'refresh_required', packet: null });
  const resumed = env.store.tasks.readTaskAggregate('task-1', 'alice');
  assert.equal(resumed.task.state, 'working');
  assert.equal(resumed.task.pendingDecisionId, null);
  assert.equal(resumed.decisions.find(row => row.decisionId === packet.decisionId)?.status,
    'resolved');
  assert.equal(adapter.clicks, 0,
    'reobserving a completed human action never replays a provider mutation');
  assert.equal(resumed.attempts.length, 1);
});

test('an exact terminal FINAL supersedes a human decision without waiting for a client', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'human';
  const packet = (await env.getGateway(adapter).inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
  }))!;
  assert.equal(packet.humanOnly, true);
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'human_input_required');
  env.store.tasks.recordTaskFinal({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    resultId: 'late-human-wait-final', externalTurnId: 'turn-1',
    answerText: 'The provider completed while a human decision was pending', completeTask: true,
  });
  const completed = env.store.tasks.readTaskAggregate('task-1', 'alice');
  assert.equal(completed.task.state, 'completed');
  assert.equal(completed.task.pendingDecisionId, null);
  assert.equal(completed.decisions.find(row => row.decisionId === packet.decisionId)?.status,
    'superseded');
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
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').events
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
  env.store.decisions.resolveDecision({
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
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').decisions[0]?.actionConsumed, false);
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

test('uncertain Pro effect is reobserved and may continue through one fresh current-state action', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'power';
  adapter.throwAfterConsume = true;
  const gateway = env.getGateway(adapter);
  const first = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  const request = {
    taskId: 'task-1', clientId: 'alice', decisionId: first.decisionId,
    requestId: 'first-uncertain-power', actionRef: first.options[0]!.actionRef,
  };
  const failed = await gateway.decideCurrent(request);
  assert.deepEqual(failed, { kind: 'uncertain', reason: 'semantic-decision-effect-unverified' });
  assert.equal(adapter.clicks, 1);
  assert.deepEqual(await gateway.decideCurrent(request), failed,
    'the same uncertain execution attempt is never replayed');

  env.reopen();
  const freshAdapter = new FakeSemanticAdapter(env.store);
  freshAdapter.mode = 'power';
  const fresh = env.getGateway(freshAdapter);
  const current = (await fresh.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(current.reason, 'reasoning-effort-current-state-reobserved');
  assert.equal(current.options.length, 1);
  assert.equal(current.options[0]!.purpose, 'choose_reasoning_effort');
  assert.deepEqual(await fresh.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: current.decisionId,
    requestId: 'fresh-current-power', actionRef: current.options[0]!.actionRef,
  }), { kind: 'performed', effect: 'reasoning_effort_selected' });
  assert.equal(freshAdapter.clicks, 1,
    'a fresh exact observation may perform one new configuration attempt');
});

test('a legacy pending Power packet requires fresh reobservation before another configuration attempt', async t => {
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
  const stored = env.store.tasks.readTaskAggregate('task-1', 'alice').decisions
    .find(row => row.decisionId === original.decisionId)!;
  const prior = JSON.parse(stored.contextJson);
  const legacyId = 'legacy-pending-before-reobserve-contract';
  prior.packet.decisionId = legacyId;
  delete prior.reconcilesUncertainReasoningEffort;
  env.store.decisions.createDecision({
    taskId: 'task-1', clientId: 'alice', decisionId: legacyId,
    audience: 'agent', contextJson: JSON.stringify(prior),
  });
  const pending = gateway.get('task-1', 'alice')!;
  await assert.rejects(gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: legacyId,
    requestId: 'different-power-attempt', actionRef: pending.options[0]!.actionRef,
  }), /current-state reobservation/i);
  assert.equal(adapter.clicks, 1);
  assert.equal(env.store.tasks.getTask('task-1', 'alice').pendingDecisionId, legacyId);

  adapter.throwAfterConsume = false;
  const refreshed = await gateway.refresh({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    decisionId: legacyId, modelChoice: true, requestId: 'read-only-reconcile',
  });
  assert.equal(refreshed?.reason, 'reasoning-effort-current-state-reobserved');
  assert.equal(refreshed?.options[0]?.purpose, 'choose_reasoning_effort');
  assert.deepEqual(await gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: refreshed!.decisionId,
    requestId: 'after-current-reobserve', actionRef: refreshed!.options[0]!.actionRef,
  }), { kind: 'performed', effect: 'reasoning_effort_selected' });
  assert.equal(adapter.clicks, 2);
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
  const after = env.store.tasks.readTaskAggregate('task-1', 'alice');
  assert.equal(after.task.pendingDecisionId, null);
  assert.equal(after.task.state, 'working');
  assert.equal(after.attempts[0]?.state, 'planned');
  assert.equal(adapter.clicks, 0);
  assert.deepEqual(await gateway.refreshCurrent(input),
    { kind: 'refresh_required', packet: null },
    'idempotent replay must not create another model packet when Pro is verified');
  assert.equal(env.store.tasks.readTaskAggregate('task-1', 'alice').decisions.length, 1);
});

test('historically uncertain Pro choice remains observable and exact external selection also reconciles it', async t => {
  const env = fixture(t, { plannedInitial: true, requiredModel: 'Pro' });
  const adapter = new FakeSemanticAdapter(env.store);
  adapter.mode = 'power';
  adapter.throwAfterConsume = true;
  const gateway = env.getGateway(adapter);
  const original = (await gateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  const first = await gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: original.decisionId,
    requestId: 'one-uncertain-power', actionRef: original.options[0]!.actionRef,
  });
  assert.equal(first.kind, 'uncertain');
  assert.equal(adapter.clicks, 1);

  env.reopen();
  const restartedAdapter = new FakeSemanticAdapter(env.store);
  restartedAdapter.mode = 'power';
  const restartedGateway = env.getGateway(restartedAdapter);
  const current = (await restartedGateway.inspect({
    taskId: 'task-1', clientId: 'alice', attemptId: 'initial-1',
    modelChoice: true, modelIntent: 'Pro',
  }))!;
  assert.equal(current.reason, 'reasoning-effort-current-state-reobserved');
  assert.equal(current.options[0]?.purpose, 'choose_reasoning_effort');
  const reobserve = current.controls.find(control => control.purpose === 'reobserve')!;
  const stillCurrent = await restartedGateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: current.decisionId,
    requestId: 'read-only-review-pro', actionRef: reobserve.actionRef,
  });
  assert.equal(stillCurrent.kind, 'refresh_required');
  if (stillCurrent.kind !== 'refresh_required') throw new Error('Expected refreshed model packet');
  assert.equal(stillCurrent.packet?.reason, 'reasoning-effort-current-state-reobserved');
  assert.equal(stillCurrent.packet?.options[0]?.purpose, 'choose_reasoning_effort');
  assert.equal(restartedAdapter.clicks, 0,
    'read-only reobserve never repeats a configuration effect');

  restartedAdapter.mode = 'model-verified';
  const exactProPacket = stillCurrent.packet!;
  const exactProReobserve = exactProPacket.controls.find(control =>
    control.purpose === 'reobserve')!;
  assert.deepEqual(await restartedGateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: exactProPacket.decisionId,
    requestId: 'read-only-now-exact-pro', actionRef: exactProReobserve.actionRef,
  }), { kind: 'refresh_required', packet: null });
  const after = env.store.tasks.readTaskAggregate('task-1', 'alice');
  assert.equal(after.task.pendingDecisionId, null);
  assert.equal(after.task.state, 'working');
  assert.equal(after.attempts[0]?.state, 'planned');
  assert.equal(adapter.clicks, 1);
  assert.equal(restartedAdapter.clicks, 0);
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
  assert.equal(env.store.tasks.getTask('task-1', 'alice').state, 'agent_input_required');
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


test('pending historical v1 Decision cannot execute its old action and refreshes into v2', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const historic = JSON.parse(readFileSync(
    new URL('../fixtures/decision-envelope-v1.json', import.meta.url), 'utf8'));
  historic.context = {
    ...historic.context, projectId: 'project', slotId: 'main',
    slotRevision: 1, taskId: 'task-1', providerConversationId: 'conv-1',
  };
  historic.attemptId = 'initial-1';
  historic.packet = {
    ...historic.packet, taskId: 'task-1',
    decisionId: 'historical-pending-v1', requestedModel: 'Pro',
  };
  const original = JSON.stringify(historic);
  env.store.decisions.createDecision({
    taskId: 'task-1', clientId: 'alice', decisionId: 'historical-pending-v1',
    audience: 'agent', contextJson: original,
  });
  const projected = gateway.get('task-1', 'alice');
  assert.equal(projected?.kind, 'recovery_choice');
  assert.equal(projected?.options.length, 0);
  assert.equal(projected?.reason, 'historical-decision-read-only-refresh-required');
  await assert.rejects(gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: 'historical-pending-v1',
    requestId: 'legacy-replay', actionRef: 'old-action',
  }), /Historical pending action is read-only/);
  assert.equal(adapter.clicks, 0);
  const resumed = await gateway.refreshCurrent({
    taskId: 'task-1', clientId: 'alice',
    decisionId: 'historical-pending-v1', requestId: 'legacy-refresh-1',
  });
  assert.equal(resumed.kind, 'refresh_required');
  const history = env.store.tasks.readTaskAggregate('task-1', 'alice');
  const old = history.decisions.find(row => row.decisionId === 'historical-pending-v1');
  assert.equal(old?.contextJson, original, 'historic JSON is byte-for-byte retained');
  assert.equal(old?.status, 'resolved');
  assert.equal(adapter.clicks, 0);
  const next = history.decisions.find(row => row.status === 'pending');
  assert.ok(next, 'same Task gets one reobserved Decision');
  const newEnvelope = JSON.parse(next.contextJson);
  assert.equal(newEnvelope.schemaVersion, 2);
  assert.equal(Object.hasOwn(newEnvelope, 'actionRef'), false);
  assert.equal(Object.hasOwn(newEnvelope, 'purpose'), false);
  assert.equal(history.decisions.length, 2);
});


test('resolved historical v1 receipt replays exactly without another provider effect', async t => {
  const env = fixture(t);
  const adapter = new FakeSemanticAdapter(env.store);
  const gateway = env.getGateway(adapter);
  const historic = JSON.parse(readFileSync(
    new URL('../fixtures/decision-envelope-v1.json', import.meta.url), 'utf8'));
  historic.context = { ...historic.context, projectId: 'project', slotId: 'main',
    slotRevision: 1, taskId: 'task-1', providerConversationId: 'conv-1' };
  historic.attemptId = 'initial-1';
  historic.packet = { ...historic.packet, taskId: 'task-1',
    decisionId: 'historical-resolved-v1' };
  const original = JSON.stringify(historic);
  env.store.decisions.createDecision({ taskId: 'task-1', clientId: 'alice',
    decisionId: 'historical-resolved-v1', audience: 'agent', contextJson: original });
  env.store.decisions.resolveDecision({ taskId: 'task-1', clientId: 'alice',
    decisionId: 'historical-resolved-v1',
    resolutionJson: JSON.stringify({
      kind: 'semantic_action', requestId: 'historic-request-1',
      actionRef: 'old-action', input: null,
      outcome: { kind: 'performed', effect: 'reasoning_effort_selected' },
    }),
  });
  assert.equal(env.store.decisions.consumeDecisionAction('task-1', 'alice',
    'historical-resolved-v1'), true);
  assert.deepEqual(await gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: 'historical-resolved-v1',
    requestId: 'historic-request-1', actionRef: 'old-action',
  }), { kind: 'performed', effect: 'reasoning_effort_selected' });
  await assert.rejects(gateway.decideCurrent({
    taskId: 'task-1', clientId: 'alice', decisionId: 'historical-resolved-v1',
    requestId: 'new-request', actionRef: 'old-action',
  }), /different request/);
  assert.equal(adapter.clicks, 0, 'replay consumes no new provider execution');
  const actual = env.store.tasks.readTaskAggregate('task-1', 'alice').decisions[0];
  assert.equal(actual?.contextJson, original);
});
