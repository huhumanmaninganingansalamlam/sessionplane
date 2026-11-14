import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveLiveTaskAcceptanceTiming, runLiveTaskAcceptance } from '../../scripts/live-task-acceptance.mjs';

const clientId = 'sessionplane-l3-test-owner';
const projectKey = 'sessionplane-l3-test-project';
const compatible = async () => ({ outcome: {
  candidateMatchesLiveCore: true, blockers: [],
} });
const incompatible = async () => ({ outcome: {
  candidateMatchesLiveCore: false,
  blockers: ['installed_core_schema_differs_from_candidate'],
} });

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sp-l3-acceptance-fixture-'));
  const records = new Map<string, {
    id: string; revision: number; token: string; finished: boolean; index: number;
  }>();
  const calls: Array<{ method: string; params: any }> = [];
  let count = 0;
  const identity = '00000000-0000-4000-8000-000000000101';
  const conversationId = 'canonical-l3-fixture-conversation';

  const call = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === 'project.open') {
      return { projectId: identity, provider: 'chatgpt',
        modelIntent: 'Pro', mainConversationSlotId: 'main', conversationRevision: 1 };
    }
    if (method === 'task.start') {
      const earlier = records.get(params.requestId);
      if (earlier) return {
        taskId: earlier.id, projectId: identity,
        conversationRevision: earlier.revision,
      };
      count++;
      const token = /SP_L3_[a-f0-9]+_TURN_\d+/.exec(params.prompt)?.[0]!;
      assert.ok(token);
      const row = {
        id: '00000000-0000-4000-8000-' + String(count + 200).padStart(12, '0'),
        revision: params.expectedConversationRevision + 1,
        token, finished: false, index: count,
      };
      records.set(params.requestId, row);
      return { taskId: row.id, projectId: identity,
        conversationRevision: row.revision };
    }
    const current = [...records.values()].find(item => item.id === params.taskId);
    assert.ok(current, 'Task must be created through original task.start');
    if (method === 'task.wait') current.finished = true;
    if (method === 'task.get') {
      if (params.view === 'result') {
        assert.equal(current.finished, true);
        return { result: {
          answerText: current.token, answerBytes: Buffer.byteLength(current.token),
          answerSha256: createHash('sha256').update(current.token).digest('hex'),
          completesTask: true,
        } };
      }
      if (params.view === 'evidence') {
        assert.equal(current.finished, true);
        return {
          submission: { attempted: true, acknowledged: true },
          evidence: {
            attempts: [{ kind: 'initial', state: 'acknowledged' }],
            conversation: { providerConversationId: conversationId },
            rootPost: current.index === 1
              ? { ambiguous: false, observationCount: 1,
                  canonicalConversationId: conversationId } : null,
          },
        };
      }
      return {
        taskId: current.id, projectId: identity, conversationRevision: current.revision,
        revision: current.finished ? 4 : 1,
        state: current.finished ? 'completed' : 'working',
        decision: null,
      };
    }
    if (method === 'task.wait') {
      return {
        taskId: current.id, projectId: identity,
        conversationRevision: current.revision, revision: 4,
        state: 'completed', decision: null,
      };
    }
    throw new Error('Unexpected external RPC: ' + method);
  };
  return { dir, calls, records, call };
}
function options(dir: string, call: (method: string, params: any) => Promise<any>,
  phase: 'start' | 'resume', preflight = compatible) {
  return {
    authorized: true, clientId, projectKey,
    receiptDir: join(dir, 'receipt'), socketPath: '/not-a-live-core',
    phase, call, preflight, maxWaitMs: 1_000, waitMs: 0,
  };
}

test('CLI defaults resolve to a finite RPC timeout before the first live mutation', () => {
  assert.deepEqual(resolveLiveTaskAcceptanceTiming({}), {
    maxWaitMs: 120_000, waitMs: 15_000, rpcTimeoutMs: 20_000,
  });
  assert.deepEqual(resolveLiveTaskAcceptanceTiming({ waitMs: 0, maxWaitMs: 900_000 }), {
    maxWaitMs: 900_000, waitMs: 0, rpcTimeoutMs: 10_000,
  });
  assert.throws(() => resolveLiveTaskAcceptanceTiming({ waitMs: Number.NaN }),
    /Invalid bounded wait interval/);
});

