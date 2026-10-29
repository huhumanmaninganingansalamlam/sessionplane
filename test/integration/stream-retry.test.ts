import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { SessionUiService } from '../../src/core/session-ui-service.ts';
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
  const markup = `<main><button type="button" role="radio" aria-checked="true">Chat</button><div data-chatgpt-search-message-ids="${snapshot.submittedUserMessageId}"><div data-user-message-bubble>Original work question</div></div>
    <aside role="alert"><div>${alertText}</div><button onclick="window.clicks=(window.clicks||0)+1">다시 시도</button></aside><textarea></textarea></main>`;
  await page.setContent(markup);
  const decide = () => invoke('decide', { teamId: team.teamId, requestRef: sent.requestRef,
    requestId: 'approved-continue', decision: 'continue', continuationApproved: true });
  return { core, fake, invoke, team, sent, snapshot, page, markup, decide,
    close: async () => { await core.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Work mode cannot retry an acknowledged turn or create a continuation', async () => {
  const f = await fixture();
  try {
    await f.page.setContent(f.markup.replace('>Chat</button>', '>Work</button>'));
    const before = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    const result = await f.decide();
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, 'provider.preparation-required');
    assert.match(String(result.structuredContent.message), /Work.*observation-only/);
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    assert.equal(f.fake.submitCount, 1);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM outbox').all(), before);
    assert.equal(f.core.teamDirectory.getSession(f.snapshot.sessionId).submittedUserMessageId, f.snapshot.submittedUserMessageId);
  } finally { await f.close(); }
});

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

test('owned Retry evidence distinguishes a retained closed shell from CSS invisibility without dismissing or retrying', async () => {
  const f = await fixture();
  try {
    await f.page.setContent(f.markup + outputPopover.replace('aria-controls="output-list"', '')
      .replace('data-state="open"', 'data-state="closed" aria-hidden="true" style="width:0;height:0;overflow:hidden;pointer-events:none"'));
    const before = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    const read = await f.invoke('team_get', { teamId: f.team.teamId, requestRef: f.sent.requestRef, view: 'evidence' });
    assert.equal(read.isError, false, JSON.stringify(read));
    const evidence = (read.structuredContent.request as any).evidence;
    const retry = evidence.submissionVerification.streamRetry;
    assert.equal(retry.reason, 'output-popover-closing');
    assert.equal(retry.outputPopover.rendering.checkVisibility, true, 'CSS visibility alone includes a clipped empty shell');
    const shell = retry.outputPopover.rendering.chain[0];
    assert.equal(shell.id, 'output-list');
    assert.equal(shell.ariaHidden, 'true');
    assert.equal(shell.box.width, 0);
    assert.equal(shell.box.height, 0);
    assert.equal(shell.overflowX, 'hidden');
    assert.deepEqual(shell.animations, []);
    assert.equal(retry.outputPopover.rendering.retry.centerHit, 'button');
    assert.ok(evidence.nodes.every((node: any) => node.id !== 'output-list'));
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE method LIKE 'session.stream-retry%'").get()!.n, 0);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM outbox').all(), before);
  } finally { await f.close(); }
});

// Current original-page evidence: a painted 300x86 closed document panel, no
// animation or linked trigger, aria-hidden+inert, and an unobscured Retry.
const inactiveOutputPopover = outputPopover.replace('aria-controls="output-list"', '')
  .replace('data-state="open"', 'data-state="closed" aria-hidden="true" inert style="position:fixed;left:860px;top:60px;width:300px;height:86px"');

test('a persistently rendered inert document-output panel permits exactly one original Retry without another toggle', async () => {
  const f = await fixture();
  try {
    await f.page.setViewportSize({ width: 1168, height: 811 });
    await f.page.setContent(f.markup + inactiveOutputPopover);
    const before = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    const result = await f.decide();
    assert.equal(result.isError, false, JSON.stringify(result));
    const retry = result.structuredContent.providerRetry as any;
    assert.equal(retry.outputPopover.inactive, true);
    assert.equal(retry.outputPopover.rendering.checkVisibility, true, 'the retained panel remains painted');
    assert.equal(retry.outputPopover.rendering.chain[0].box.width, 300);
    assert.equal(retry.outputPopover.rendering.chain[0].box.height, 86);
    assert.deepEqual(retry.outputPopover.rendering.chain[0].animations, []);
    assert.equal(retry.outputPopoverDismissed, false);
    assert.equal(retry.outputPopoverSettled, true);
    assert.equal(retry.clicked, true);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
    assert.equal(await f.page.evaluate(() => (window as any).clicks), 1);
    assert.equal((await f.decide()).structuredContent.errorCode, 'provider.action-unknown');
    assert.equal(f.fake.submitCount, 1);
    assert.equal(result.structuredContent.submittedUserMessageId, f.snapshot.submittedUserMessageId);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM outbox').all(), before);
  } finally { await f.close(); }
});

