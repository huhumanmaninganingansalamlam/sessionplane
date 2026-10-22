import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-stream-retry-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 600000 });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const open = fake.openSubmission.bind(fake);
  fake.openSubmission = async request => {
    const submission = await open(request);
    const created = await core.browserOwner!.createPage();
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
    await created.page.goto(`https://chatgpt.com/c/conversation-${request.session.sessionId}`);
    return { ...submission, pageKey: created.binding.pageKey, bindAcknowledgement(ack) {
      submission.bindAcknowledgement(ack);
      core.pageRegistry.bindPage(created.binding.pageKey, { teamId: request.session.teamId,
        roleId: request.session.roleId, sessionId: request.session.sessionId, generation: request.generation,
        conversationId: `conversation-${request.session.sessionId}` });
    } };
  };
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: 'sessionplane_' + name,
    arguments: args, socketPath: config.socketPath, timeoutMs: 15000, maxLineBytes: config.rpcMaxLineBytes });
  const team = (await invoke('team_create', { requestId: 'team' })).structuredContent;
  const sent = (await invoke('send', { teamId: team.teamId, roleRef: (team.roles as any[])[0].roleRef,
    requestId: 'send', prompt: 'Original work question' })).structuredContent;
  const snapshot = core.teamDirectory.getSession(String(sent.sessionId));
  const page = core.pageRegistry.pageForObservation(snapshot.pageKey!);
  const markup = `<main><div data-chatgpt-search-message-ids="${snapshot.submittedUserMessageId}"><div data-user-message-bubble>Original work question</div></div>
    <aside role="alert"><div>메시지 스트림에 오류 발생</div><button onclick="window.clicks=(window.clicks||0)+1">다시 시도</button></aside><textarea></textarea></main>`;
  await page.setContent(markup);
  const decide = () => invoke('decide', { teamId: team.teamId, requestRef: sent.requestRef,
    requestId: 'approved-continue', decision: 'continue', continuationApproved: true });
  return { core, fake, invoke, team, sent, snapshot, page, markup, decide,
    close: async () => { await core.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('approved continue retries exact stream chrome once without resubmitting or changing the ACK; guards preserve work', async () => {
  const f = await fixture();
  try {
    const before = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    for (const extra of ['<button aria-label="중지">Stop</button>', '<div role="dialog">Permission required</div>',
      '<div data-message-author-role="user" data-message-id="later">A later request</div>',
      '<div data-message-author-role="assistant" data-message-id="answer"><div class="markdown">Partial answer</div></div>']) {
      await f.page.setContent(f.markup.replace('</main>', extra + '</main>'));
      assert.equal((await f.decide()).isError, true);
      assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    }
    await f.page.setContent(f.markup);
    await f.page.locator('textarea').fill('Human draft');
    assert.equal((await f.decide()).isError, true);
    assert.equal(await f.page.locator('textarea').inputValue(), 'Human draft');
    await f.page.locator('textarea').fill('');
    const result = await f.decide();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal((result.structuredContent.providerRetry as any).clicked, true);
    assert.equal(result.structuredContent.requestRef, f.sent.requestRef);
    assert.equal(result.structuredContent.generation, 1);
    assert.equal(result.structuredContent.submittedUserMessageId, f.snapshot.submittedUserMessageId);
    assert.equal((await f.decide()).structuredContent.errorCode, 'provider.action-unknown');
    assert.equal(await f.page.evaluate(() => (window as any).clicks), 1);
    assert.equal(f.fake.submitCount, 1);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM outbox').all(), before);
  } finally { await f.close(); }
});

test('continuation-approved managed wait uses stream Retry and collects the same original request result', async () => {
  const f = await fixture();
  try {
    await f.page.exposeFunction('retryCompleted', () => {
      f.fake.emitObservation(f.snapshot.sessionId, { activity: 'none', candidate: {
        responseMessageId: 'after-retry', answerText: 'Original work result', terminalMarker: true, streamingMarker: false } });
    });
    await f.page.evaluate(() => document.querySelector('aside button')!.addEventListener('click', () => {
      document.querySelector('aside')!.remove();
      void (window as any).retryCompleted();
    }));
    const result = await f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef],
      waitMs: 60000, continuationApproved: true });
    assert.equal(result.isError, false, JSON.stringify(result));
    const row = (result.structuredContent.results as any[])[0];
    assert.equal(row.requestRef, f.sent.requestRef);
    assert.equal(row.generation, 1);
    assert.equal(row.answerText, 'Original work result');
    assert.equal(row.terminal, true);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(await f.page.evaluate(() => (window as any).clicks), 1);
  } finally { await f.close(); }
});
