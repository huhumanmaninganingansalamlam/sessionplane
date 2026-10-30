import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { callRpc } from '../../src/cli/client.ts';
import { PageBindingRepository } from '../../src/storage/page-binding-repository.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('exact obsolete startup cleanup preserves active conversation, UNKNOWN, drafts and foreign/current targets across adoption', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-obsolete-startup-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  let deletes = 0;
  t.mock.method(fake, 'openDeletion', async () => { deletes++; throw Error('No provider deletion'); });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = (params: object) => callRpc<any>({ socketPath: config.socketPath, method: 'session.close_pages',
    params: { clientId: 'obsolete-startup', ...params }, timeoutMs: 10000 });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'obsolete-startup' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const stale = await core.browserOwner!.createPage();
    await stale.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea>Keep draft</textarea>' }));
    await stale.page.goto('https://chatgpt.com/');
    const archived = core.pageRegistry.reservePage(stale.binding.pageKey, { sessionId: session.sessionId, generation: 0 });
    // Reproduce Core adoption: new registry key is unbound, durable old key retains the exact gen0 target.
    const bindings = new PageBindingRepository(core.database.raw);
    bindings.upsert({ ...archived, pageKey: 'retained-old-core-key' });
    core.pageRegistry.unbindPage(stale.binding.pageKey);
    await core.submissionService.send({ clientId: 'obsolete-startup', requestId: 'send', sessionId: session.sessionId, prompt: 'Live original', sessionDeadlineSec: 600 });
    const original = core.teamDirectory.getSession(session.sessionId);
    const current = await core.browserOwner!.createPage();
    await current.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<button data-testid="stop-button">Stop</button>' }));
    await current.page.goto('https://chatgpt.com/c/' + original.conversationId);
    core.pageRegistry.reservePage(current.binding.pageKey, { sessionId: session.sessionId, generation: 1, conversationId: original.conversationId });
    await core.actorScheduler.updateGeneration(session.sessionId, 1, { pageKey: current.binding.pageKey });
    const before = core.teamDirectory.getSession(session.sessionId);
    const generations = core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').all(session.sessionId);
    const outbox = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').all(session.sessionId);
    const input = { sessionId: session.sessionId, generation: 1, conversationId: original.conversationId,
      evidenceRef: 'Current screen and exact durable startup ownership compared', obsoleteEmptyTargetId: archived.targetId };
    await assert.rejects(rpc(input), /draft or active generation/);
    for (const body of ['<button data-testid="stop-button">Stop</button>', '<div role="alert">Permission required</div>',
      '<div role="dialog">Review</div>', '<div data-message-author-role="assistant">Uncollected result</div>']) {
      await stale.page.setContent(body);
      await assert.rejects(rpc(input), /cleanup|Preserve/i);
      assert.equal(stale.page.isClosed(), false);
    }
    await stale.page.setContent('<textarea>\n</textarea>');
    await assert.rejects(rpc({ ...input, obsoleteEmptyTargetId: current.binding.targetId }), /current, foreign or unidentified/);
    // No historical owner and conflicting historical owners must both fail closed.
    await assert.rejects(rpc({ ...input, obsoleteEmptyTargetId: 'unowned-target' }), /current, foreign or unidentified/);
    bindings.upsert({ ...archived, pageKey: 'foreign-history', sessionId: 'foreign-session' });
    await assert.rejects(rpc(input), /current, foreign or unidentified/);
    bindings.upsert({ ...archived, pageKey: 'foreign-history', sessionId: session.sessionId, generation: 2 });
    await assert.rejects(rpc(input), /current, foreign or unidentified/);
    bindings.upsert({ ...archived, pageKey: 'foreign-history' });
    const result = await rpc(input);
    assert.deepEqual(result.pageCleanup, { closedPages: 1, pageErrors: [] });
    assert.equal(result.providerDeletionAttempted, false);
    assert.equal(stale.page.isClosed(), true);
    assert.equal(current.page.isClosed(), false);
    assert.deepEqual((await rpc(input)).pageCleanup, { closedPages: 0, pageErrors: [] });
    assert.deepEqual(core.teamDirectory.getSession(session.sessionId), before);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').all(session.sessionId), generations);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').all(session.sessionId), outbox);
    assert.equal(fake.stopCount, 0);
    assert.equal(fake.submitCount, 1);
    assert.equal(deletes, 0);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
