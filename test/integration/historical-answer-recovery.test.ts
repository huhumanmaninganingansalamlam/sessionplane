import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('original quiet-final can be recovered through latest under an unsubmitted successor without altering either request', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-historical-answer-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
    observationQuietWindowMs: 25, observationQuietSweepMs: 25, observationActiveSweepMs: 25 });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'fixture-owner' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const { page, binding } = await core.browserOwner!.createPage();
    let navigations = 0;
    await page.route('https://chatgpt.com/**', route => {
      navigations++;
      return route.fulfill({ contentType: 'text/html', body: '<main><section id="messages"></section><textarea id="prompt-textarea"></textarea><button aria-label="Scroll to bottom">Latest</button></main>' });
    });
    await page.goto(`https://chatgpt.com/c/conversation-${session.sessionId}`);
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => {
      if (request.generation === 2) throw new SessionPlaneDomainError('provider.preparation-required', 'Prepare only');
      return { ...await open(request), pageKey: binding.pageKey, bindAcknowledgement() {
        core.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId, generation: 1,
          conversationId: `conversation-${session.sessionId}` });
      } };
    });
    const openObservation = fake.openObservation.bind(fake);
    t.mock.method(fake, 'openObservation', async request => {
      const source = await openObservation(request);
      const observe = source.observe.bind(source);
      t.mock.method(source, 'observe', async () => ({ ...await observe(), submittedUserFound: true,
        activity: 'none' as const, candidate: { responseMessageId: 'announcement',
          answerText: 'I will review the evidence.', terminalMarker: false, streamingMarker: false } }));
      return source;
    });
    await core.submissionService.send({ clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId, prompt: 'Review', sessionDeadlineSec: 600 });
    const deadline = Date.now() + 2_000;
    while (!core.teamDirectory.getSession(session.sessionId).terminal && Date.now() < deadline) {
      await core.actorScheduler.waitSession(session.sessionId, { expectedGeneration: 1, waitMs: 500 });
    }
    assert.equal(core.teamDirectory.getSession(session.sessionId).reason, 'dom-quiet-stable-final');
    await assert.rejects(core.submissionService.send({ clientId: 'fixture-owner', requestId: 'prepared-only', sessionId: session.sessionId, prompt: 'Finish review', sessionDeadlineSec: 600 }),
      (error: unknown) => error instanceof SessionPlaneDomainError && error.errorCode === 'provider.preparation-required');
    const current = core.teamDirectory.getSession(session.sessionId);
    core.pageRegistry.reservePage(binding.pageKey, current);
    const rows = () => ({ outbox: core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation').all(session.sessionId),
      generations: core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(session.sessionId),
      session: core.teamDirectory.getSession(session.sessionId) });
    const before = rows();
    const original = before.outbox[0]!;
    const latest = (id: string, requestRef = original.outbox_id) => invokeMcpTool({ name: 'sessionplane_decide',
      arguments: { teamId: team.teamId, requestRef, requestId: id, decision: 'latest' },
      socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    const transcript = '<div data-message-author-role="user" data-message-id="user-message-1">Review</div><div data-message-author-role="assistant" data-message-id="announcement">I will review the evidence.</div><div data-message-author-role="assistant" data-message-id="actual-final">VERDICT: APPROVE</div>';
    await page.locator('#messages').evaluate((node, html) => { node.innerHTML = html; }, transcript);
    await page.locator('textarea').fill('Preserved user draft');
    t.mock.method(page, 'bringToFront', async () => { throw new Error('No focus allowed'); });
    await page.locator('[data-message-id="actual-final"]').evaluate(node => node.remove());
    assert.equal(((await latest('announcement-only')).structuredContent.answerRecovery as any).reason, 'historical-answer-unchanged');
    await page.locator('#messages').evaluate((node, html) => { node.innerHTML = html; }, transcript);
    const result = await latest('recover-original');
    assert.equal(result.isError, false, JSON.stringify(result));
    const recovered = result.structuredContent.answerRecovery as Record<string, unknown>;
    assert.equal(result.structuredContent.generation, 1);
    assert.equal(result.structuredContent.bindingGeneration, 2);
    assert.equal(recovered.terminal, true);
    assert.equal(recovered.responseMessageId, 'actual-final');
    assert.equal(recovered.answerText, 'VERDICT: APPROVE');
    assert.equal((result.structuredContent.storedResult as any).responseMessageId, 'announcement');
    assert.deepEqual((await latest('recover-original')).structuredContent, result.structuredContent);
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved user draft');

    await page.evaluate(() => { const stop = document.createElement('button'); stop.id = 'active'; stop.setAttribute('aria-label', '중지'); document.querySelector('main')!.append(stop); });
    const active = await latest('still-active');
    assert.equal((active.structuredContent.answerRecovery as any).terminal, false);
    assert.equal((active.structuredContent.answerRecovery as any).answerText, null);
    await page.locator('#active').evaluate(node => node.remove());
    await page.evaluate(() => { const dialog = document.createElement('div'); dialog.id = 'limit'; dialog.setAttribute('role', 'dialog'); dialog.textContent = 'Too many requests'; document.body.append(dialog); });
    assert.equal(((await latest('rate-limit')).structuredContent.answerRecovery as any).reason, 'provider-rate-limit-dialog');
    await page.locator('#limit').evaluate(node => node.remove());

    await page.locator('#messages').evaluate(node => { node.innerHTML += '<div data-message-author-role="user" data-message-id="other-user">Other request</div><div data-message-author-role="assistant" data-message-id="other-answer" data-end-turn="true">Wrong answer</div>'; });
    assert.equal(((await latest('later-turn')).structuredContent.answerRecovery as any).terminal, false);
    assert.deepEqual(rows(), before);
    assert.equal(fake.submitCount, 1);
    assert.equal(navigations, 1);

    await page.goto('https://chatgpt.com/c/foreign-conversation');
    assert.equal((await latest('wrong-conversation')).structuredContent.requestOk, false);
    assert.deepEqual(rows(), before);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