test('document-output settlement accepts the actual closed inert transition without waiting for CSS removal', async () => {
  const f = await fixture();
  try {
    await f.page.setContent(f.markup + outputPopover);
    await f.page.locator('header button').evaluate(button => {
      (button as HTMLButtonElement).onclick = () => {
        (window as any).dismissals = ((window as any).dismissals ?? 0) + 1;
        button.removeAttribute('aria-controls'); button.setAttribute('aria-expanded', 'false');
        const dialog = document.querySelector('#output-list')!;
        dialog.setAttribute('data-state', 'closed'); dialog.setAttribute('inert', ''); dialog.setAttribute('aria-hidden', 'true');
      };
    });
    const result = await f.decide();
    assert.equal(result.isError, false, JSON.stringify(result));
    const retry = result.structuredContent.providerRetry as any;
    assert.equal(retry.outputPopover.inactive, true);
    assert.equal(retry.outputPopover.rendering.checkVisibility, true);
    assert.equal(retry.outputPopoverDismissed, true);
    assert.equal(retry.outputPopoverSettled, true);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals), 1);
    assert.equal(await f.page.evaluate(() => (window as any).clicks), 1);
    assert.equal(f.fake.submitCount, 1);
  } finally { await f.close(); }
});

test('inactive-output classification keeps incomplete state, modal, permission, identity, draft and hit-test guards', async () => {
  const f = await fixture();
  try {
    for (const [popup, reason] of [
      [inactiveOutputPopover.replace(' inert ', ' '), 'output-popover-closing'],
      [inactiveOutputPopover.replace('aria-hidden="true"', ''), 'output-popover-closing'],
      [inactiveOutputPopover.replace('data-state="closed"', 'data-state="open"'), 'other-provider-control'],
      [inactiveOutputPopover.replace('role="dialog"', 'role="dialog" aria-modal="true"'), 'other-provider-control'],
      [inactiveOutputPopover.replace('<button aria-expanded="true">출력</button>', '<button aria-expanded="true">출력</button><p>Approve execution</p>'), 'other-provider-control'],
      [inactiveOutputPopover + '<div role="dialog">Process Start <button>Allow</button></div>', 'other-provider-control'],
      [inactiveOutputPopover + '<div data-message-author-role="user" data-message-id="later">Later work</div>', 'original-anchor-not-latest'],
      [inactiveOutputPopover + '<input value="Human draft">', 'preserve-draft'],
      [inactiveOutputPopover + '<div style="position:fixed;inset:0;z-index:9999"></div>', 'retry-obscured'],
    ]) {
      await f.page.setContent(f.markup + popup);
      const read = await f.invoke('team_get', { teamId: f.team.teamId, requestRef: f.sent.requestRef, view: 'evidence' });
      const verification = (read.structuredContent.request as any).evidence.submissionVerification;
      // Later-user evidence intentionally withholds the original Retry surface.
      if (reason === 'original-anchor-not-latest') assert.equal(verification.streamRetry, null);
      else assert.equal(verification.streamRetry.reason, reason);
      assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
      assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    }
    assert.equal((await f.decide()).structuredContent.errorCode, 'provider.preparation-required');
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE method LIKE 'session.stream-retry%'").get()!.n, 0);
    assert.equal(f.fake.submitCount, 1);
  } finally { await f.close(); }
});

