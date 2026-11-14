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
import { SessionRepository } from '../../src/storage/session-repository.ts';
import { runCli } from '../../src/cli/main.ts';
import { Readable, Writable } from 'node:stream';

test('explicit displaced prepared disposal preserves draft records and UNKNOWN history, closes only its owned page and keeps successor collector', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-prepared-disposal-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
  const fake = new FakeProviderAdapter(); fake.autoFinalText = 'Prior fixture answer';
  let deletes = 0, unavailable = true;
  t.mock.method(fake, 'openDeletion', async () => {
    if (unavailable) throw new ProviderSubmissionError('provider.unavailable', 'Fixture verification paced',
      { details: { stage: 'conversation-verification', httpStatus: 429, retryAfterMs: 37000 } });
    return { alreadyDeleted: false, deleteOnce: async () => { deletes++; return true; }, close: async () => {} };
  });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = (method: string, params: object) => callRpc<any>({ socketPath: config.socketPath,
    method, params: { clientId: 'owner', ...params }, timeoutMs: 10000 });
  const workflow = (name: string, args: object) => invokeMcpTool({ name: 'sessionplane_' + name,
    arguments: args, socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
  let releaseSuccessor: (() => void) | undefined;
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'owner' });
    const old = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await rpc('session.send', { sessionId: old.sessionId, requestId: 'original', prompt: 'Prior fixture work' });
    const completed = await rpc('session.wait', { sessionId: old.sessionId, generation: 1, waitMs: 3000 });
    assert.equal(completed.terminal, true);
    fake.prepareError = new ProviderSubmissionError('provider.preparation-required', 'Fixture requires explicit preparation');
    await assert.rejects(rpc('session.send', { sessionId: old.sessionId, requestId: 'prepared', prompt: 'Preserved obsolete draft' }),
      (error: any) => error.data?.errorCode === 'provider.preparation-required');
    const request = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? AND generation=2').get(old.sessionId)!;
    const identity = { teamId: team.teamId, requestRef: request.outbox_id };
    const retire = { ...identity, requestId: 'same-prepared-disposal', decision: 'retire_observation',
      discardUnresolved: true, evidenceRef: 'Existing agent-handoff; USER authorizes obsolete draft disposal; UNKNOWN retained' };
    assert.equal((await workflow('decide', retire)).structuredContent.errorCode, 'session.recovery-unavailable', 'Current role remains protected');
    const successor = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    fake.prepareError = null; fake.autoFinalText = null;
    await rpc('session.send', { sessionId: successor.sessionId, requestId: 'successor', prompt: 'Active successor work' });
    const successorBefore = core.teamDirectory.getSession(successor.sessionId);
    releaseSuccessor = core.actorScheduler.actorFor(successor.sessionId).retainCollector('successor-result-owner', true);
    assert.equal((await workflow('decide', retire)).structuredContent.errorCode, 'session.recovery-unavailable', 'Unheld obsolete preparation remains protected');
    assert.equal((await workflow('decide', { ...identity, requestId: 'hold-prepared', decision: 'human_review', action: 'pause' })).isError, false);
    const sessions = new SessionRepository(core.database.raw);
    assert.equal(sessions.retireObservation(old.sessionId, 2, new Date().toISOString()), false, 'Default submitted-only storage path stays guarded');
    const foreign = core.teamDirectory.createTeam({ clientId: 'foreign' });
    assert.equal((await workflow('decide', { ...retire, teamId: foreign.teamId })).isError, true);
    const release = core.actorScheduler.actorFor(old.sessionId).retainCollector(String(request.outbox_id), false);
    try { assert.equal((await workflow('decide', retire)).structuredContent.errorCode, 'session.recovery-unavailable'); }
    finally { release(); }
    core.database.raw.prepare('UPDATE outbox SET prompt_submitted=1 WHERE outbox_id=?').run(request.outbox_id);
    assert.equal((await workflow('decide', retire)).structuredContent.errorCode, 'session.recovery-unavailable', 'Inconsistent submission evidence is not an unsubmitted draft');
    core.database.raw.prepare('UPDATE outbox SET prompt_submitted=0 WHERE outbox_id=?').run(request.outbox_id);
    // Reproduce retained UNKNOWN child evidence without ever claiming it completed.
    core.database.raw.prepare("UPDATE generations SET submission_state='submission_unknown', completed_at=NULL, answer_text=NULL, response_message_id=NULL WHERE session_id=? AND generation=1").run(old.sessionId);
    const generations = () => core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(old.sessionId);
    const requests = () => core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation').all(old.sessionId);
    const beforeGenerations = generations(), beforeRequests = requests();
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
    assert.equal(await runCli(['request', 'retire_observation', team.teamId, String(request.outbox_id), '--discard-unresolved',
      '--evidence-ref', retire.evidenceRef, '--request-id', retire.requestId, '--socket', config.socketPath, '--json'],
      { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    const retired = JSON.parse(output);
    assert.equal(retired.disposition, 'observation-retired');
    assert.equal(retired.originalSubmissionState, 'prepared');
    assert.equal(retired.providerMutation, false);
    assert.deepEqual((await workflow('decide', retire)).structuredContent, retired, 'Same stable operation ID replays across CLI/MCP');
    assert.equal(core.teamDirectory.getSession(old.sessionId).sessionState, 'cancelled');
    assert.equal((await workflow('team_get', identity)).structuredContent.request.observationHeld, true);
    const { page, binding } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: '<textarea>Obsolete draft</textarea><button data-testid="stop-button" onclick="window.stops++">Stop</button><script>window.stops=0</script>' }));
    await page.goto('https://chatgpt.com/c/' + completed.conversationId);
    const deletion = { ...identity, requestId: 'delete-obsolete-prepared', outputsRetrieved: true,
      discardRetiredObservation: { conversationId: completed.conversationId, evidenceRef: retire.evidenceRef, discardPageState: true } };
    assert.equal((await workflow('session_delete', deletion)).structuredContent.errorCode, 'session.cleanup-not-ready', 'Unbound draft/Stop is protected');
    assert.equal(await page.locator('textarea').inputValue(), 'Obsolete draft');
    core.pageRegistry.bindPage(binding.pageKey, { sessionId: old.sessionId, generation: 2, conversationId: completed.conversationId });
    const { discardRetiredObservation: _discard, ...ordinary } = deletion;
    assert.equal((await workflow('session_delete', ordinary)).structuredContent.errorCode, 'session.cleanup-not-ready');
    const paced = (await workflow('session_delete', deletion)).structuredContent;
    assert.equal(paced.errorCode, 'provider.unavailable');
    assert.equal(paced.details.deletionAttempted, false);
    assert.equal(paced.details.httpStatus, 429);
    assert.deepEqual(paced.details.pageCleanup, { closedPages: 1, pageErrors: [] });
    assert.equal(page.isClosed(), true);
    assert.equal(deletes, 0, 'Provider verification deferral never attempts DELETE');
    unavailable = false;
    const deleted = (await workflow('session_delete', deletion)).structuredContent;
    assert.equal(deleted.deleted, true);
    assert.deepEqual((await workflow('session_delete', deletion)).structuredContent, deleted);
    assert.equal(deletes, 1, 'Canonical replay never repeats provider deletion');
    assert.deepEqual(generations(), beforeGenerations);
    assert.deepEqual(requests(), beforeRequests);
    assert.deepEqual(core.teamDirectory.getSession(successor.sessionId), successorBefore);
    assert.equal(core.actorScheduler.collectors(successor.sessionId).length, 1);
    assert.equal(fake.submitCount, 2, 'Only prior fixture and active successor were submitted, never the discarded preparation');
    assert.equal(fake.stopCount, 0);
  } finally { releaseSuccessor?.(); await core.close(); rmSync(root, { recursive: true, force: true }); }
});

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
    const discardPage = { ...input, requestId: 'dispose-owned-page',
      discardRetiredObservation: { ...input.discardRetiredObservation, discardPageState: true } };
    assert.equal((await workflow('session_delete', input)).structuredContent.errorCode, 'session.cleanup-not-ready');
    assert.equal((await workflow('session_delete', discardPage)).structuredContent.errorCode, 'session.cleanup-not-ready');
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
    const { page, binding } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea>Human draft</textarea>' }));
    await page.goto('https://chatgpt.com/c/' + first.conversationId);
    assert.equal((await workflow('session_delete', input)).structuredContent.errorCode, 'session.cleanup-not-ready');
    assert.equal((await workflow('session_delete', discardPage)).structuredContent.errorCode, 'session.cleanup-not-ready',
      'Explicit disposal must not discard an unbound page draft');
    assert.equal(await page.locator('textarea').inputValue(), 'Human draft');
    await page.setContent('<button data-testid="stop-button">Stop</button>');
    assert.equal((await workflow('session_delete', input)).structuredContent.errorCode, 'session.cleanup-not-ready');
    assert.equal((await workflow('session_delete', discardPage)).structuredContent.errorCode, 'session.cleanup-not-ready',
      'Explicit disposal must not waive an unbound page generation guard');
    assert.equal(deletes, 0);
    core.pageRegistry.bindPage(binding.pageKey, { sessionId: session.sessionId, generation: 2, conversationId: first.conversationId! });
    await page.setContent('<textarea>Explicitly discarded obsolete draft</textarea><button data-testid="stop-button">Stop</button>');
    assert.equal((await workflow('session_delete', input)).structuredContent.errorCode, 'session.cleanup-not-ready');
    const releaseAgain = core.actorScheduler.actorFor(session.sessionId).retainCollector(String(requests[1]!.outbox_id), false);
    try { assert.equal((await workflow('session_delete', discardPage)).structuredContent.errorCode, 'session.cleanup-not-ready'); }
    finally { releaseAgain(); }
    // Provider failure must not strand the explicitly discarded exact owned tab.
    unavailable = true;
    const unavailableDelete = await workflow('session_delete', discardPage);
    assert.equal(unavailableDelete.structuredContent.errorCode, 'provider.unavailable');
    assert.equal(unavailableDelete.structuredContent.details.pageCleanup.closedPages, 1);
    assert.equal(page.isClosed(), true);
    assert.equal(deletes, 0);
    unavailable = false;
    const reopened = await core.browserOwner!.createPage();
    await reopened.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: '<textarea>Discarded old draft</textarea><button data-testid="stop-button">Stop</button>' }));
    await reopened.page.goto('https://chatgpt.com/c/' + first.conversationId);
    core.pageRegistry.bindPage(reopened.binding.pageKey, { sessionId: session.sessionId, generation: 2, conversationId: first.conversationId! });
    const deleted = (await workflow('session_delete', discardPage)).structuredContent;
    assert.equal(deleted.deleted, true, JSON.stringify(deleted));
    assert.equal(deleted.discardedPageState, true);
    assert.deepEqual(deleted.pageCleanup, { closedPages: 1, pageErrors: [] });
    assert.equal(reopened.page.isClosed(), true);
    assert.deepEqual(generations(), before);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation').all(session.sessionId), preservedRequests);
    assert.deepEqual((await workflow('session_delete', discardPage)).structuredContent, deleted);
    const retained = await core.browserOwner!.createPage();
    await retained.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: '<textarea>Obsolete retained draft</textarea><button data-testid="stop-button">Stop</button>' }));
    await retained.page.goto('https://chatgpt.com/c/' + first.conversationId);
    core.pageRegistry.bindPage(retained.binding.pageKey, { sessionId: session.sessionId, generation: 2, conversationId: first.conversationId! });
    const replay = (await workflow('session_delete', discardPage)).structuredContent;
    assert.deepEqual(replay.pageCleanup, { closedPages: 2, pageErrors: [] });
    assert.equal(retained.page.isClosed(), true, 'Canonical disposal receipt permits remaining exact owned-page cleanup');
    assert.equal(deletes, 1);
    assert.deepEqual(core.teamDirectory.getSession(successor.sessionId), successorBefore);
    assert.equal(fake.submitCount, 3);
    assert.equal(fake.stopCount, 0);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
