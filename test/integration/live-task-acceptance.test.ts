import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runLiveTaskAcceptance } from '../../scripts/live-task-acceptance.mjs';

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