test('normal Retry dismisses only a linked document-output popover, then collects the original ACK without resubmission', async () => {
  const f = await fixture('Hmm...something seems to have gone wrong.');
  try {
    await f.page.setContent(f.markup + outputPopover);
    const before = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    const evidence = (await f.invoke('team_get', { teamId: f.team.teamId, requestRef: f.sent.requestRef, view: 'evidence' })).structuredContent.request as any;
    assert.equal(evidence.evidence.submissionVerification.streamRetry.reason, 'output-popover-open', JSON.stringify(evidence.evidence.submissionVerification.streamRetry));
    assert.equal(evidence.evidence.submissionVerification.streamRetry.outputPopover.eligible, true);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0, 'inspection must not dismiss');
    // The provider retains its closed dialog during the exit animation and
    // removes aria-controls immediately. Closing is not yet invisibility.
    await f.page.locator('header button').evaluate(button => {
      (button as HTMLButtonElement).onclick = () => {
        (window as any).dismissals = ((window as any).dismissals ?? 0) + 1;
        button.setAttribute('aria-expanded', 'false'); button.removeAttribute('aria-controls');
        document.querySelector('#output-list')!.setAttribute('data-state', 'closed');
        setTimeout(() => document.querySelector('#output-list')!.remove(), 500);
      };
    });
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

test('an already-closing output popover settles without another toggle before the original Retry', async () => {
  const f = await fixture();
  try {
    await f.page.setContent(f.markup + outputPopover.replace('aria-controls="output-list"', '')
      .replace('aria-expanded="true" aria-controls', 'aria-expanded="false" aria-controls').replace('data-state="open"', 'data-state="closed"'));
    await f.page.locator('header button').evaluate(button => button.setAttribute('aria-expanded', 'false'));
    await f.page.evaluate(() => setTimeout(() => document.querySelector('#output-list')!.remove(), 500));
    const result = await f.decide();
    assert.equal(result.isError, false, JSON.stringify(result));
    const retry = result.structuredContent.providerRetry as any;
    assert.equal(retry.clicked, true);
    assert.equal(retry.outputPopoverDismissed, false);
    assert.equal(retry.outputPopoverSettled, true);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
    assert.equal(await f.page.evaluate(() => (window as any).clicks), 1);
    assert.equal(result.structuredContent.submittedUserMessageId, f.snapshot.submittedUserMessageId);
    assert.equal(f.fake.submitCount, 1);
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
    assert.equal((result.structuredContent.details as any).outputPopoverToggleDispatched, true);
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

test('owned output_panel inspects and closes only its open image/code panel without stream Retry, send, Stop or draft changes', async () => {
  const f = await fixture();
  try {
    // Hither's retained panel is image/code output chrome, with no stream-error alert.
    const panel = outputPopover.replace('문서', '이미지').replaceAll('report.md', 'observe-frame.png')
      .replace('</div></div>', '</div><div><button aria-label="request.json 열기" aria-describedby="code-type">request.json</button><span id="code-type">코드</span></div></div>')
      .replace("document.querySelector('#output-list').remove();", "const d=document.querySelector('#output-list');d.setAttribute('data-state','closed');d.setAttribute('inert','');d.setAttribute('aria-hidden','true');");
    await f.page.setContent(f.markup.replace(/<aside[\s\S]*?<\/aside>/, '') + panel);
    await f.page.locator('textarea').fill('Preserve the separate saved draft');
    const outbox = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    const ack = f.snapshot.submittedUserMessageId;
    const decide = (requestId: string, action: string, evidenceHash?: string) => f.invoke('decide', {
      teamId: f.team.teamId, requestRef: f.sent.requestRef, requestId, decision: 'output_panel', action,
      ...(evidenceHash ? { evidenceHash } : {}) });
    const inspected = await decide('panel-inspect', 'inspect');
    assert.equal(inspected.isError, false, JSON.stringify(inspected));
    const evidence = inspected.structuredContent.outputPanel as any;
    assert.equal(evidence.requestAcknowledgementVerified, true);
    assert.equal(evidence.surface.reason, 'output-popover-open');
    assert.equal(evidence.surface.outputPopover.eligible, true);
    assert.equal(evidence.surface.outputPopover.rendering.chain[0].inert, false);
    assert.equal(evidence.surface.outputPopover.rendering.chain[0].ariaHidden, null);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
    assert.equal((await decide('panel-stale', 'close', '0'.repeat(64))).isError, true);
    const close = await decide('panel-close', 'close', evidence.evidenceHash);
    assert.equal(close.isError, false, JSON.stringify(close));
    const result = close.structuredContent.outputPanel as any;
    assert.equal(result.outcome, 'toggle-dispatched');
    assert.equal(result.panelClosed, true);
    assert.equal(result.surface.outputPopover.inactive, true);
    assert.equal(result.surface.outputPopover.rendering.chain[0].ariaHidden, 'true');
    assert.equal(result.surface.outputPopover.rendering.chain[0].inert, true);
    assert.deepEqual((await decide('panel-close', 'close', evidence.evidenceHash)).structuredContent, close.structuredContent);
    const inactive = (await decide('panel-inactive', 'inspect')).structuredContent.outputPanel as any;
    assert.equal((await decide('panel-no-reopen', 'close', inactive.evidenceHash)).isError, false);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals), 1);
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    assert.equal(await f.page.locator('textarea').inputValue(), 'Preserve the separate saved draft');
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.core.teamDirectory.getSession(f.snapshot.sessionId).submittedUserMessageId, ack);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM outbox').all(), outbox);
    assert.equal(f.core.database.raw.prepare("SELECT count(*) n FROM request_receipts WHERE method LIKE 'session.stream-retry%'").get()!.n, 0);
  } finally { await f.close(); }
});

test('owned output_panel keeps actual modal, alert, unknown panel, ambiguous toggle, stale ACK and review-hold guards', async () => {
  const f = await fixture();
  try {
    const markup = f.markup.replace(/<aside[\s\S]*?<\/aside>/, '');
    const variants = [outputPopover + '<div role="dialog" aria-modal="true">Actual permission</div>',
      outputPopover + '<div role="alert">HostSpan permission required</div>',
      outputPopover.replace('>문서<', '>Unknown control<'),
      outputPopover.replace('<header>', '<header><button type="button" aria-controls="output-list">Other toggle</button>'),
      outputPopover.replace('data-state="open"', 'data-state="open" aria-modal="true"')];
    for (let i = 0; i < variants.length; i++) {
      await f.page.setContent(markup + variants[i]);
      const inspect = await f.invoke('decide', { teamId: f.team.teamId, requestRef: f.sent.requestRef,
        requestId: `guard-inspect-${i}`, decision: 'output_panel', action: 'inspect' });
      const evidence = inspect.structuredContent.outputPanel as any;
      assert.equal(evidence.surface.reason, 'other-provider-control');
      const close = await f.invoke('decide', { teamId: f.team.teamId, requestRef: f.sent.requestRef,
        requestId: `guard-close-${i}`, decision: 'output_panel', action: 'close', evidenceHash: evidence.evidenceHash });
      assert.equal(close.isError, true);
      assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
    }
    await f.page.setContent(markup + outputPopover);
    const current = await f.invoke('decide', { teamId: f.team.teamId, requestRef: f.sent.requestRef,
      requestId: 'current-inspect', decision: 'output_panel', action: 'inspect' });
    await f.page.locator('[data-user-message-bubble]').evaluate(e => e.parentElement!.setAttribute('data-chatgpt-search-message-ids', 'different-ack'));
    const changed = await f.invoke('decide', { teamId: f.team.teamId, requestRef: f.sent.requestRef,
      requestId: 'changed-close', decision: 'output_panel', action: 'close', evidenceHash: (current.structuredContent.outputPanel as any).evidenceHash });
    assert.equal(changed.isError, true);
    await f.page.setContent(markup + outputPopover);
    await f.invoke('decide', { teamId: f.team.teamId, requestRef: f.sent.requestRef, requestId: 'hold', decision: 'human_review', action: 'pause' });
    const held = await f.invoke('decide', { teamId: f.team.teamId, requestRef: f.sent.requestRef, requestId: 'held-close',
      decision: 'output_panel', action: 'close', evidenceHash: (current.structuredContent.outputPanel as any).evidenceHash });
    assert.equal(held.isError, true);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
    assert.equal(f.fake.submitCount, 1);
  } finally { await f.close(); }
});


test('only a verified inactive output panel stops blocking normal continuation inspection; an open panel or real modal still blocks', async () => {
  const f = await fixture();
  try {
    const ui = new SessionUiService({ submissions: f.core.submissionService, registry: f.core.pageRegistry,
      chatgptUrl: 'https://chatgpt.com/' });
    const markup = f.markup.replace(/<aside[\s\S]*?<\/aside>/, '');
    await f.page.setContent(markup + outputPopover);
    await assert.rejects(ui.verifyContinuation(f.snapshot, f.snapshot), /Continuation requires/);
    await f.page.setContent(markup + inactiveOutputPopover);
    const verified = await ui.verifyContinuation(f.snapshot, f.snapshot);
    assert.equal(verified.conversationId, f.snapshot.conversationId);
    await f.page.setContent(markup + inactiveOutputPopover + '<div role="dialog" aria-modal="true">Actual modal</div>');
    await assert.rejects(ui.verifyContinuation(f.snapshot, f.snapshot), /Continuation requires/);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(await f.page.evaluate(() => (window as any).clicks ?? 0), 0);
    assert.equal(await f.page.evaluate(() => (window as any).dismissals ?? 0), 0);
  } finally { await f.close(); }
});
