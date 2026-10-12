import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { SessionRepository } from '../../src/storage/session-repository.ts';
import { latestDisplayTarget } from '../../src/core/session-ui-service.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('failed exact request remains inspectable and displayable without reopening, retrying or changing its result', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-failed-display-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'fixture-owner' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const { page, binding } = await core.browserOwner!.createPage();
    const conversationId = `conversation-${session.sessionId}`;
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <div data-message-author-role="user" data-message-id="user-message-1">Original question</div>
      <div class="group/activity-header"><span>Thinking failed</span></div>
      <button id="retry">Retry</button><textarea id="prompt-textarea">Preserved draft</textarea>
      </main>` }));
    await page.goto(`https://chatgpt.com/c/${conversationId}`);
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => ({ ...await open(request), pageKey: binding.pageKey,
      bindAcknowledgement() { core.pageRegistry.reservePage(binding.pageKey,
        { sessionId: session.sessionId, generation: 1, conversationId }); } }));
    await core.submissionService.send({ clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId,
      prompt: 'Original question', sessionDeadlineSec: 600 });
    // Reproduce the durable result of reconcile_failure, without issuing another provider action.
    new SessionRepository(core.database.raw).updateCurrentGeneration(session.sessionId, 1, {
      sessionState: 'failed', providerState: 'error', observationTransport: 'fresh', nextCheckAt: null,
      completedAt: new Date().toISOString(), errorCode: 'provider.execution-failed', reason: 'thinking-failed-reconciled',
    }, new Date().toISOString());
    core.actorScheduler.refreshSession(session.sessionId);
    const outbox = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(session.sessionId)!;
    const generation = core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(session.sessionId)!;
    const invoke = (name: string, args: object) => invokeMcpTool({ name, arguments: { teamId: team.teamId,
      requestRef: outbox.outbox_id, ...args }, socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    t.mock.method(page, 'bringToFront', async () => { throw new Error('No focus'); });
    await page.locator('#retry').evaluate(button => button.addEventListener('click', () => { button.setAttribute('data-clicked', 'true'); }));

    const read = await invoke('sessionplane_team_get', {});
    assert.equal(read.isError, false, JSON.stringify(read));
    const result = read.structuredContent.request as Record<string, any>;
    assert.equal(result.terminal, true);
    assert.equal(result.errorCode, 'provider.execution-failed');
    assert.equal(result.evidence.submissionVerification.anchorPresent, true);
    assert.ok(result.evidence.nodes.some((node: { name: string }) => node.name === 'Retry'));
    assert.equal(result.responseMessageId, null);
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved draft');

    const display = await invoke('sessionplane_decide', { decision: 'latest', requestId: 'display-only' });
    assert.equal(display.isError, false, JSON.stringify(display));
    assert.equal(display.structuredContent.displayOutcome, 'already-present');
    assert.equal(display.structuredContent.displayTarget, 'submitted-anchor');
    assert.equal(display.structuredContent.anchorPresent, true);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(session.sessionId), generation);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(session.sessionId), outbox);
    assert.equal(fake.submitCount, 1);
    assert.equal(await page.locator('#retry').getAttribute('data-clicked'), null);

    const failed = core.teamDirectory.getSession(session.sessionId);
    assert.equal(latestDisplayTarget({ ...failed, errorCode: 'provider.access-denied' }), null);
    assert.equal(latestDisplayTarget({ ...failed, reason: 'other-terminal-failure' }), null);
    assert.equal(latestDisplayTarget({ ...failed, submittedUserMessageId: null, submittedUserTurnId: null }), null);
    await page.close();
    const pageCount = core.browserOwner!.status.pageCount;
    const missing = await invoke('sessionplane_team_get', {});
    assert.equal(missing.isError, false, JSON.stringify(missing));
    const missingResult = missing.structuredContent.request as Record<string, any>;
    assert.equal(missingResult.terminal, true);
    assert.equal(missingResult.evidence, null);
    assert.ok(missingResult.inspectionError);
    assert.equal(core.browserOwner!.status.pageCount, pageCount);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(session.sessionId), generation);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
