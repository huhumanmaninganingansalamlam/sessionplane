import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('native crash refresh reconnects only the original unsubmitted request without replay', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-crashed-refresh-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'crash-fixture' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const { page, binding } = await core.browserOwner!.createPage();
    const url = `https://chatgpt.com/c/conversation-${session.sessionId}`;
    let navigations = 0;
    await page.route('https://chatgpt.com/**', route => {
      if (route.request().url().endsWith('/api/auth/session')) return route.fulfill({ json: { accessToken: 'fixture-only' } });
      navigations++;
      return route.fulfill({ contentType: 'text/html', body: '<main><textarea id="prompt-textarea">Provider-persisted draft</textarea></main>' });
    });
    await page.goto(url);
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => {
      core.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId, generation: request.generation,
        conversationId: `conversation-${session.sessionId}` });
      return { ...await open(request), pageKey: binding.pageKey, bindAcknowledgement() {} };
    });
    fake.autoFinalText = 'Prior completed answer';
    await core.submissionService.send({ clientId: 'crash-fixture', requestId: 'prior', sessionId: session.sessionId,
      prompt: 'Prior question', sessionDeadlineSec: 600 });
    for (let i = 0; i < 100 && !core.teamDirectory.getSession(session.sessionId).terminal; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(core.teamDirectory.getSession(session.sessionId).terminal, true);
    fake.prepareError = new ProviderSubmissionError('browser.unavailable', 'page.waitForTimeout: Page crashed');
    await assert.rejects(core.submissionService.send({ clientId: 'crash-fixture', requestId: 'failed', sessionId: session.sessionId,
      prompt: 'Preserved original prompt', sessionDeadlineSec: 600 }));
    const original = core.teamDirectory.getSession(session.sessionId);
    assert.equal(original.submissionState, 'failed_pre_submit');
    assert.equal(original.promptSubmitted, false);
    const row = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? AND generation=?').get(session.sessionId, original.generation)!;
    const generations = core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(session.sessionId);
    const args = { teamId: team.teamId, requestRef: row.outbox_id, requestId: 'explicit-crash-refresh', decision: 'refresh' };
    const invoke = (name: string, arguments_: object) => invokeMcpTool({ name, arguments: arguments_,
      socketPath: config.socketPath, timeoutMs: 40000, maxLineBytes: config.rpcMaxLineBytes });
    // Error text alone is not a native crash event; do not create a bypass.
    const failedEvaluate = t.mock.method(page, 'evaluate', async () => { throw new Error('page.evaluate: Target crashed'); });
    const unproven = await invoke('sessionplane_decide', { ...args, requestId: 'unproven-crash' });
    assert.equal(unproven.structuredContent.errorCode, 'browser.unavailable');
    assert.equal(core.pageRegistry.observedCrash(binding.pageKey), null);
    assert.equal(navigations, 1);
    failedEvaluate.mock.restore();
    const sibling = await core.browserOwner!.createPage();
    await sibling.page.route('https://other.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea>Unrelated draft</textarea>' }));
    await sibling.page.goto('https://other.invalid/');
    const browserPid = core.browserOwner!.status.browserPid;
    // Exercise native orchestration with a crash event on the routed fixture.
    // The separate HTTP-backed controller test kills a real renderer (routes
    // attached to a dead controller cannot serve its subsequent navigation).
    page.emit('crash');
    const read = await invoke('sessionplane_team_get', { teamId: team.teamId, requestRef: row.outbox_id });
    const request = read.structuredContent.request as Record<string, any>;
    assert.equal(request.pageHealth.pageKey, binding.pageKey);
    assert.equal(request.pageHealth.identityMatches, true);
    assert.ok(request.pageHealth.crashObservedAt);
    assert.equal(request.terminal, true);
    assert.equal(request.promptSubmitted, false);
    // An uncertain controller failure retains its attempted receipt, never replaying refresh.
    const failRecovery = t.mock.method(core.browserOwner!, 'recoverCrashedPage', async () => {
      throw new Error('Fixture controller connection unavailable');
    });
    const failedArgs = { ...args, requestId: 'uncertain-controller-refresh' };
    assert.equal((await invoke('sessionplane_decide', failedArgs)).isError, true);
    assert.equal((await invoke('sessionplane_decide', failedArgs)).structuredContent.errorCode, 'provider.action-unknown');
    assert.equal(failRecovery.mock.callCount(), 1);
    assert.equal(navigations, 1);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(row.outbox_id), row);
    failRecovery.mock.restore();
    const result = await invoke('sessionplane_decide', args);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.pageRefresh.dispatch, 'reload-returned');
    assert.equal(result.structuredContent.pageRefresh.rendererCrash.draftPreservation, 'provider-persisted-only');
    const recovered = core.pageRegistry.pageForObservation(binding.pageKey);
    assert.notEqual(recovered, page);
    assert.equal(result.structuredContent.pageHealth.crashObservedAt, null);
    assert.equal(result.structuredContent.pageHealth.targetId, request.pageHealth.targetId);
    assert.equal(navigations, 2);
    assert.equal(recovered.url(), url);
    assert.equal(await recovered.locator('textarea').inputValue(), 'Provider-persisted draft');
    assert.equal(await sibling.page.locator('textarea').inputValue(), 'Unrelated draft');
    assert.equal(core.browserOwner!.status.browserPid, browserPid);
    assert.equal(fake.submitCount, 1, 'Only the completed prior generation was submitted');
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(row.outbox_id), row);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(session.sessionId), generations);
    assert.equal((await invoke('sessionplane_decide', args)).isError, false);
    assert.equal(navigations, 2, 'The same receipt never repeats recovery');
    fake.prepareError = null;
    fake.autoFinalText = null;
    await core.submissionService.send({ clientId: 'crash-fixture', requestId: 'active', sessionId: session.sessionId,
      prompt: 'Separate local fixture generation', sessionDeadlineSec: 600 });
    const active = core.teamDirectory.getSession(session.sessionId);
    assert.equal(active.promptSubmitted, true);
    assert.equal(active.terminal, false);
    const activeRow = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? AND generation=?').get(session.sessionId, active.generation)!;
    recovered.emit('crash');
    const refused = await invoke('sessionplane_decide', { ...args, requestRef: activeRow.outbox_id, requestId: 'active-crash-refresh' });
    assert.equal(refused.structuredContent.errorCode, 'browser.page-crashed');
    assert.equal((refused.structuredContent.details as Record<string, any>).dispatch, 'not-dispatched');
    assert.equal(navigations, 2);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(activeRow.outbox_id), activeRow);
    assert.equal((await invoke('sessionplane_decide', { ...args, requestId: 'stale-original-refresh' })).structuredContent.errorCode, 'session.generation-superseded');
    assert.equal(fake.submitCount, 2, 'Only the two explicitly sent fixture generations');
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
