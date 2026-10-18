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

test('explicit refresh recovers an incomplete pre-submit page without replay or losing its records', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-incomplete-refresh-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let releaseScript!: () => void;
  const stalled = new Promise<void>(resolve => { releaseScript = resolve; });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'incomplete-fixture' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const { page, binding } = await core.browserOwner!.createPage();
    const conversationId = `conversation-${session.sessionId}`;
    const url = `https://chatgpt.com/c/${conversationId}`;
    let navigations = 0, blockDocument = false, challenge = false;
    await page.route('https://chatgpt.com/**', async route => {
      if (route.request().url().endsWith('/api/auth/session')) return route.fulfill({ json: { accessToken: 'fixture-only' } });
      if (route.request().url().endsWith('/blocked.js')) { await stalled; return route.abort().catch(() => {}); }
      navigations++;
      return route.fulfill({ contentType: 'text/html', body: blockDocument
        ? `<head><title>${challenge ? 'Just a moment...' : ''}</title><script src="/blocked.js"></script></head>`
        : '<main><textarea id="prompt-textarea">Provider-persisted draft</textarea></main>' });
    });
    await page.goto(url);
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => {
      core.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId, generation: request.generation, conversationId });
      return { ...await open(request), pageKey: binding.pageKey, bindAcknowledgement() {} };
    });
    fake.autoFinalText = 'Prior answer remains immutable';
    await core.submissionService.send({ clientId: 'incomplete-fixture', requestId: 'prior', sessionId: session.sessionId,
      prompt: 'Prior review', sessionDeadlineSec: 600 });
    for (let i = 0; i < 100 && !core.teamDirectory.getSession(session.sessionId).terminal; i++)
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(core.teamDirectory.getSession(session.sessionId).terminal, true);
    fake.prepareError = new ProviderSubmissionError('browser.unavailable', 'chatgpt Page did not reach DOM readiness before the navigation deadline');
    await assert.rejects(core.submissionService.send({ clientId: 'incomplete-fixture', requestId: 'failed', sessionId: session.sessionId,
      prompt: 'Preserved follow-up', sessionDeadlineSec: 600 }));
    const savedRows = core.database.raw.prepare('SELECT * FROM outbox ORDER BY generation').all();
    const savedGenerations = core.database.raw.prepare('SELECT * FROM generations ORDER BY generation').all();
    const failed = savedRows.at(-1)!;
    const args = { teamId: team.teamId, requestRef: failed.outbox_id, requestId: 'explicit-incomplete-refresh', decision: 'refresh' };
    const invoke = (arguments_: object) => invokeMcpTool({ name: 'sessionplane_decide', arguments: arguments_,
      socketPath: config.socketPath, timeoutMs: 40000, maxLineBytes: config.rpcMaxLineBytes });
    const sibling = await core.browserOwner!.createPage();
    await sibling.page.setContent('<textarea>Unrelated unsent draft</textarea>');
    const browserPid = core.browserOwner!.status.browserPid;
    blockDocument = true;
    challenge = true;
    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.title === 'Just a moment...' && document.body === null);
    const denied = await invoke({ ...args, requestId: 'verification-is-not-blank-recovery' });
    assert.equal(denied.structuredContent.errorCode, 'provider.human-action-required');
    assert.equal(navigations, 2);
    challenge = false;
    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.readyState === 'loading' && document.body === null && document.title === '');
    blockDocument = false;
    const result = await invoke(args);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.pageRefresh.dispatch, 'reload-returned');
    assert.equal(navigations, 4);
    assert.equal(page.url(), url);
    assert.equal(await page.locator('textarea').inputValue(), 'Provider-persisted draft');
    assert.equal(await sibling.page.locator('textarea').inputValue(), 'Unrelated unsent draft');
    assert.equal(core.browserOwner!.status.browserPid, browserPid);
    assert.equal(fake.submitCount, 1, 'Only the prior completed request was submitted');
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox ORDER BY generation').all(), savedRows);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations ORDER BY generation').all(), savedGenerations);
    assert.equal((await invoke(args)).isError, false);
    assert.equal(navigations, 4, 'Receipt replay never reloads again');

    fake.prepareError = null;
    fake.autoFinalText = null;
    fake.acknowledgementMode = 'missing';
    await assert.rejects(core.submissionService.send({ clientId: 'incomplete-fixture', requestId: 'unknown', sessionId: session.sessionId,
      prompt: 'Separate uncertain fixture', sessionDeadlineSec: 600 }), /acknowledgement was not proven/);
    const unknown = core.database.raw.prepare('SELECT * FROM outbox ORDER BY generation DESC LIMIT 1').get()!;
    assert.equal(unknown.submission_state, 'submission_unknown');
    blockDocument = true;
    await page.goto(url, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.readyState === 'loading' && document.body === null);
    t.mock.method(page, 'waitForLoadState', async () => { throw new Error('Fixture DOM readiness timeout'); });
    assert.equal((await invoke({ ...args, requestRef: unknown.outbox_id, requestId: 'unknown-must-not-bypass' })).structuredContent.errorCode, 'browser.unavailable');
    assert.equal(navigations, 5);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(unknown.outbox_id), unknown);
    assert.equal(fake.submitCount, 2);
  } finally {
    releaseScript();
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
