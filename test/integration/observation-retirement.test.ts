import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { callRpc } from '../../src/cli/client.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('explicit obsolete observation retirement preserves submissions, rejects active/foreign evidence and survives restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-retire-observation-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationQuietWindowMs: 10 });
  const fake = new FakeProviderAdapter();
  const start = () => startCore({ config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let core = await start();
  const rpc = (method: string, params: Record<string, unknown>) => callRpc<any>({ socketPath: config.socketPath, method, params });
  const decide = (args: Record<string, unknown>) => invokeMcpTool({ name: 'sessionplane_decide', arguments: args,
    socketPath: config.socketPath, timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes });
  const send = async (sessionId: string, requestId: string) => {
    await rpc('session.send', { clientId: 'owner', requestId, sessionId, prompt: 'Fixture question' });
    return core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation DESC LIMIT 1').get(sessionId)!;
  };
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'owner' });
    const original = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const old = await send(original.sessionId, 'old');
    const input = { teamId: team.teamId, requestRef: old.outbox_id, requestId: 'retire-old',
      decision: 'retire_observation', workComplete: true, evidenceRef: 'Archived task; explicit user completion' };
    assert.equal((await decide(input)).structuredContent.errorCode, 'session.recovery-unavailable');
    const successor = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const next = await send(successor.sessionId, 'current');
    const before = core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(original.sessionId);
    const result = await decide(input);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.disposition, 'observation-retired');
    assert.equal(result.structuredContent.providerMutation, false);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(original.sessionId), before);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(old.outbox_id), old);
    assert.equal(core.teamDirectory.getSession(successor.sessionId).terminal, false);
    assert.deepEqual((await decide(input)).structuredContent, result.structuredContent);

    // A current-role old request needs a later completed same-team review, not any response.
    core.teamDirectory.createRole({ teamId: team.teamId, roleKey: 'expert.followup', roleType: 'expert' });
    const followup = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'expert.followup', provider: 'chatgpt' });
    fake.autoFinalText = 'Independent follow-up verdict';
    const completed = await send(followup.sessionId, 'followup');
    await rpc('session.wait', { clientId: 'owner', sessionId: followup.sessionId, generation: 1, waitMs: 2000 });
    assert.equal(core.teamDirectory.getSession(followup.sessionId).sessionState, 'complete');
    const second = { ...input, requestRef: next.outbox_id, requestId: 'retire-current-after-followup', successorRequestRef: completed.outbox_id };
    const foreign = core.teamDirectory.createTeam({ clientId: 'owner' });
    const foreignSession = core.teamDirectory.createSession({ teamId: foreign.teamId, roleKey: 'main', provider: 'chatgpt' });
    const foreignRequest = await send(foreignSession.sessionId, 'foreign');
    assert.equal((await decide({ ...second, successorRequestRef: foreignRequest.outbox_id })).isError, true);
    const originalEvidence = core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(successor.sessionId);
    assert.equal((await decide(second)).isError, false);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(successor.sessionId), originalEvidence);
    assert.equal(fake.stopCount, 0);
    const submits = fake.submitCount;
    await core.close(); core = await start();
    assert.equal(core.teamDirectory.getSession(original.sessionId).sessionState, 'cancelled');
    assert.equal(core.teamDirectory.getSession(successor.sessionId).sessionState, 'cancelled');
    assert.equal(fake.submitCount, submits);
    assert.equal(fake.stopCount, 0);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(old.outbox_id), old);
    // Retiring observation is not permission to reuse an unresolved generation.
    fake.autoFinalText = null;
    await assert.rejects(send(successor.sessionId, 'later-current-generation'), /already has active generation/);
    assert.equal(fake.submitCount, submits);
    assert.equal((await decide(second)).structuredContent.disposition, 'observation-retired');

  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
