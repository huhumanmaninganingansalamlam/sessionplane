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
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';

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
    fake.acknowledgementMode = 'missing';
    await assert.rejects(send(original.sessionId, 'old'), (error: any) => error.data?.errorCode === 'session.submission-unknown');
    const old = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(original.sessionId)!;
    assert.equal(old.submission_state, 'submission_unknown');
    fake.acknowledgementMode = 'success';
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

    // Routing retirement must never turn a collected final into an unresolved observation.
    const completedEvidence = core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(followup.sessionId);
    await rpc('workflow.session_replace', { teamId: team.teamId, roleRef: `${followup.sessionId}:1`, requestId: 'replace-completed' });
    assert.equal(core.teamDirectory.getSession(followup.sessionId).sessionState, 'superseded');
    assert.equal((await decide({ ...input, requestRef: completed.outbox_id, requestId: 'retire-completed' })).structuredContent.errorCode,
      'session.recovery-unavailable');
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(followup.sessionId), completedEvidence);

  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('displaced routing retirement permits explicit disposal but preserves unresolved evidence, drafts and active successor', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-retired-disposal-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
  const fake = new FakeProviderAdapter(); fake.autoFinalText = 'Collected original answer';
  let deletes = 0;
  let unavailable = true;
  t.mock.method(fake, 'openDeletion', async () => {
    if (unavailable) throw new ProviderSubmissionError('provider.unavailable', 'Fixture provider unavailable');
    return { alreadyDeleted: false, deleteOnce: async () => { deletes++; return true; }, close: async () => {} };
  });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = (method: string, params: Record<string, unknown>) => callRpc<any>({ socketPath: config.socketPath,
    method, params: { clientId: 'owner', ...params }, timeoutMs: 10000 });
  const workflow = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: 'sessionplane_' + name,
    arguments: args, socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'owner' });
    core.teamDirectory.createRole({ teamId: team.teamId, roleKey: 'director.main', roleType: 'custom' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'director.main', provider: 'chatgpt' });
    await rpc('session.send', { sessionId: session.sessionId, requestId: 'completed', prompt: 'Original completed request' });
    const first = await rpc('session.wait', { sessionId: session.sessionId, generation: 1, waitMs: 3000 });
    assert.equal(first.answerText, 'Collected original answer');
    fake.autoFinalText = null;
    await rpc('session.send', { sessionId: session.sessionId, requestId: 'unresolved', prompt: 'Original unresolved request' });
    const requests = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation').all(session.sessionId);
    const generations = () => core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(session.sessionId);
    // Earlier continuation history may remain UNKNOWN too; disposal must preserve it.
    core.database.raw.prepare("UPDATE generations SET submission_state='submission_unknown', completed_at=NULL, answer_text=NULL, response_message_id=NULL WHERE session_id=? AND generation=1").run(session.sessionId);
    core.database.raw.prepare("UPDATE outbox SET submission_state='submission_unknown' WHERE session_id=? AND generation=1").run(session.sessionId);
    const preservedRequests = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation').all(session.sessionId);
    const before = generations();
    const historical = (await workflow('team_get', { teamId: team.teamId, requestRef: requests[0]!.outbox_id })).structuredContent;
    assert.equal((historical.request as Record<string, unknown>).conversationId, first.conversationId);
    const input = { teamId: team.teamId, requestRef: requests[1]!.outbox_id, requestId: 'dispose', outputsRetrieved: true,
      discardRetiredObservation: { conversationId: first.conversationId, evidenceRef: 'User explicitly discards obsolete conversation; unresolved original retained' } };
    assert.equal((await workflow('session_delete', input)).structuredContent.errorCode, 'session.cleanup-not-ready');
    assert.equal((await workflow('decide', { teamId: team.teamId, requestRef: requests[1]!.outbox_id,
      requestId: 'hold-obsolete', decision: 'human_review', action: 'pause' })).isError, false);
    assert.equal((await workflow('decide', { teamId: team.teamId, requestRef: requests[1]!.outbox_id,
      requestId: 'retire-still-current', decision: 'retire_observation', discardUnresolved: true,
      evidenceRef: 'Cannot discard current role work' })).structuredContent.errorCode, 'session.recovery-unavailable');
    const replacement = (await workflow('session_replace', { teamId: team.teamId,
      roleRef: `${session.sessionId}:2`, requestId: 'replace-role' })).structuredContent;
    const successor = replacement.replacement;
    assert.ok(successor, JSON.stringify(replacement));
    assert.equal(core.teamDirectory.getSession(session.sessionId).sessionState, 'superseded');
    assert.equal(replacement.replacement.cleanup.errorCode, 'provider.unavailable');
    await rpc('session.send', { sessionId: successor.sessionId, requestId: 'successor-active', prompt: 'Independent new implementation' });
    const successorBefore = core.teamDirectory.getSession(successor.sessionId);
    assert.equal(successorBefore.terminal, false);
    unavailable = false;
    assert.equal((await workflow('session_delete', input)).structuredContent.errorCode, 'session.cleanup-not-ready');
    const disposal = { teamId: team.teamId, requestRef: requests[1]!.outbox_id,
      requestId: 'retire-observation', decision: 'retire_observation', discardUnresolved: true,
      evidenceRef: 'Existing agent-handoff; USER orders old-chat disposal; child commands remain UNKNOWN' };
    const release = core.actorScheduler.actorFor(session.sessionId).retainCollector(String(requests[1]!.outbox_id), false);
    try { assert.equal((await workflow('decide', disposal)).structuredContent.errorCode, 'session.recovery-unavailable'); }
    finally { release(); }
    assert.equal((await workflow('decide', disposal)).isError, false);
    const event = core.database.raw.prepare("SELECT payload_json FROM events WHERE session_id=? AND event_type='generation.observation-retired'").get(session.sessionId)!;
    assert.equal(JSON.parse(String(event.payload_json)).completionSource, 'explicit-observation-disposal');
    assert.equal((await workflow('team_get', { teamId: team.teamId, requestRef: requests[1]!.outbox_id }))
      .structuredContent.request.observationHeld, true);
    const { discardRetiredObservation: _disposal, ...ordinary } = input;
    assert.equal((await workflow('session_delete', ordinary)).structuredContent.errorCode, 'session.cleanup-not-ready');
    assert.equal((await workflow('session_delete', { ...input, requestRef: requests[0]!.outbox_id })).structuredContent.errorCode,
      'session.conversation-mismatch');
    assert.equal((await workflow('session_delete', { ...input, discardRetiredObservation: { ...input.discardRetiredObservation,
      conversationId: 'different-conversation' } })).structuredContent.errorCode, 'session.cleanup-not-ready');
    const { page } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea>Human draft</textarea>' }));
    await page.goto('https://chatgpt.com/c/' + first.conversationId);
    assert.equal((await workflow('session_delete', input)).structuredContent.errorCode, 'session.cleanup-not-ready');
    assert.equal(await page.locator('textarea').inputValue(), 'Human draft');
    await page.setContent('<button data-testid="stop-button">Stop</button>');
    assert.equal((await workflow('session_delete', input)).structuredContent.errorCode, 'session.cleanup-not-ready');
    assert.equal(deletes, 0);
    await page.setContent('<main>Obsolete conversation, idle</main>');
    const deleted = (await workflow('session_delete', input)).structuredContent;
    assert.equal(deleted.deleted, true, JSON.stringify(deleted));
    assert.deepEqual(deleted.pageCleanup, { closedPages: 1, pageErrors: [] });
    assert.equal(page.isClosed(), true);
    assert.deepEqual(generations(), before);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation').all(session.sessionId), preservedRequests);
    assert.deepEqual((await workflow('session_delete', input)).structuredContent, deleted);
    assert.equal(deletes, 1);
    assert.deepEqual(core.teamDirectory.getSession(successor.sessionId), successorBefore);
    assert.equal(fake.submitCount, 3);
    assert.equal(fake.stopCount, 0);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
