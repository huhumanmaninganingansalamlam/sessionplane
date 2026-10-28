import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

async function fixture(alertText = '메시지 스트림에 오류 발생') {
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
    <aside role="alert"><div>${alertText}</div><button onclick="window.clicks=(window.clicks||0)+1">다시 시도</button></aside><textarea></textarea></main>`;
  await page.setContent(markup);
  const decide = () => invoke('decide', { teamId: team.teamId, requestRef: sent.requestRef,
    requestId: 'approved-continue', decision: 'continue', continuationApproved: true });
  return { core, fake, invoke, team, sent, snapshot, page, markup, decide,
    close: async () => { await core.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const alertText of ['메시지 스트림에 오류 발생', 'Hmm...something seems to have gone wrong.']) {
test(`approved continue retries exact stream chrome once without resubmitting or changing the ACK; guards preserve work (${alertText})`, async () => {
  const f = await fixture(alertText);
  try {
    const before = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    for (const extra of ['<button aria-label="중지">Stop</button>', '<div role="dialog">Permission required</div>',
      '<div role="status">Disconnected. Waiting for full answer.</div>',
      '<div data-message-author-role="user" data-message-id="later">A later request</div>',
      `<aside role="alert">${alertText}<button>다시 시도</button></aside>`,
      '<div data-message-author-role="assistant" data-message-id="answer" data-message-status="complete"><div class="markdown">Completed answer</div></div>']) {
      await f.page.setContent(f.markup.replace('</main>', extra + '</main>'));
      assert.equal((await f.decide()).isError, true);
      assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    }
    await f.page.setContent(f.markup);
    await f.page.locator('aside button').evaluate(button => (button as HTMLButtonElement).disabled = true);
    assert.equal((await f.decide()).isError, true);
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    await f.page.setContent(f.markup.replace(alertText, 'An unknown provider error.'));
    assert.equal((await f.decide()).isError, true);
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
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

test(`continuation-approved managed wait uses stream Retry and collects the same original request result (${alertText})`, async () => {
  const f = await fixture(alertText);
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
}

test('offscreen Retry preparation preserves partial evidence and clicks the same original turn only once', async () => {
  const f = await fixture('Hmm...something seems to have gone wrong.');
  try {
    await f.page.setViewportSize({ width: 1280, height: 720 });
    await f.page.setContent(f.markup.replace('<aside', '<div data-message-author-role="assistant" data-message-id="partial">Preserved partial</div><aside style="margin-top:2500px"'));
    const before = await f.invoke('team_get', { teamId: f.team.teamId, requestRef: f.sent.requestRef, view: 'evidence' });
    assert.equal(await f.page.evaluate(() => scrollY), 0);
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    const result = await f.decide();
    assert.equal(result.isError, false, JSON.stringify(result));
    const diagnostic = (before.structuredContent.request as any).evidence.submissionVerification.streamRetry;
    assert.equal(diagnostic.reason, 'retry-offscreen');
    assert.equal(diagnostic.geometry.centerInViewport, false);
    assert.equal(diagnostic.geometry.viewport.height, 720);
    assert.ok(diagnostic.geometry.buttonBox.y > 720);
    const retry = result.structuredContent.providerRetry as any;
    assert.equal(retry.clicked, true);
    assert.equal(retry.viewportPrepared, true);
    assert.equal(retry.geometry.centerHit, 'button');
    assert.equal(result.structuredContent.requestRef, f.sent.requestRef);
    assert.equal(result.structuredContent.generation, 1);
    assert.equal(result.structuredContent.submittedUserMessageId, f.snapshot.submittedUserMessageId);
    assert.equal(await f.page.locator('[data-message-id="partial"]').innerText(), 'Preserved partial');
    assert.equal((await f.decide()).structuredContent.errorCode, 'provider.action-unknown');
    assert.equal(await f.page.evaluate(() => (window as any).clicks), 1);
    assert.equal(f.fake.submitCount, 1);
  } finally { await f.close(); }
});

test('Retry viewport preparation refuses real overlays and revalidates new drafts before an attempt receipt', async () => {
  const f = await fixture('Hmm...something seems to have gone wrong.');
  try {
    await f.page.setViewportSize({ width: 1280, height: 720 });
    await f.page.setContent(f.markup.replace('</main>', '<div style="position:fixed;inset:0;z-index:9999"></div></main>'));
    const blocked = await f.decide();
    assert.equal(blocked.structuredContent.errorCode, 'provider.preparation-required');
    assert.equal((blocked.structuredContent.details as any).retrySurface.reason, 'retry-obscured');
    assert.equal((blocked.structuredContent.details as any).retrySurface.geometry.centerInViewport, true);
    assert.equal((blocked.structuredContent.details as any).retrySurface.geometry.centerHit, 'other');
    assert.equal(await f.page.evaluate(() => scrollY), 0);
    await f.page.setContent(f.markup.replace('<aside', '<aside style="margin-top:2500px"'));
    await f.page.locator('aside button').evaluate(button => {
      const original = button.scrollIntoView.bind(button);
      button.scrollIntoView = options => { original(options); (document.querySelector('textarea') as HTMLTextAreaElement).value = 'New human draft'; };
    });
    const changed = await f.decide();
    assert.equal(changed.structuredContent.errorCode, 'provider.preparation-required');
    assert.equal(await f.page.locator('textarea').inputValue(), 'New human draft');
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE method='session.stream-retry'").get()!.n, 0);
    assert.equal(f.fake.submitCount, 1);
  } finally { await f.close(); }
});

// Retained Burncore output-list shape: a Radix dialog, expanded Outputs group,
// document button and separate description. The external toggle is mandatory.
const outputPopover = `<header><button type="button" aria-haspopup="dialog" aria-expanded="true" aria-controls="output-list"
  onclick="window.dismissals=(window.dismissals||0)+1;document.querySelector('#output-list').remove();this.setAttribute('aria-expanded','false')">Files</button></header>
  <div role="dialog" id="output-list" data-state="open"><button aria-expanded="true">출력</button>
  <div><button aria-label="report.md 열기" aria-describedby="document-type">report.md</button><span id="document-type">문서</span></div></div>`;

test('normal Retry dismisses only a linked document-output popover, then collects the original ACK without resubmission', async () => {
  const f = await fixture('Hmm...something seems to have gone wrong.');
  try {
    await f.page.setContent(f.markup + outputPopover);
    const before = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    const evidence = (await f.invoke('team_get', { teamId: f.team.teamId, requestRef: f.sent.requestRef, view: 'evidence' })).structuredContent.request as any;
    assert.equal(evidence.evidence.submissionVerification.streamRetry.reason, 'output-popover-open', JSON.stringify(evidence.evidence.submissionVerification.streamRetry));
    assert.equal(evidence.evidence.submissionVerification.streamRetry.outputPopover.eligible, true);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0, 'inspection must not dismiss');
    await f.page.exposeFunction('retryCompleted', () => {
      f.fake.emitObservation(f.snapshot.sessionId, { activity: 'none', candidate: {
        responseMessageId: 'output-recovered', answerText: 'Original result', terminalMarker: true, streamingMarker: false } });
    });
    await f.page.locator('aside button').evaluate(button => button.addEventListener('click', () => {
      document.querySelector('aside')!.remove(); void (window as any).retryCompleted();
    }));
    const result = await f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef], waitMs: 60000, continuationApproved: true });
    const row = (result.structuredContent.results as any[])[0];
    assert.equal(row.terminal, true, JSON.stringify(result));
    assert.equal(row.answerText, 'Original result');
    assert.equal(row.requestRef, f.sent.requestRef);
    assert.equal(row.generation, 1);
    assert.equal(row.submittedUserMessageId, f.snapshot.submittedUserMessageId);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals), 1);
    assert.equal(await f.page.evaluate(() => (window as any).clicks), 1);
    assert.equal(f.fake.submitCount, 1);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM outbox').all(), before);
  } finally { await f.close(); }
});

test('output-popover recovery preserves modal, permission, auth, identity, draft and ambiguous-toggle guards', async () => {
  const f = await fixture();
  try {
    for (const popup of [
      outputPopover.replace('role="dialog"', 'role="dialog" aria-modal="true"'),
      outputPopover.replace('aria-controls="output-list"', 'aria-controls="other"'),
      outputPopover.replace('</header>', '<button type="button" aria-haspopup="dialog" aria-expanded="true" aria-controls="output-list">Other</button></header>'),
      outputPopover.replace('<button aria-expanded="true">출력</button>', '<button aria-expanded="true">출력</button><p>Approve process execution</p>'),
      outputPopover + '<div role="dialog">Process Start <button>Allow</button></div>',
      outputPopover + '<div id="challenge-stage">Verify you are human</div>',
      outputPopover + '<div style="position:fixed;inset:0;z-index:9999"></div>',
      outputPopover + '<div data-message-author-role="user" data-message-id="later">Later work</div>',
      outputPopover + '<button aria-label="Stop generating">Stop</button>',
    ]) {
      await f.page.setContent(f.markup + popup);
      assert.equal((await f.decide()).isError, true);
      assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
      assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    }
    await f.page.setContent(f.markup + outputPopover);
    await f.page.locator('aside button').evaluate(button => (button as HTMLButtonElement).disabled = true);
    assert.equal((await f.decide()).isError, true);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
    await f.page.locator('aside button').evaluate(button => (button as HTMLButtonElement).disabled = false);
    await f.page.locator('textarea').fill('Preserved draft');
    assert.equal((await f.decide()).isError, true);
    assert.equal(await f.page.locator('textarea').inputValue(), 'Preserved draft');
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE method LIKE 'session.stream-retry%'").get()!.n, 0);
  } finally { await f.close(); }
});

for (const change of ['new-draft', 'still-open']) {
test(`popover preparation freshly rechecks work and never repeats its toggle (${change})`, async () => {
  const f = await fixture();
  try {
    await f.page.setContent(f.markup + outputPopover);
    await f.page.locator('header button').evaluate((button, change) => {
      if (change === 'still-open') (button as HTMLButtonElement).onclick = () => { (window as any).dismissals = 1; };
      else button.addEventListener('click', () => {
        (document.querySelector('textarea') as HTMLTextAreaElement).value = 'New draft during dismissal';
      });
    }, change);
    const result = await f.decide();
    assert.equal(result.structuredContent.errorCode, 'provider.preparation-required');
    assert.equal(await f.page.locator('textarea').inputValue(), change === 'new-draft' ? 'New draft during dismissal' : '');
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE method='session.stream-retry'").get()!.n, 0);
    // An owner reopening the popover cannot authorize a second automatic toggle.
    await f.page.setContent(f.markup + outputPopover);
    assert.equal((await f.decide()).structuredContent.errorCode, 'provider.action-unknown');
    assert.equal(await f.page.evaluate(() => (window as any).dismissals), 1);
  } finally { await f.close(); }
});
}

test('UNKNOWN Continue retries existing conversation chrome while preserving draft and ambiguous ACKs', async () => {
  const f = await fixture();
  try {
    f.core.database.raw.prepare("UPDATE generations SET submission_state='submission_unknown', submitted_user_message_id=NULL, submitted_user_turn_id=NULL WHERE session_id=?").run(f.snapshot.sessionId);
    const markup = f.markup.replace('<aside', `<div data-message-author-role="user" data-message-id="continue-one">계속</div>
      <div data-chatgpt-search-message-ids="continue-two"><div data-user-message-bubble>계속</div></div>
      <div data-chatgpt-search-message-ids="continue-three"><div data-user-message-bubble>계속</div></div>
      <div data-message-author-role="assistant" data-message-id="partial-answer">Existing partial work</div><aside`)
      .replace('<textarea>', '<button aria-label="GPT-6 Thinking">Model</button><textarea id="prompt-textarea">');
    await f.page.setContent(markup);
    await f.page.locator('textarea').fill('Unrelated human draft');
    assert.equal((await f.decide()).isError, true);
    assert.equal(await f.page.locator('textarea').inputValue(), 'Unrelated human draft');
    await f.page.locator('textarea').fill('계속');
    await f.page.locator('aside button').evaluate(button => button.addEventListener('click', () => {
      document.querySelector('aside')!.remove();
      document.querySelector('main')!.insertAdjacentHTML('beforeend',
        '<div data-message-author-role="assistant" data-message-id="retry-answer" data-message-status="complete">Existing work resumed</div>');
    }));
    const result = await f.decide();
    assert.equal(result.isError, false, JSON.stringify(result));
    const retry = result.structuredContent.providerRetry as any;
    assert.equal(retry.clicked, true);
    assert.equal(retry.observedUserMessageId, 'continue-three');
    assert.equal(retry.submittedUserMessageId, undefined);
    assert.equal(retry.requestAcknowledgementVerified, false);
    assert.equal(await f.page.locator('textarea').inputValue(), '계속');
    assert.equal(await f.page.evaluate(() => (window as any).clicks), 1);
    const observed = await f.invoke('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef: f.sent.requestRef });
    const request = observed.structuredContent.request as any;
    const candidate = request.evidence.submissionCandidates.find((entry: any) => entry.messageId === 'continue-three');
    assert.equal(candidate.responseCandidate.answerText, 'Existing work resumed');
    assert.equal(candidate.responseCandidate.submissionVerified, false);
    const stored = f.core.teamDirectory.getSession(f.snapshot.sessionId);
    assert.equal(stored.submissionState, 'submission_unknown');
    assert.equal(stored.submittedUserMessageId, null);
    assert.equal(stored.answerText, null);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.core.database.raw.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 1);
  } finally { await f.close(); }
});
