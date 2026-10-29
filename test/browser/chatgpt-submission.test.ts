import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { prepareFixture } from '../helpers/preparation-fixture.ts';

import { BrowserRefSnapshotStore } from '../../src/browser/ref-snapshot.ts';
import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry, PageRegistryError } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ProviderSubmissionError, type ProviderSubmissionAttempt } from '../../src/providers/provider-adapter.ts';
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';
import { ChatGptSubmission, recoverChatGptAcknowledgement, inspectChatGptSubmissionCandidates } from '../../src/providers/chatgpt/submission.ts';
import { observeChatGptSurface } from '../../src/providers/chatgpt/surface.ts';

test('Chat default remains selected through preparation and a later Work drift blocks the actual submit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chat-mode-submit-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <div role="radiogroup"><button type="button" id="chat" role="radio" aria-checked="true">Chat</button>
        <button type="button" id="work" role="radio" aria-checked="false" onclick="window.workClicks++">Work</button></div>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button" type="button" onclick="window.sends++">Send</button>
      <script>window.sends=0;window.workClicks=0;</script></main>` }));
    await page.goto('https://chatgpt.com/');
    registry.reservePage(binding.pageKey, { sessionId: 'chat-default', generation: 1 });
    const submission = new ChatGptSubmission({ page, pageKey: binding.pageKey, pageRegistry: registry,
      request: { session: sessionSnapshot({ sessionId: 'chat-default', pageKey: binding.pageKey }),
        generation: 1, prompt: 'Preserve exact prompt', model: null }, acknowledgementTimeoutMs: 100 });
    await prepareFixture(submission, page);
    assert.equal((await observeChatGptSurface(page)).mode, 'chat');
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'Preserve exact prompt');
    await page.evaluate(() => {
      document.querySelector('#chat')!.setAttribute('aria-checked', 'false');
      document.querySelector('#work')!.setAttribute('aria-checked', 'true');
    });
    await assert.rejects(submission.submitOnce(), /composer is Work/);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'Preserve exact prompt');
    assert.deepEqual(await page.evaluate(() => [(window as any).sends, (window as any).workClicks]), [0, 0]);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('same-conversation follow-up without optional mode chrome submits its exact prepared prompt once and captures ACK', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chat-default-followup-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', async route => {
      if (route.request().url().endsWith('/api/auth/session')) return await route.fulfill({ json: { accessToken: 'isolated-fixture-token' } });
      if (route.request().method() === 'POST') return await route.fulfill({ json: {} });
      await route.fulfill({ contentType: 'text/html', body: `<main>
        <div data-message-author-role="user" data-message-id="original-ack">Original preserved</div>
        <div data-message-author-role="assistant" data-message-id="original-answer">Original result preserved</div>
        <div id="prompt-textarea" role="textbox" contenteditable="true">Retained draft</div>
        <button data-testid="send-button" type="button">Send</button>
        <script>window.sends=0;
          document.querySelector('button').onclick=async()=>{
            window.sends++; const composer=document.querySelector('#prompt-textarea'); const text=composer.innerText;
            await fetch('/backend-api/f/conversation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
              action:'next',conversation_id:'followup-chat',parent_message_id:'original-answer',messages:[{
                id:'followup-ack',author:{role:'user'},content:{content_type:'text',parts:[text]}}]})});
            const user=document.createElement('div'); user.dataset.messageAuthorRole='user'; user.dataset.messageId='followup-ack';
            user.textContent=text; document.querySelector('main').append(user); composer.textContent='';
          };
        </script></main>` });
    });
    await page.goto('https://chatgpt.com/c/followup-chat');
    registry.reservePage(binding.pageKey, { sessionId: 'followup', generation: 2, conversationId: 'followup-chat' });
    const submission = new ChatGptSubmission({ page, pageKey: binding.pageKey, pageRegistry: registry,
      request: { session: { ...sessionSnapshot({ sessionId: 'followup', pageKey: binding.pageKey }), generation: 2,
        conversationId: 'followup-chat' }, generation: 2, prompt: 'Exact authorized follow-up', model: null }, acknowledgementTimeoutMs: 2000 });
    await submission.prepareForObservation();
    const snapshot = await new BrowserRefSnapshotStore().capture({ page, pageKey: binding.pageKey, bindingEpoch: 1, interactive: false });
    const composer = snapshot.nodes.find(n => n.role === 'textbox' && n.editable)!;
    const submit = snapshot.nodes.find(n => n.role === 'button' && n.name === 'Send')!;
    assert.ok(composer); assert.ok(submit);
    await submission.prepare({ composer: { ...composer, purpose: 'composer', selectedValue: null },
      submit: { ...submit, purpose: 'submit', selectedValue: null } });
    assert.equal((await observeChatGptSurface(page)).source, 'chat-default');
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'Exact authorized follow-up');
    await submission.submitOnce();
    const ack = await submission.captureAcknowledgement();
    assert.equal(ack?.conversationId, 'followup-chat');
    assert.equal(ack?.submittedUserMessageId, 'followup-ack');
    assert.equal(await page.locator('[data-message-id="followup-ack"]').innerText(), 'Exact authorized follow-up');
    assert.equal(await page.locator('[data-message-id="original-answer"]').innerText(), 'Original result preserved');
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const dispatch of [true, false]) test(`continuation Enter ${dispatch ? 'dispatches and accepts the exact ACK' : 'reports a no-op without claiming delivery or clicking Stop'}`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-enter-continuation-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', async route => {
      if (route.request().url().endsWith('/api/auth/session')) return await route.fulfill({ json: { accessToken: 'isolated-fixture-token' } });
      if (route.request().method() === 'POST') return await route.fulfill({ json: {} });
      return await route.fulfill({ contentType: 'text/html', body: `<main>
        <div role="radiogroup"><button role="radio" aria-checked="true">Chat</button></div>
        <div data-message-author-role="user" data-message-id="original-ack">Original</div>
        <div data-message-author-role="assistant" data-message-id="partial">Preserve partial</div>
        <div role="status">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div>
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
        <button data-testid="stop-button" onclick="window.stopCount++">Stop</button>
        <script>window.stopCount=0;window.sendCount=0;
        const composer=document.querySelector('#prompt-textarea');
        composer.addEventListener('keydown',async e=>{if(e.key!=='Enter'||e.shiftKey)return;e.preventDefault();if(!${dispatch})return;window.sendCount++;
          const text=composer.innerText;
          await fetch('/backend-api/f/conversation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
            action:'next',conversation_id:'keyboardconv123',parent_message_id:'partial',messages:[{
              id:'continuation-ack',author:{role:'user'},content:{content_type:'text',parts:[text]}}]})});
          const user=document.createElement('div');user.setAttribute('data-message-author-role','user');
          user.setAttribute('data-message-id','continuation-ack');user.textContent=text;document.querySelector('main').append(user);
          composer.textContent='';
        });</script></main>` });
    });
    await page.goto('https://chatgpt.com/c/keyboardconv123');
    registry.reservePage(binding.pageKey, { sessionId: 'confirmed-enter', generation: 3, conversationId: 'keyboardconv123' });
    const submission = new ChatGptSubmission({ page, pageKey: binding.pageKey, pageRegistry: registry,
      request: { session: { ...sessionSnapshot({ sessionId: 'confirmed-enter', pageKey: binding.pageKey }), generation: 3,
        conversationId: 'keyboardconv123' }, generation: 3, prompt: '계속', model: null }, acknowledgementTimeoutMs: 2000 });
    await submission.prepareForObservation();
    const snapshot = await new BrowserRefSnapshotStore().capture({ page, pageKey: binding.pageKey, bindingEpoch: 1, interactive: false });
    const composer = snapshot.nodes.find(node=>node.role==='textbox'&&node.editable)!;
    await submission.prepare({ composer: { ...composer, purpose: 'composer', selectedValue: null },
      submit: { ...composer, purpose: 'submit', selectedValue: null, submitGesture: 'enter' } });
    await submission.submitOnce();
    if (!dispatch) {
      await assert.rejects(submission.captureAcknowledgement(), (error: any) => error.errorCode === 'provider.submit-dispatch-unobserved');
      assert.equal(await page.locator('#prompt-textarea').innerText(), '계속');
      assert.deepEqual(await page.evaluate(()=>({send:(window as any).sendCount,stop:(window as any).stopCount})), {send:0,stop:0});
      return;
    }
    const ack = await submission.captureAcknowledgement();
    assert.equal(ack?.submittedUserMessageId, 'continuation-ack');
    assert.equal(ack?.conversationId, 'keyboardconv123');
    assert.equal(await page.locator('[data-message-id="partial"]').innerText(), 'Preserve partial');
    assert.deepEqual(await page.evaluate(()=>({send:(window as any).sendCount,stop:(window as any).stopCount})), {send:1,stop:0});
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('UNKNOWN history acknowledgement requires retained ownership, empty draft and exact canonical prompt', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-history-ack-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body:
      '<main><textarea id="prompt-textarea"></textarea><div data-message-author-role="user" data-message-id="original-user">Exact original</div></main>' }));
    await page.goto('https://chatgpt.com/');
    registry.reservePage(binding.pageKey, { sessionId: 'original', generation: 1 });
    await page.evaluate(() => history.pushState({}, '', '/c/recovered123456'));
    const session = { ...sessionSnapshot({ sessionId: 'original', pageKey: binding.pageKey }),
      submissionState: 'submission_unknown' as const, promptSubmitted: true };
    let serverPrompt = 'Unrelated';
    t.mock.method(page.context().request, 'get', async (url: string) => ({
      status: () => 200, headers: () => ({}), dispose: async () => {},
      json: async () => url.endsWith('/api/auth/session') ? { accessToken: 'isolated-fixture-token' } : {
        id: 'recovered123456', current_node: 'original-user', mapping: {
          'original-user': { parent: null, message: { id: 'original-user', author: { role: 'user' },
            content: { content_type: 'text', parts: [serverPrompt] } } },
        },
      },
    }));
    let selection = (await inspectChatGptSubmissionCandidates(page, 'recovered123456'))[0]!;
    assert.ok(selection);
    const recover = (selected = true) => new ChatGptAdapter({ browserOwner: owner, pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/', acknowledgementTimeoutMs: 100 }).recoverAcknowledgement({
        session, generation: 1, prompt: 'Exact original', ...(selected ? { selection } : {}) });
    assert.equal(await recover(false), null, 'navigation alone never confirms submission');
    assert.equal(await recover(), null, 'selected DOM echo cannot override canonical mismatch');
    assert.equal(registry.getBinding(binding.pageKey).state, 'identity_lost');
    serverPrompt = 'Exact original';
    await page.locator('textarea').fill('Human draft');
    assert.equal(await recover(), null);
    assert.equal(await page.locator('textarea').inputValue(), 'Human draft');
    await page.locator('textarea').fill('');
    assert.throws(() => registry.unknownConversationCandidate(binding.pageKey, { sessionId: 'foreign', generation: 1 }));
    assert.throws(() => registry.unknownConversationCandidate(binding.pageKey, { sessionId: 'original', generation: 2 }));
    // Reattachment restores only the exact persisted target reservation, never its ACK.
    const targetId = registry.getBinding(binding.pageKey).targetId!;
    const restarted = new PageRegistry();
    const retained = restarted.identifyPage(page, targetId);
    assert.throws(() => restarted.reserveUnknownConversationCandidate(retained.pageKey,
      { sessionId: 'original', generation: 1, targetId: 'wrong-target' }));
    restarted.reserveUnknownConversationCandidate(retained.pageKey, { sessionId: 'original', generation: 1, targetId });
    assert.equal(restarted.unknownConversationCandidate(retained.pageKey, session).binding.state, 'identity_lost');
    assert.ok(await recoverChatGptAcknowledgement(page, 'Exact original', 'recovered123456', selection), 'stable selected DOM evidence');
    let compared: readonly string[] = [];
    assert.equal(await recoverChatGptAcknowledgement(page, 'Exact original changed', 'recovered123456', {
      ...selection, verifyExactPrompt: true, onPromptMismatch: values => { compared = values; },
    }), null);
    assert.ok(compared.includes('Exact original'), 'Retained full-text mismatch exposes its actual text candidates to privacy-safe diagnostics');
    // Rendered line breaks need not match canonical text. Diagnostic expansion
    // must not change the explicitly selected evidence before canonical recovery.
    await page.locator('[data-message-id="original-user"]').evaluate(node => {
      node.innerHTML = '<div class="whitespace-pre-wrap" style="white-space:pre-wrap">Exact\n\noriginal</div><button aria-expanded="false">More</button>';
      node.querySelector('button')!.onclick = event => {
        (event.currentTarget as HTMLButtonElement).textContent = 'Collapse';
      };
    });
    selection = (await inspectChatGptSubmissionCandidates(page, 'recovered123456'))[0]!;
    const ack = await recover();
    assert.equal(ack?.submittedUserMessageId, 'original-user');
    assert.equal(ack?.conversationId, 'recovered123456');
    assert.equal(await page.locator('button').innerText(), 'More', 'ACK recovery preserves the selected message surface');
    assert.equal(registry.requireSessionPage(binding.pageKey, { ...session, conversationId: 'recovered123456' }), page);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('retained UNKNOWN with a collapsed user bubble recovers only the full canonical original without sending', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-unknown-collapsed-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  const prompt = 'Exact original ' + 'context '.repeat(180) + 'final tail';
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body:
      '<main><textarea id="prompt-textarea"></textarea><div data-message-author-role="user" data-message-id="retained-user">Exact original…<button>더 보기</button></div><button data-testid="stop-button">Stop</button></main><script>window.clicks=0;document.querySelectorAll("button").forEach(b=>b.onclick=()=>window.clicks++)</script>' }));
    await page.goto('https://chatgpt.com/');
    registry.reservePage(binding.pageKey, { sessionId: 'original', generation: 1 });
    await page.evaluate(() => history.pushState({}, '', '/c/collapsedoriginal'));
    const session = { ...sessionSnapshot({ sessionId: 'original', pageKey: binding.pageKey }),
      submissionState: 'submission_unknown' as const, promptSubmitted: true };
    let canonical = prompt + ' wrong';
    t.mock.method(page.context().request, 'get', async (url: string) => ({
      status: () => 200, headers: () => ({}), dispose: async () => {},
      json: async () => url.endsWith('/api/auth/session') ? { accessToken: 'isolated-fixture-token' } : {
        id: 'collapsedoriginal', current_node: 'retained-user', mapping: {
          'retained-user': { parent: null, message: { id: 'retained-user', author: { role: 'user' },
            content: { content_type: 'text', parts: [canonical] } } },
        },
      },
    }));
    const recover = () => new ChatGptAdapter({ browserOwner: owner, pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/' }).recoverAcknowledgement({ session, generation: 1, prompt });
    assert.equal(await recover(), null, 'Prefix/collapsed DOM never overrides a canonical tail mismatch');
    assert.equal(registry.getBinding(binding.pageKey).state, 'identity_lost');
    canonical = prompt;
    await page.locator('textarea').fill('Preserve human draft');
    assert.equal(await recover(), null, 'Canonical proof cannot clear or adopt a human draft');
    assert.equal(await page.locator('textarea').inputValue(), 'Preserve human draft');
    await page.locator('textarea').fill('');
    const recovered = await recover();
    assert.equal(recovered?.submittedUserMessageId, 'retained-user');
    assert.equal(recovered?.conversationId, 'collapsedoriginal');
    assert.equal(recovered?.evidence, 'backend-exact-user');
    assert.equal(registry.getBinding(binding.pageKey).state, 'owned');
    assert.equal(await page.evaluate(() => (window as any).clicks), 0, 'No More/Stop/Submit button is needed');
    assert.equal(await page.locator('textarea').inputValue(), '');
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an accepted dispatch with only the older duplicate mounted preserves attempt identity without ACK', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-dispatch-proof-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  const attempts: ProviderSubmissionAttempt[] = [];
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', async route => {
      if (route.request().url().endsWith('/api/auth/session')) {
        return await route.fulfill({ json: { accessToken: 'fixture-only-token' } });
      }
      if (route.request().method() === 'POST') return await route.fulfill({ json: {} });
      await route.fulfill({ contentType: 'text/html', body: `<main>
        <div data-message-author-role="user" data-message-id="old-user">Question</div>
        <div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button>
        <script>window.sendCount=0;document.querySelector('button').onclick=()=>{
          window.sendCount++;const composer=document.querySelector('#prompt-textarea');
          for(const id of (window.duplicate?['new-user-2','new-user-3']:['new-user'])) {
          void fetch('/backend-api/f/conversation',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({action:'next',conversation_id:'proofconv123',parent_message_id:'old-answer',
              messages:[{id,author:{role:'user'},content:{content_type:'text',parts:[composer.textContent]}}]})});
          if(window.duplicate){const node=document.createElement('div');node.setAttribute('data-message-author-role','user');
            node.setAttribute('data-message-id',id);node.textContent=composer.textContent;document.querySelector('main').append(node);}}
          composer.textContent='';};</script></main>` });
    });
    await page.goto('https://chatgpt.com/c/proofconv123');
    registry.refreshPage(binding.pageKey);
    registry.reservePage(binding.pageKey, { sessionId: 'proof-session', generation: 2, conversationId: 'proofconv123' });
    const newSubmission = () => new ChatGptSubmission({ page, pageKey: binding.pageKey, pageRegistry: registry,
      request: { session: { ...sessionSnapshot({ sessionId: 'proof-session', pageKey: binding.pageKey }),
        generation: 2, conversationId: 'proofconv123' }, generation: 2, prompt: 'Question', model: null,
        onSubmissionAttempt: attempt => attempts.push(attempt) }, acknowledgementTimeoutMs: 100 });
    const submission = newSubmission();
    await prepareFixture(submission, page);
    await submission.submitOnce();
    assert.equal(await submission.captureAcknowledgement(), null);
    assert.equal(attempts.length, 1);
    assert.deepEqual({ ...attempts[0], observedAt: null }, { conversationId: 'proofconv123',
      messageId: 'new-user', parentMessageId: 'old-answer',
      textHash: createHash('sha256').update('Question').digest('hex'), observedAt: null });
    assert.equal(await page.evaluate(() => (window as Window & { sendCount: number }).sendCount), 1);
    assert.equal(await page.locator('[data-message-id]').count(), 1, 'no new DOM identity was invented');
    await page.evaluate(() => { (window as Window & { duplicate: boolean }).duplicate = true; });
    const ambiguous = newSubmission();
    await prepareFixture(ambiguous, page);
    await ambiguous.submitOnce();
    assert.equal(await ambiguous.captureAcknowledgement(), null, 'two accepted new IDs must not pick the first DOM node');
    assert.deepEqual(attempts.slice(1).map(a => a.messageId), ['new-user-2', 'new-user-3']);
    assert.equal(await page.evaluate(() => (window as Window & { sendCount: number }).sendCount), 2);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ChatGPT acknowledgement recovery uses exact text or an unchanged explicit message selection', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-ack-recovery-'));
  const prompt = 'Recover `C17=B` exactly';
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });
  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<html><body><div id="prompt-textarea" contenteditable="true"></div><div data-message-author-role="user" data-message-id="user-1" data-turn-id="turn-1"><button aria-expanded="false"></button><div id="prompt" class="whitespace-pre-wrap" hidden>Recover <code>C17=B</code> exactly</div><script>document.querySelector("button").addEventListener("click", () => { document.querySelector("#prompt").hidden = false; });</script></div></body></html>',
      });
    });
    await created.page.goto('https://chatgpt.com/c/auditconv123');
    const recovered = await recoverChatGptAcknowledgement(created.page, prompt, 'auditconv123');
    assert.deepEqual(recovered, {
      evidence: 'stable-anchor-cleared-composer',
      conversationId: 'auditconv123',
      submittedUserMessageId: 'user-1',
      submittedUserTurnId: 'turn-1',
    });

    await created.page.setContent('<div id="prompt-textarea" contenteditable="true"></div><div data-chatgpt-search-message-ids="user-1"><div data-user-message-bubble><div><div><p>First paragraph</p><p>URL: <a style="display:block">https://example.com/</a> exactly</p></div><button aria-expanded="true">Collapse</button></div></div></div>');
    const structuredPrompt = 'First paragraph\n\nURL: https://example.com/ exactly';
    assert.equal((await recoverChatGptAcknowledgement(created.page, structuredPrompt, 'auditconv123'))?.submittedUserMessageId, 'user-1');
    assert.equal(await recoverChatGptAcknowledgement(created.page, structuredPrompt + ' changed', 'auditconv123'), null);

    await created.page.setContent('<div id="prompt-textarea" contenteditable="true"></div><div data-message-id="old-user"><div data-message-author-role="user"><div data-message-author-role="user">Older prompt</div></div></div><div data-message-author-role="user" data-message-id="exact-user"><div class="whitespace-pre-wrap">Recover <code>C17=B</code> exactly</div></div>');
    assert.equal((await recoverChatGptAcknowledgement(created.page, prompt, 'auditconv123'))?.submittedUserMessageId, 'exact-user');

    await created.page.setContent(
      '<div id="prompt-textarea" contenteditable="true"></div><div data-message-author-role="user" data-message-id="user-1" data-turn-id="turn-1"><div class="whitespace-pre-wrap">Recover <code>C17=B</code> exactly</div></div><div data-message-author-role="user" data-message-id="user-2" data-turn-id="turn-2"><div class="whitespace-pre-wrap">Recover <code>C17=B</code> exactly</div></div>',
    );
    assert.equal(
      await recoverChatGptAcknowledgement(created.page, prompt, 'auditconv123'),
      null,
    );
    const [candidate] = await inspectChatGptSubmissionCandidates(created.page, 'auditconv123');
    assert.ok(candidate);
    const selection = { messageId: candidate.messageId, evidenceHash: candidate.evidenceHash };
    assert.equal((await recoverChatGptAcknowledgement(created.page, 'Original text with different formatting', 'auditconv123', selection))?.submittedUserMessageId, candidate.messageId);
    // Live Deeptrade renders an unlabelled-id composer as the supported main textbox.
    await created.page.locator('#prompt-textarea').evaluate(element => {
      const main = document.createElement('main'); element.before(main); main.append(element);
      element.removeAttribute('id'); element.setAttribute('role', 'textbox');
    });
    const composer = created.page.locator('main [role="textbox"]');
    assert.equal((await recoverChatGptAcknowledgement(created.page, prompt, 'auditconv123', selection))?.submittedUserMessageId, candidate.messageId);
    await created.page.locator('main').evaluate(element => element.insertAdjacentHTML('afterbegin',
      '<article data-chatgpt-search-message-ids="assistant-code"><div role="textbox" contenteditable="true" aria-label="코드 편집">Keep this response code intact</div></article>'));
    assert.equal((await recoverChatGptAcknowledgement(created.page, prompt, 'auditconv123', selection))?.submittedUserMessageId,
      candidate.messageId, 'A response code editor is not a retained composer draft');
    assert.equal(await created.page.locator('article [role="textbox"]').innerText(), 'Keep this response code intact');
    await created.page.locator('article').evaluate(element => element.remove());
    await composer.evaluate(element => { element.textContent = 'Retained manual draft'; });
    assert.equal(await recoverChatGptAcknowledgement(created.page, prompt, 'auditconv123', selection), null);
    assert.equal(await composer.innerText(), 'Retained manual draft');
    await composer.evaluate(element => { element.textContent = ''; element.insertAdjacentHTML('afterend', '<div role="textbox" contenteditable="true"></div>'); });
    assert.equal(await recoverChatGptAcknowledgement(created.page, prompt, 'auditconv123', selection), null);
    await composer.nth(1).evaluate(element => element.remove());
    assert.equal(await recoverChatGptAcknowledgement(created.page, prompt, 'other-conversation', selection), null);
    await created.page.locator('[data-message-id="user-1"] .whitespace-pre-wrap').evaluate((element) => { element.textContent = 'edited'; });
    assert.equal(await recoverChatGptAcknowledgement(created.page, prompt, 'auditconv123', selection), null);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('submission candidates preserve text beyond 4000 characters and reject a changed tail', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-full-candidate-'));
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: new PageRegistry(), headless: true });
  const prompt = 'x'.repeat(4000) + '\nExact final paragraph 끝';
  try {
    await owner.start();
    const { page } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: '<main><div id="prompt-textarea" contenteditable="true"></div><div data-message-author-role="user" data-message-id="long-user" data-turn-id="long-turn" style="white-space: pre-wrap"></div></main>' }));
    await page.goto('https://chatgpt.com/c/fullcandidate123');
    const user = page.locator('[data-message-id="long-user"]');
    await user.evaluate((element, text) => { element.textContent = text; }, prompt);
    const [candidate] = await inspectChatGptSubmissionCandidates(page, 'fullcandidate123');
    assert.ok(candidate);
    assert.equal(candidate.text, prompt);
    assert.equal(candidate.textTruncated, false);
    const selection = { messageId: candidate.messageId, evidenceHash: candidate.evidenceHash };
    assert.equal((await recoverChatGptAcknowledgement(page, prompt, 'fullcandidate123', selection))?.submittedUserTurnId, 'long-turn');
    await user.evaluate(element => { element.textContent += ' changed'; });
    assert.equal(await recoverChatGptAcknowledgement(page, prompt, 'fullcandidate123', selection), null);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('ChatGPT submission captures exact conversation and user-turn acknowledgement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-submit-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false)
          .replace('window.sendCount += 1;', `window.sendCount += 1;
            void fetch('/backend-api/conversation', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages:[{id:'user-message-1',author:{role:'user'}}]})});`)
          .replace('message.textContent = prompt;', 'message.textContent = "Rendered wrapper: " + prompt;')
          .replace(
            '<button data-testid="send-button" type="button">Send</button>',
            '<button data-testid="send-button" type="button" disabled>Send</button><script>document.querySelector("#prompt-textarea").addEventListener("input", () => setTimeout(() => document.querySelector("[data-testid=send-button]").disabled = false, 500))</script>',
          ),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-exact',
      generation: 1,
      conversationId: null,
    });

    const request = {
      session: sessionSnapshot({
        sessionId: 'session-exact',
        pageKey: created.binding.pageKey,
      }),
      generation: 1,
      prompt: 'Exact prompt body',
      model: null,
    } as const;
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request,
      acknowledgementTimeoutMs: 2_000,
    });

    await prepareFixture(submission, created.page);
    assert.equal(await created.page.locator('#prompt-textarea').textContent(), request.prompt);

    await submission.submitOnce();
    assert.notEqual(await created.page.locator('[data-message-id="user-message-1"]').innerText(), request.prompt);
    const acknowledgement = await submission.captureAcknowledgement();
    assert.deepEqual(acknowledgement, {
      evidence: 'accepted-request-stable-anchor-cleared-composer',
      conversationId: 'conversation-123456',
      submittedUserMessageId: 'user-message-1',
      submittedUserTurnId: 'user-turn-1',
    });
    assert.equal(await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount), 1);

    assert.notEqual(acknowledgement, null);
    if (acknowledgement !== null) {
      submission.bindAcknowledgement(acknowledgement);
    }
    const binding = registry.getBinding(created.binding.pageKey);
    assert.equal(binding.state, 'owned');
    assert.equal(binding.sessionId, 'session-exact');
    assert.equal(binding.generation, 1);
    // A positive DOM cannot turn a rejected provider POST into success.
    const rejectedPage = await owner.createPage();
    await rejectedPage.page.route('https://chatgpt.com/**', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 429, body: 'rate limited' });
      else await route.fulfill({ status: 200, contentType: 'text/html', body: chatGptFixture(false).replaceAll('conversation-123456', 'rejected-conversation') });
    });
    await rejectedPage.page.goto('https://chatgpt.com/');
    registry.refreshPage(rejectedPage.binding.pageKey);
    registry.reservePage(rejectedPage.binding.pageKey, { sessionId: 'rejected-session', generation: 1, conversationId: null });
    const rejected = new ChatGptSubmission({ page: rejectedPage.page, pageKey: rejectedPage.binding.pageKey,
      pageRegistry: registry, request: { ...request, session: sessionSnapshot({ sessionId: 'rejected-session', pageKey: rejectedPage.binding.pageKey }) },
      acknowledgementTimeoutMs: 500 });
    await prepareFixture(rejected, rejectedPage.page);
    await rejected.submitOnce();
    assert.equal(await rejected.captureAcknowledgement(), null);
    assert.equal(await rejectedPage.page.evaluate(() => (window as Window & { sendCount: number }).sendCount), 1);

    // Same request: no second click, even when an optimistic node survives with
    // a retained draft or disappears after one observation.
    await created.page.locator('#prompt-textarea').fill(request.prompt + '\n');
    assert.equal(await submission.captureAcknowledgement(), null);
    assert.equal(await recoverChatGptAcknowledgement(created.page, request.prompt, 'conversation-123456'), null);
    await created.page.locator('#prompt-textarea').fill('');
    await created.page.evaluate(() => setTimeout(() => document.querySelector('[data-message-id="user-message-1"]')?.remove(), 100));
    assert.equal(await submission.captureAcknowledgement(), null);
    assert.equal(await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount), 1);

    assert.equal(binding.conversationId, 'conversation-123456');

    await created.page.goto('https://chatgpt.com/c/another-conversation-999');
    assert.equal(registry.getBinding(created.binding.pageKey).state, 'identity_lost');
    assert.throws(
      () =>
        registry.requireSessionPage(created.binding.pageKey, {
          sessionId: 'session-exact',
          generation: 1,
          conversationId: 'conversation-123456',
        }),
      /does not have verifiable session ownership/,
    );

    await created.page.goto('https://chatgpt.com/c/conversation-123456');
    const restored = registry.getBinding(created.binding.pageKey);
    assert.equal(restored.state, 'owned');

    const duplicate = await owner.createPage();
    await duplicate.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>duplicate</main>' });
    });
    await duplicate.page.goto('https://chatgpt.com/c/conversation-123456');
    assert.ok(
      registry
        .findByConversation('conversation-123456')
        .every((candidate) => candidate.state === 'conflict'),
    );
    if (acknowledgement === null) {
      assert.fail('Expected an exact acknowledgement before duplicate-page validation');
    }
    assert.throws(
      () => submission.bindAcknowledgement(acknowledgement),
      (error: unknown) =>
        error instanceof PageRegistryError &&
        error.errorCode === 'session.page-identity-unverified',
    );

    const drifted = await owner.createPage();
    await drifted.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>drifted</main>' });
    });
    await drifted.page.goto('https://chatgpt.com/');
    registry.refreshPage(drifted.binding.pageKey);
    registry.reservePage(drifted.binding.pageKey, {
      sessionId: 'session-drifted',
      generation: 1,
      conversationId: null,
    });
    await drifted.page.goto('https://chatgpt.com/c/unexpected-conversation-123');
    assert.equal(registry.getBinding(drifted.binding.pageKey).state, 'identity_lost');
    assert.throws(
      () =>
        registry.requireSessionPage(drifted.binding.pageKey, {
          sessionId: 'session-drifted',
          generation: 1,
          conversationId: null,
        }),
      (error: unknown) =>
        error instanceof PageRegistryError &&
        error.errorCode === 'session.page-identity-unverified',
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission waits for a controlled composer to commit the filled prompt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-composer-commit-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    const prompt = 'Prompt committed after a controlled-editor render';
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, true, prompt, false, false, true),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-delayed-composer',
      generation: 1,
      conversationId: null,
    });

    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-delayed-composer',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt,
        model: null,
      },
      acknowledgementTimeoutMs: 500,
    });

    await created.page.locator('#prompt-textarea').waitFor({ state: 'visible' });
    await prepareFixture(submission, created.page);
    assert.equal(await created.page.locator('#prompt-textarea').textContent(), prompt);
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission preserves exact multiline text through ProseMirror block paragraphs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-prosemirror-lines-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    const prompt = [
      '[USER]',
      '## Question',
      'Return exactly MULTILINE_OK.',
      '',
      '[INSTRUCTIONS]',
      'Keep the logical line breaks exact.',
    ].join('\n');
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, false, prompt, false, false, false, true),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-prosemirror-lines',
      generation: 1,
      conversationId: null,
    });

    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-prosemirror-lines',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt,
        model: null,
      },
      acknowledgementTimeoutMs: 2_000,
    });

    await prepareFixture(submission, created.page);
    assert.equal(
      await created.page.locator('#prompt-textarea').evaluate((element) =>
        Array.from(element.children)
          .map((child) => child.textContent ?? '')
          .join('\n'),
      ),
      prompt,
    );

    await submission.submitOnce();
    assert.deepEqual(await submission.captureAcknowledgement(), {
      evidence: 'accepted-request-stable-anchor-cleared-composer',
      conversationId: 'conversation-123456',
      submittedUserMessageId: 'user-message-1',
      submittedUserTurnId: 'user-turn-1',
    });
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission accepts an already exact controlled composer value', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-composer-exact-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    const prompt = 'Already exact controlled composer value';
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, false, prompt, true),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-exact-composer',
      generation: 1,
      conversationId: null,
    });

    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-exact-composer',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt,
        model: null,
      },
      acknowledgementTimeoutMs: 500,
    });

    await prepareFixture(submission, created.page);
    assert.equal(await created.page.locator('#prompt-textarea').textContent(), prompt);
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission follows the visible composer across a DOM replacement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-composer-replace-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    const prompt = 'Prompt survives visible composer replacement';
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, false, '', false, true),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-replaced-composer',
      generation: 1,
      conversationId: null,
    });

    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-replaced-composer',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt,
        model: null,
      },
      acknowledgementTimeoutMs: 500,
    });

    await prepareFixture(submission, created.page);
    const visibleComposer = created.page
      .locator('#prompt-textarea')
      .filter({ visible: true })
      .first();
    assert.equal(await visibleComposer.textContent(), prompt);
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission classifies a proven logged-out auth session before model selection', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-auth-required-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      const auth = new URL(route.request().url()).pathname === '/api/auth/session';
      await route.fulfill({
        status: 200,
        contentType: auth ? 'application/json' : 'text/html',
        body: auth ? '{}' : chatGptFixture(false),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-auth-required',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-auth-required',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'This must not reach model selection or submit.',
        model: 'Pro',
      },
      acknowledgementTimeoutMs: 500,
    });

    await assert.rejects(
      submission.prepare(),
      (error: unknown) =>
        error instanceof ProviderSubmissionError &&
        error.errorCode === 'provider.authentication-required' &&
        error.promptSubmitted === false,
    );
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission extends acknowledgement while exact user identity hydrates', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-late-ack-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, false, '', false, false, false, false, null, 180),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-late-ack',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-late-ack',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Exact prompt whose user identity hydrates late',
        model: null,
      },
      acknowledgementTimeoutMs: 100,
    });

    await prepareFixture(submission, created.page);
    await submission.submitOnce();
    assert.deepEqual(await submission.captureAcknowledgement(), {
      evidence: 'accepted-request-stable-anchor-cleared-composer',
      conversationId: 'conversation-123456',
      submittedUserMessageId: 'user-message-1',
      submittedUserTurnId: 'user-turn-1',
    });
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      1,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});


function sessionSnapshot(overrides: {
  readonly sessionId: string;
  readonly pageKey: string;
}): SessionSnapshot {
  return {
    requestOk: true,
    teamId: '11111111-1111-4111-8111-111111111111',
    roleId: '22222222-2222-4222-8222-222222222222',
    roleKey: 'main',
    sessionId: overrides.sessionId,
    predecessorSessionId: null,
    provider: 'chatgpt',
    generation: 1,
    sessionState: 'submitting',
    providerState: 'pending',
    observationTransport: 'fresh',
    terminal: false,
    waitExpired: false,
    nextCheckAt: null,
    conversationId: null,
    pageKey: overrides.pageKey,
    submittedUserMessageId: null,
    submittedUserTurnId: null,
    responseMessageId: null,
    answerText: null,
    reason: null,
    errorCode: null,
    promptSubmitted: false,
  };
}

function chatGptFixture(
  disabledModel: boolean,
  applyModelSelection = true,
  delayedComposerCommit = false,
  initialComposerText = '',
  stickyComposerValue = false,
  replaceComposerOnInput = false,
  delayedComposerVisibility = false,
  proseMirrorBlocks = false,
  modelFixture: {
    readonly current: string;
    readonly options: readonly { readonly label: string; readonly disabled?: boolean }[];
  } | null = null,
  acknowledgementIdentityDelayMs = 0,
): string {
  const modelState = modelFixture ?? {
    current: 'Model A',
    options: [{ label: 'Model B', disabled: disabledModel }],
  };
  const modelOptionsMarkup = modelState.options
    .map(
      (option) =>
        `<button role="menuitem" type="button" aria-disabled="${option.disabled === true ? 'true' : 'false'}">${escapeHtml(option.label)}</button>`,
    )
    .join('');
  const initialComposerMarkup = proseMirrorBlocks
    ? initialComposerText
        .split('\n')
        .map((line) =>
          line === ''
            ? '<p data-empty-paragraph="true"><br class="ProseMirror-trailingBreak"></p>'
            : `<p>${escapeHtml(line)}</p>`,
        )
        .join('')
    : initialComposerText;
  return `<!doctype html>
    <html>
      <body>
        <button data-testid="model-switcher-dropdown-button" type="button">${escapeHtml(modelState.current)}</button>
        <div id="model-menu" role="menu" hidden>
          ${modelOptionsMarkup}
        </div>
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true">${initialComposerMarkup}</div>
        <button data-testid="send-button" type="button">Send</button>
        <section id="messages"></section>
        <script>
          window.sendCount = 0;
          const switcher = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
          const menu = document.querySelector('#model-menu');
          switcher.addEventListener('click', () => { menu.hidden = false; });
          for (const option of menu.querySelectorAll('[role="menuitem"]')) {
            option.addEventListener('click', () => {
              if (option.getAttribute('aria-disabled') === 'true') return;
              if (!${applyModelSelection}) return;
              switcher.textContent = option.textContent;
              menu.hidden = true;
            });
          }
          const composer = document.querySelector('#prompt-textarea');
          if (${delayedComposerVisibility}) {
            composer.setAttribute('hidden', '');
            setTimeout(() => composer.removeAttribute('hidden'), 150);
          }
          if (${delayedComposerCommit}) {
            composer.addEventListener('input', () => {
              const nextValue = composer.textContent;
              composer.textContent = '';
              setTimeout(() => { composer.textContent = nextValue; }, 150);
            });
          }
          if (${stickyComposerValue}) {
            const exactValue = ${JSON.stringify(initialComposerText)};
            composer.addEventListener('input', () => {
              composer.textContent = exactValue;
            });
          }
          if (${replaceComposerOnInput}) {
            let replaced = false;
            composer.addEventListener('input', () => {
              if (replaced || composer.textContent === '') return;
              replaced = true;
              const replacement = composer.cloneNode(false);
              replacement.textContent = composer.textContent;
              composer.textContent = '';
              composer.setAttribute('hidden', '');
              composer.after(replacement);
            });
          }
          if (${proseMirrorBlocks}) {
            composer.addEventListener('input', () => {
              const value = composer.innerText;
              const blocks = value.split('\\n').map((line) => {
                const paragraph = document.createElement('p');
                if (line === '') {
                  paragraph.appendChild(document.createElement('br'));
                } else {
                  paragraph.textContent = line;
                }
                return paragraph;
              });
              composer.replaceChildren(...blocks);
            });
          }
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            window.sendCount += 1;
            const prompt = ${proseMirrorBlocks}
              ? Array.from(composer.children).map((child) => child.textContent ?? '').join('\\n')
              : composer.textContent;
            void fetch('/backend-api/conversation', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({messages:[{id:'user-message-1',author:{role:'user'}}]})});
            composer.textContent = '';
            history.pushState({}, '', '/c/conversation-123456');
            const message = document.createElement('article');
            message.setAttribute('data-message-author-role', 'user');
            const hydrateIdentity = () => {
              message.setAttribute('data-message-id', 'user-message-1');
              message.setAttribute('data-turn-id', 'user-turn-1');
            };
            if (${acknowledgementIdentityDelayMs} > 0) {
              setTimeout(hydrateIdentity, ${acknowledgementIdentityDelayMs});
            } else {
              hydrateIdentity();
            }
            if (${proseMirrorBlocks}) {
              const content = document.createElement('div');
              content.setAttribute('data-testid', 'collapsible-user-message-content');
              const body = document.createElement('div');
              body.className = 'whitespace-pre-wrap';
              body.textContent = prompt;
              content.appendChild(body);
              const toggle = document.createElement('button');
              toggle.textContent = 'Show moreShow less';
              message.append(content, toggle);
            } else {
              message.textContent = prompt;
            }
            document.querySelector('#messages').appendChild(message);
          });
        </script>
      </body>
    </html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