test('incompatible installed Core prevents even project.open, not just provider submission', async () => {
  const f = makeFixture();
  try {
    const result = await runLiveTaskAcceptance(options(f.dir, f.call, 'start', incompatible));
    assert.equal(result.status, 'blocked_before_mutation');
    assert.equal(result.mutationPerformed, false);
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(join(f.dir, 'receipt')), false,
      'No acceptance identity should be created under an incompatible installed Core');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('an explicitly authorized acceptance identity is mandatory before any mutation', async () => {
  const f = makeFixture();
  try {
    await assert.rejects(runLiveTaskAcceptance({
      ...options(f.dir, f.call, 'start'), authorized: false,
    }), /require --allow-live-send/);
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(join(f.dir, 'receipt')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('uncertain ACK is awaited read-only until recovery instead of stopping the live run', async () => {
  const f = makeFixture();
  let uncertainWaits = 0;
  const call = async (method: string, params: any) => {
    const result = await f.call(method, params);
    if (method === 'task.get' && !params.view &&
        f.records.size === 1 && uncertainWaits < 3) {
      return { ...result, state: 'uncertain', revision: 2 + uncertainWaits,
        submission: { attempted: true, acknowledged: false },
        cancelRequested: false, decision: null };
    }
    if (method === 'task.wait' && f.records.size === 1) {
      uncertainWaits++;
      if (uncertainWaits < 3) {
        return { ...result, state: 'uncertain', revision: 2 + uncertainWaits,
          submission: { attempted: true, acknowledged: false },
          cancelRequested: false, decision: null };
      }
    }
    return result;
  };
  try {
    const first = await runLiveTaskAcceptance(options(f.dir, call, 'start'));
    assert.equal(first.status, 'owner_client_exited_after_initial');
    assert.equal(f.records.size, 1);
    const result = await runLiveTaskAcceptance(options(f.dir, call, 'resume'));
    assert.equal(result.status, 'three_turns_canonical_final_verified');
    assert.equal(uncertainWaits, 3,
      'three paced/uncertain ACK observations must attach revision waits without resend');
    assert.equal(f.calls.filter(row => row.method === 'task.start').length, 3,
      'a recovered uncertain Task cannot re-send the original');
    assert.equal(f.calls.filter(row => row.method === 'task.decide').length, 0,
      'read-only ACK waiting can never invent a model or permission action');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('start exits after one Task, resume verifies exact root ACK and three Main answers without resending', async () => {
  const f = makeFixture();
  try {
    const initial = await runLiveTaskAcceptance(options(f.dir, f.call, 'start'));
    assert.equal(initial.status, 'owner_client_exited_after_initial');
    assert.equal(f.records.size, 1);
    assert.deepEqual(f.calls.filter(item => item.method === 'task.start').length, 1);
    const plan = JSON.parse(readFileSync(join(f.dir, 'receipt', 'plan.json'), 'utf8'));
    assert.equal(plan.tasks.length, 3);
    assert.notEqual(plan.tasks[0].requestId, plan.tasks[1].requestId);
    assert.equal(f.calls.filter(item => item.method === 'task.wait').length, 0,
      'The initial MCP/CLI client must exit without retaining a collector');

    const resumed = await runLiveTaskAcceptance(options(f.dir, f.call, 'resume'));
    assert.equal(resumed.status, 'three_turns_canonical_final_verified');
    assert.equal(resumed.sameMainConversation, true);
    assert.equal(resumed.exactAnswerHashes.length, 3);
    assert.equal(f.records.size, 3);
    assert.equal(f.calls.filter(item => item.method === 'task.start').length, 3,
      'Three substantive questions own three distinct idempotency keys');
    const revisions = f.calls.filter(item => item.method === 'task.start')
      .map(item => item.params.expectedConversationRevision);
    assert.deepEqual(revisions, [1, 2, 3]);
    const after = await runLiveTaskAcceptance(options(f.dir, f.call, 'resume'));
    assert.equal(after.status, 'three_turns_canonical_final_verified');
    assert.equal(f.records.size, 3);
    assert.equal(f.calls.filter(item => item.method === 'task.start').length, 3,
      'Resume must never create a fourth Task');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('lost start response retries only its original requestId, not a new POST', async () => {
  const f = makeFixture();
  try {
    let lose = true;
    const sometimesLost = async (method: string, params: any) => {
      const result = await f.call(method, params);
      if (method === 'task.start' && lose) {
        lose = false;
        throw new Error('Transport returned no task.start receipt after dispatch');
      }
      return result;
    };
    await assert.rejects(runLiveTaskAcceptance(options(f.dir, sometimesLost, 'start')),
      /Transport returned no task.start receipt/);
    assert.equal(f.records.size, 1);
    const firstId = f.calls.find(item => item.method === 'task.start')!.params.requestId;
    const repeated = await runLiveTaskAcceptance(options(f.dir, sometimesLost, 'start'));
    assert.equal(repeated.status, 'owner_client_exited_after_initial');
    assert.equal(f.records.size, 1);
    const ids = f.calls.filter(item => item.method === 'task.start')
      .map(item => item.params.requestId);
    assert.deepEqual(ids, [firstId, firstId],
      'A lost response may replay only the exact durable idempotency key');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a mismatching exact FINAL is never accepted after reconnect or followed by another send', async () => {
  const f = makeFixture();
  try {
    const wrongAnswer = async (method: string, params: any) => {
      const response = await f.call(method, params);
      if (method === 'task.get' && params.view === 'result') {
        const answerText = 'WRONG_CONTROLLED_RESULT';
        return { result: {
          ...response.result, answerText,
          answerBytes: Buffer.byteLength(answerText, 'utf8'),
          answerSha256: createHash('sha256').update(answerText).digest('hex'),
        } };
      }
      return response;
    };
    await runLiveTaskAcceptance(options(f.dir, wrongAnswer, 'start'));
    await assert.rejects(
      runLiveTaskAcceptance(options(f.dir, wrongAnswer, 'resume')),
      /does not match the controlled test token/,
    );
    const after = JSON.parse(readFileSync(join(f.dir, 'receipt', 'state.json'), 'utf8'));
    assert.equal(after.tasks[0].exactAnswerMatched, false);
    await assert.rejects(
      runLiveTaskAcceptance(options(f.dir, wrongAnswer, 'resume')),
      /previous exact result failed acceptance/,
    );
    assert.equal(f.calls.filter(item => item.method === 'task.start').length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('resume without a saved plan refuses to invent a first live prompt', async () => {
  const f = makeFixture();
  try {
    await assert.rejects(runLiveTaskAcceptance(options(f.dir, f.call, 'resume')),
      /Resume requires the previously persisted acceptance plan/);
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(join(f.dir, 'receipt')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('resumed L3 runner opens a safe chooser before Core-verified Pro and three-Turn FINAL', async () => {
  const f = makeFixture();
  const decisions: any[] = [];
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  let stage = 0;
  const call = async (method: string, params: any) => {
    if (method === 'task.decide') {
      decisions.push(params);
      assert.equal(params.clientId, clientId);
      if (stage === 0) {
        assert.equal(params.actionRef, 'open-pro-model-menu');
        assert.equal(params.input, undefined);
      } else {
        throw new Error('Unexpected extra model decision');
      }
      stage++;
      return { kind: 'performed', effect: 'model_menu_opened' };
    }
    const result = await f.call(method, params);
    if (method === 'task.get' && !params.view &&
        f.records.size === 1 && stage < 1) {
      const open = stage === 0;
      return {
        ...result, state: 'agent_input_required', revision: 10 + stage,
        decision: {
          decisionId: '00000000-0000-4000-8000-0000000000' + (open ? '91' : '92'),
          kind: 'model_choice', humanOnly: false,
          requestedModel: 'Pro', options: [{
            actionRef: 'open-pro-model-menu',
            purpose: 'open_model_chooser',
            risk: 'configuration_only',
            expiresAt,
            inputSchema: { kind: 'none' },
          }],
        },
      };
    }
    return result;
  };
  try {
    const initial = await runLiveTaskAcceptance(options(f.dir, call, 'start'));
    assert.equal(initial.status, 'owner_client_exited_after_initial');
    assert.equal(stage, 0, 'The first client must exit before acting on model decisions');
    const completed = await runLiveTaskAcceptance({
      ...options(f.dir, call, 'resume'), maxWaitMs: 5000,
    });
    assert.equal(completed.status, 'three_turns_canonical_final_verified');
    assert.equal(decisions.length, 1);
    assert.equal(stage, 1);
    assert.deepEqual(decisions.map(({ requestId }) => requestId), [
      'l3-pro-00000000-0000-4000-8000-000000000091',
    ]);
    assert.equal(f.records.size, 3);
    assert.deepEqual(f.calls.filter(x => x.method === 'task.start')
      .map(x => x.params.expectedConversationRevision), [1, 2, 3]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('L3 runner consumes exact model-view close, reopen, one Pro effort selection and final close before any new Task', async () => {
  const f = makeFixture();
  const sequence = [
    { purpose: 'close_model_chooser', effect: 'model_menu_closed' },
    { purpose: 'open_model_chooser', effect: 'model_menu_opened' },
    { purpose: 'choose_reasoning_effort', effect: 'reasoning_effort_selected' },
    { purpose: 'close_model_chooser', effect: 'model_menu_closed' },
  ];
  const decisions: any[] = [];
  let stage = 0;
  const call = async (method: string, params: any) => {
    if (method === 'task.decide') {
      assert.equal(params.refresh, undefined);
      assert.equal(params.clientId, clientId);
      assert.equal(params.input, undefined, 'the pointer choice uses no guessed numeric input');
      assert.equal(params.actionRef, 'exact-power-stage-' + stage);
      decisions.push(params);
      const current = sequence[stage]!;
      stage++;
      return { kind: 'performed', effect: current.effect };
    }
    const base = await f.call(method, params);
    if (method === 'task.get' && !params.view &&
        f.records.size === 1 && stage < sequence.length) {
      return {
        ...base, state: 'agent_input_required', revision: 10 + stage,
        submission: { attempted: false, acknowledged: false },
        decision: {
          decisionId: '00000000-0000-4000-8000-0000000000' + (91 + stage),
          kind: 'model_choice', humanOnly: false,
          requestedModel: 'Pro', options: [{
            actionRef: 'exact-power-stage-' + stage,
            purpose: sequence[stage]!.purpose, risk: 'configuration_only',
            expiresAt: new Date(Date.now() + 120_000).toISOString(),
            inputSchema: { kind: 'none' },
          }],
        },
      };
    }
    if (method === 'task.start' && f.records.size > 1) {
      assert.equal(stage, sequence.length,
        'no follow-up Task before the four exact configuration actions');
    }
    return base;
  };
  try {
    const started = await runLiveTaskAcceptance(options(f.dir, call, 'start'));
    assert.equal(started.status, 'owner_client_exited_after_initial');
    assert.equal(stage, 0);
    const result = await runLiveTaskAcceptance({
      ...options(f.dir, call, 'resume'), maxWaitMs: 5000,
    });
    assert.equal(result.status, 'three_turns_canonical_final_verified');
    assert.equal(stage, sequence.length);
    assert.equal(decisions.length, sequence.length);
    assert.deepEqual(decisions.map(d => d.requestId), [
      'l3-pro-00000000-0000-4000-8000-000000000091',
      'l3-pro-00000000-0000-4000-8000-000000000092',
      'l3-pro-00000000-0000-4000-8000-000000000093',
      'l3-pro-00000000-0000-4000-8000-000000000094',
    ]);
    assert.equal(f.records.size, 3);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('an uncertain or lost Pro configuration result never causes a second action after runner reconnect', async () => {
  for (const variant of ['uncertain', 'lost', 'lost-after-success'] as const) {
    const f = makeFixture();
    let decisions = 0;
    const call = async (method: string, params: any) => {
      if (method === 'task.decide') {
        decisions++;
        if (decisions > (variant === 'lost-after-success' ? 2 : 1)) {
          throw new Error('Unsafe configuration retry after an ambiguous external effect');
        }
        const savedBefore = JSON.parse(
          readFileSync(join(f.dir, 'receipt', 'state.json'), 'utf8'));
        assert.equal(savedBefore.tasks[0].modelDecisionResult, 'pending',
          'the next decision must clear the prior success before any RPC');
        if (variant === 'lost-after-success' && decisions === 1) {
          return { kind: 'performed', effect: 'model_menu_closed' };
        }
        if (variant !== 'uncertain') throw new Error('Lost configuration RPC reply');
        return { kind: 'uncertain', reason: 'pro-effort-click-outcome-unverified' };
      }
      const base = await f.call(method, params);
      if (method === 'task.get' && !params.view && f.records.size === 1) {
        const suffix = decisions === 0 ? '91' : decisions === 1 ? '92' : '93';
        return {
          ...base, state: 'agent_input_required', revision: 30 + decisions,
          submission: { attempted: false, acknowledged: false },
          decision: {
            decisionId: '00000000-0000-4000-8000-0000000000' + suffix,
            kind: 'model_choice', humanOnly: false, requestedModel: 'Pro',
            options: [{
              actionRef: 'pro-pointer-' + suffix,
              purpose: 'choose_reasoning_effort', risk: 'configuration_only',
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
              inputSchema: { kind: 'none' },
            }],
          },
        };
      }
      return base;
    };
    try {
      await runLiveTaskAcceptance(options(f.dir, call, 'start'));
      const resume = { ...options(f.dir, call, 'resume'), maxWaitMs: 200 };
      if (variant === 'uncertain') {
        const first = await runLiveTaskAcceptance(resume);
        assert.equal(first.status, 'read_only_reconnect_pending');
      } else {
        await assert.rejects(runLiveTaskAcceptance(resume), /Lost configuration RPC reply/);
      }
      const saved = JSON.parse(readFileSync(join(f.dir, 'receipt', 'state.json'), 'utf8'));
      assert.equal(saved.tasks[0].modelDecision.actionRef,
        variant === 'lost-after-success' ? 'pro-pointer-92' : 'pro-pointer-91');
      assert.equal(saved.tasks[0].modelDecisionResult,
        variant === 'uncertain' ? 'uncertain' : 'pending');
      const after = await runLiveTaskAcceptance(resume);
      assert.equal(after.status, 'read_only_reconnect_pending');
      assert.equal(after.taskState, 'agent_input_required');
      assert.equal(decisions, variant === 'lost-after-success' ? 2 : 1,
        'a new decision identity is never a replay authorization');
      assert.equal(f.calls.filter(x => x.method === 'task.start').length, 1);
      assert.equal(saved.conversationId, null);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('cold root chooser hydrates after one read-only refresh; Core independently verifies Pro', async () => {
  const f = makeFixture();
  const decisions: any[] = [];
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  let stage = 0;
  const call = async (method: string, params: any) => {
    if (method === 'task.decide') {
      decisions.push(params);
      if (stage === 0) {
        assert.deepEqual({ refresh: params.refresh, actionRef: params.actionRef },
          { refresh: true, actionRef: undefined });
        stage++;
        return { kind: 'refresh_required', packet: null };
      }
      assert.equal(params.refresh, undefined);
      if (stage === 1) {
        assert.equal(params.actionRef, 'live-hydrated-opener');
        assert.equal(params.input, undefined);
      } else {
        throw new Error('Unbounded model action attempted');
      }
      stage++;
      return { kind: 'performed', effect: 'model_selected' };
    }
    const base = await f.call(method, params);
    if (method === 'task.get' && !params.view &&
        f.records.size === 1 && stage < 2) {
      return {
        ...base, state: 'agent_input_required', revision: 10 + stage,
        decision: {
          decisionId: '00000000-0000-4000-8000-0000000000' + (91 + stage),
          kind: 'model_choice', humanOnly: false, requestedModel: 'Pro',
          options: stage === 0 ? [] : [{
            actionRef: 'live-hydrated-opener',
            purpose: 'open_model_chooser',
            risk: 'configuration_only', expiresAt,
            inputSchema: { kind: 'none' },
          }],
        },
      };
    }
    return base;
  };
  try {
    await runLiveTaskAcceptance(options(f.dir, call, 'start'));
    const completed = await runLiveTaskAcceptance({
      ...options(f.dir, call, 'resume'), maxWaitMs: 5000,
    });
    assert.equal(completed.status, 'three_turns_canonical_final_verified');
    assert.equal(stage, 2);
    assert.equal(decisions.length, 2);
    assert.deepEqual(decisions.map(d => d.requestId), [
      'l3-refresh-00000000-0000-4000-8000-000000000091',
      'l3-pro-00000000-0000-4000-8000-000000000092',
    ]);
    assert.equal(f.calls.filter(c => c.method === 'task.start').length, 3);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('disabled or unverified Pro effort stops L3 without radio selection, refresh churn or POST', async () => {
  for (const reason of ['reasoning-effort-control-disabled',
    'reasoning-effort-pro-target-unverified',
    'reasoning-effort-previous-action-uncertain']) {
    const f = makeFixture();
    try {
      await runLiveTaskAcceptance(options(f.dir, f.call, 'start'));
      const call = async (method: string, params: any) => {
        if (method === 'task.decide') {
          throw new Error('Pro effort must not select a model radio or refresh a stable barrier');
        }
        const base = await f.call(method, params);
        if (method === 'task.get' && !params.view) {
          return { ...base, state: 'agent_input_required', revision: 7,
            submission: { attempted: false, acknowledged: false },
            decision: {
              decisionId: '00000000-0000-4000-8000-0000000000ab',
              kind: 'model_choice', humanOnly: false, requestedModel: 'Pro',
              reason, options: [{
                actionRef: 'bad-pro-model-radio', purpose: 'choose_model',
                risk: 'configuration_only',
                expiresAt: new Date(Date.now() + 120_000).toISOString(),
                inputSchema: { kind: 'option', options: [
                  { value: 'GPT-6', enabled: true }, { value: 'Pro', enabled: true },
                ] },
              }],
            },
          };
        }
        return base;
      };
      const result = await runLiveTaskAcceptance({
        ...options(f.dir, call, 'resume'), maxWaitMs: 200,
      });
      assert.equal(result.status, 'read_only_reconnect_pending');
      assert.equal(result.taskState, 'agent_input_required');
      assert.equal(f.calls.filter(x => x.method === 'task.start').length, 1);
      assert.equal(f.calls.filter(x => x.method === 'task.wait').length, 0);
      const receipt = JSON.parse(readFileSync(join(f.dir, 'receipt', 'state.json'), 'utf8'));
      assert.equal(receipt.conversationId, null);
      assert.equal(receipt.tasks[0].modelDecision, undefined,
        'no guess-based radio mutation is journaled');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('L3 read-only refresh of a superseded root observation never repeats Task or POST', async () => {
  const f = makeFixture();
  const refreshes: any[] = [];
  const call = async (method: string, params: any) => {
    if (method === 'task.decide') {
      assert.equal(params.refresh, true);
      assert.equal(params.actionRef, undefined);
      refreshes.push(params);
      return { kind: 'refresh_required', packet: null };
    }
    const baseline = await f.call(method, params);
    if (method === 'task.get' && !params.view &&
        f.records.size === 1 && refreshes.length === 0) {
      return {
        ...baseline, state: 'agent_input_required',
        revision: 4, submission: { attempted: false, acknowledged: false },
        decision: {
          decisionId: '00000000-0000-4000-8000-000000000131',
          kind: 'adapter_unsupported',
          reason: 'semantic-observation-superseded-by-page-operation',
          humanOnly: false, requestedModel: null, options: [],
        },
      };
    }
    return baseline;
  };
  try {
    await runLiveTaskAcceptance(options(f.dir, call, 'start'));
    const completed = await runLiveTaskAcceptance({
      ...options(f.dir, call, 'resume'), maxWaitMs: 1500,
    });
    assert.equal(completed.status, 'three_turns_canonical_final_verified');
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].requestId,
      'l3-refresh-00000000-0000-4000-8000-000000000131');
    assert.equal(f.calls.filter(x => x.method === 'task.start').length, 3);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a human-only permission or unrelated decision is never auto-executed by the L3 runner', async () => {
  const f = makeFixture();
  let attempted = 0;
  const call = async (method: string, params: any) => {
    if (method === 'task.decide') {
      attempted++;
      throw new Error('Human-only approval must never be sent');
    }
    const result = await f.call(method, params);
    if (method === 'task.get' && !params.view) return {
      ...result,
      state: 'agent_input_required',
      decision: {
        decisionId: '00000000-0000-4000-8000-000000000099',
        kind: 'tool_permission', humanOnly: true, requestedModel: null,
        options: [{ actionRef: 'never-auto-grant', purpose: 'grant_permission',
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          inputSchema: { kind: 'none' },
        }],
      },
    };
    return result;
  };
  try {
    await runLiveTaskAcceptance(options(f.dir, call, 'start'));
    const pending = await runLiveTaskAcceptance({
      ...options(f.dir, call, 'resume'), maxWaitMs: 2000,
    });
    assert.equal(pending.status, 'read_only_reconnect_pending');
    assert.equal(pending.taskState, 'agent_input_required');
    assert.equal(attempted, 0);
    assert.equal(f.records.size, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a paced/429 provider wait retains one initial attempt without any client resend', async () => {
  const f = makeFixture();
  let waits = 0;
  const paced = async (method: string, params: any) => {
    if (method === 'task.get' && params.view === undefined) {
      const base = await f.call(method, params);
      return { ...base, revision: 7, state: 'working',
        submission: { attempted: true, acknowledged: false },
        lastExactProgressAt: null,
        nextAutomaticActionAt: new Date(Date.now() + 60000).toISOString(),
        decision: null };
    }
    if (method === 'task.wait') {
      waits++;
      await new Promise(resolve => setTimeout(resolve, 6));
      return { taskId: params.taskId, state: 'working', revision: 7,
        submission: { attempted: true, acknowledged: false }, decision: null };
    }
    return await f.call(method, params);
  };
  try {
    await runLiveTaskAcceptance(options(f.dir, paced, 'start'));
    const once = await runLiveTaskAcceptance({
      ...options(f.dir, paced, 'resume'), maxWaitMs: 28, waitMs: 8,
    });
    assert.equal(once.status, 'read_only_reconnect_pending');
    assert.equal(once.taskState, 'working');
    const twice = await runLiveTaskAcceptance({
      ...options(f.dir, paced, 'resume'), maxWaitMs: 28, waitMs: 8,
    });
    assert.equal(twice.status, 'read_only_reconnect_pending');
    assert.equal(f.records.size, 1);
    assert.equal(f.calls.filter(item => item.method === 'task.start').length, 1);
    assert.ok(waits > 1, 'The client is allowed bounded read-only waits');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('expired model actions are refreshed read-only, never clicked with a stale actionRef', async () => {
  const f = makeFixture();
  const refreshes: any[] = [];
  let acted = 0;
  const call = async (method: string, params: any) => {
    if (method === 'task.decide') {
      if (params.refresh === true) {
        refreshes.push(params);
        return { kind: 'refresh_required', packet: null };
      }
      acted++;
      throw new Error('Expired model action must never be executed');
    }
    const base = await f.call(method, params);
    if (method === 'task.get' && !params.view) return {
      ...base, state: 'agent_input_required', revision: 4,
      decision: {
        decisionId: '00000000-0000-4000-8000-000000000123',
        kind: 'model_choice', humanOnly: false, requestedModel: 'Pro',
        options: [{
          actionRef: 'expired-model-popup', purpose: 'open_model_chooser',
          expiresAt: '2020-01-01T00:00:00.000Z',
          inputSchema: { kind: 'none' },
        }],
      },
    };
    return base;
  };
  try {
    await runLiveTaskAcceptance(options(f.dir, call, 'start'));
    const result = await runLiveTaskAcceptance({
      ...options(f.dir, call, 'resume'), maxWaitMs: 200,
    });
    assert.equal(result.status, 'read_only_reconnect_pending');
    assert.equal(result.taskState, 'agent_input_required');
    assert.equal(acted, 0);
    assert.equal(refreshes.length, 1, 'Only one bounded read-only refresh is issued');
    assert.equal(refreshes[0].actionRef, undefined);
    assert.equal(refreshes[0].requestId,
      'l3-refresh-00000000-0000-4000-8000-000000000123');
    assert.equal(f.records.size, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
