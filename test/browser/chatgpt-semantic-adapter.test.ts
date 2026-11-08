import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import type { OwnedPageIdentity } from '../../src/browser/owned-page-lifecycle.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../../src/providers/chatgpt/backend-recovery.ts';
import { ChatGptSemanticAdapter } from '../../src/providers/chatgpt/semantic-adapter.ts';
import type { SemanticTaskContext } from '../../src/providers/semantic-adapter.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function context(lease: OwnedPageIdentity | null, userMessageId: string | null = null): SemanticTaskContext {
  return {
    projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
    providerConversationId: 'conversation-b',
    submittedUserMessageId: userMessageId, submittedUserTurnId: userMessageId ? 'turn-b' : null,
    pageLease: lease,
  };
}
const NORMAL = '<main><div id="prompt-textarea" contenteditable="true" role="textbox"></div>' +
  '<button type="button" data-testid="send-button" onclick="window.sends++;' +
  'document.querySelector(\'#prompt-textarea\').textContent=\'\';">Send</button>' +
  '<article data-message-author-role="user">Quoted instructions: <button aria-label="Send" ' +
  'onclick="window.foreignClicks++">Send</button></article></main>' +
  '<script>window.sends=0;window.foreignClicks=0;</script>';
const DRIFT = '<main><section data-chatgpt-composer><form id="new-layout">' +
  '<div role="textbox" contenteditable="true" aria-label="Your message"></div>' +
  '<div><span>Updated DOM</span><button type="submit">Post it</button></div></form></section>' +
  '</main><script>window.sends=0;' +
  'document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.sends++;' +
  'document.querySelector("[role=textbox]").textContent="";});</script>';

test('ChatGPT semantic observe/act uses exact draft and one-shot send across structural/testid drift', {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-b-semantic-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'), pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const created = await owner.createPage();
    const page = created.page;
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: NORMAL,
    }));
    await page.goto('https://chatgpt.com/c/conversation-b');
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'fixture-b', generation: 1, conversationId: 'conversation-b',
    });
    const binding = registry.getBinding(created.binding.pageKey);
    const lease: OwnedPageIdentity = {
      projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
      pageKey: binding.pageKey, targetId: binding.targetId!, bindingEpoch: binding.bindingEpoch,
    };
    let allowedLease: OwnedPageIdentity | null = lease;
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: value => allowedLease === value &&
        registry.getBinding(value.pageKey).bindingEpoch === value.bindingEpoch &&
        registry.getBinding(value.pageKey).targetId === value.targetId,
      resolvePage: value => registry.pageForObservation(value.pageKey, value.bindingEpoch),
      isAuthorizedAttempt: input => input.attemptId.startsWith('journaled-attempt-'),
    });
    const task = context(lease);
    let foregroundCalls = 0;
    Object.defineProperty(page, 'bringToFront', {
      configurable: true, value: async () => { foregroundCalls++; throw new Error('Human focus forbidden'); },
    });
    for (const [label, html] of [
      ['known testids', NORMAL], ['renamed testid and wrapped editor / semantic form submit', DRIFT],
    ] as const) {
      await page.setContent(html);
      const first = await adapter.observe(task);
      assert.equal(first.surface, 'chat', label);
      assert.equal(first.blocker, 'none', label);
      assert.ok(first.evidenceBytes < 12 * 1024);
      assert.equal(JSON.stringify(first).includes('onclick'), false, 'raw page HTML must not escape');
      assert.equal(first.actions.some(a => a.purpose === 'submit'), false);
      const compose = first.actions.find(a => a.purpose === 'compose')!;
      assert.ok(compose && compose.input.kind === 'text');
      const phrase = 'Exact ' + label;
      const filled = await adapter.act({
        context: task, snapshotId: first.snapshotId, actionRef: compose.actionRef,
        evidenceHash: compose.evidenceHash, input: phrase,
      });
      assert.deepEqual(filled, { kind: 'performed', effect: 'draft_updated' }, label);
      assert.equal((await adapter.act({
        context: task, snapshotId: first.snapshotId, actionRef: compose.actionRef,
        evidenceHash: compose.evidenceHash, input: 'duplicate',
      })).kind, 'stale', 'a used ref cannot replay');
      const second = await adapter.observe(task);
      const submit = second.actions.find(a => a.purpose === 'submit')!;
      assert.ok(submit, 'semantic send control survives DOM structural drift');
      assert.equal((await adapter.act({
        context: task, snapshotId: second.snapshotId, actionRef: submit.actionRef,
        evidenceHash: submit.evidenceHash,
      })).kind, 'authorization_required');
      assert.equal(await page.evaluate(() => (window as any).sends), 0);
      const dispatched = await adapter.act({
        context: task, snapshotId: second.snapshotId, actionRef: submit.actionRef,
        evidenceHash: submit.evidenceHash, authorizedAttemptId: 'journaled-attempt-' + label,
        expectedContentSha256: digest(phrase),
      });
      assert.deepEqual(dispatched, { kind: 'dispatched_unverified', effect: 'send',
        attempts: [] }, 'a click without an observed POST is not canonical ACK evidence');
      assert.equal(await page.evaluate(() => (window as any).sends), 1);
      assert.equal((await adapter.act({
        context: task, snapshotId: second.snapshotId, actionRef: submit.actionRef,
        evidenceHash: submit.evidenceHash, authorizedAttemptId: 'another-id',
        expectedContentSha256: digest(phrase),
      })).kind, 'stale');
      assert.equal(await page.evaluate(() => (window as any).sends), 1,
        'even a new request ID cannot replay the same actionRef');
      assert.equal(foregroundCalls, 0);
      if (label === 'known testids')
        assert.equal(await page.evaluate(() => (window as any).foreignClicks), 0,
          'message-body buttons are not executable chat send controls');
    }

    // Never overwrite a retained human draft just because the editor is
    // technically editable. Its submitted hash must instead match a journal.
    await page.setContent('<main><div id="prompt-textarea" role="textbox" ' +
      'contenteditable="true">Retained human draft</div>' +
      '<button data-testid="send-button">Send</button></main>');
    const retained = await adapter.observe(task);
    assert.equal(retained.actions.some(a => a.purpose === 'compose'), false);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'Retained human draft');

    // Capture a real request emitted from this exact Page. A cleared composer
    // or clicked button alone never supplies canonical ACK identity.
    await page.setContent('<main><div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
      '<button data-testid="send-button" type="button">Send</button></main>' +
      '<script>window.sends=0;document.querySelector("button").onclick=()=>{' +
      'const editor=document.querySelector("#prompt-textarea");const text=editor.innerText;window.sends++;' +
      'fetch("/backend-api/f/conversation",{method:"POST",headers:{"Content-Type":"application/json"},' +
      'body:JSON.stringify({action:"next",conversation_id:"conversation-b",parent_message_id:"parent-b",' +
      'messages:[{id:"user-b",author:{role:"user"},content:{content_type:"text",parts:[text]}}]})});' +
      'editor.textContent="";};</script>');
    const networkDraft = 'Exact submitted POST provenance';
    const prior = await adapter.observe(task);
    const draft = prior.actions.find(a => a.purpose === 'compose')!;
    assert.equal((await adapter.act({ context: task, snapshotId: prior.snapshotId,
      actionRef: draft.actionRef, evidenceHash: draft.evidenceHash,
      input: networkDraft })).kind, 'performed');
    const ready = await adapter.observe(task);
    const send = ready.actions.find(a => a.purpose === 'submit')!;
    const networkResult = await adapter.act({ context: task, snapshotId: ready.snapshotId,
      actionRef: send.actionRef, evidenceHash: send.evidenceHash,
      authorizedAttemptId: 'journaled-attempt-network', expectedContentSha256: digest(networkDraft) });
    assert.equal(networkResult.kind, 'dispatched_unverified');
    if (networkResult.kind !== 'dispatched_unverified') throw new Error('Send was not dispatched');
    assert.deepEqual(networkResult.attempts.map(a =>
      [a.conversationId, a.messageId, a.parentMessageId, a.textHash]),
      [['conversation-b', 'user-b', 'parent-b', digest(networkDraft)]],
      'only the exact outgoing POST can carry dispatch provenance');
    assert.equal(await page.evaluate(() => (window as any).sends), 1);

    await page.setContent('<main><div data-chatgpt-composer>' +
      '<div role="textbox" contenteditable="true"></div>' +
      '<textarea></textarea><button aria-label="Send message">Send</button>' +
      '</div></main>');
    const ambiguous = await adapter.observe(task);
    assert.equal(ambiguous.blocker, 'unsupported');
    assert.match(ambiguous.reason ?? '', /composer-ambiguous/);
    assert.equal(ambiguous.actions.length, 0);

    await page.setContent(NORMAL);
    const stale = await adapter.observe(task);
    const compose = stale.actions.find(a => a.purpose === 'compose')!;
    await page.evaluate(() => document.querySelector('#prompt-textarea')!.setAttribute(
      'aria-label', 'Updated label after observation'));
    const staleResult = await adapter.act({
      context: task, snapshotId: stale.snapshotId,
      actionRef: compose.actionRef, evidenceHash: compose.evidenceHash, input: 'must not fill',
    });
    assert.equal(staleResult.kind, 'stale', 'changed evidence before dispatch is a fresh decision, not uncertain mutation');
    assert.equal(await page.locator('#prompt-textarea').innerText(), '');

    await page.setContent('<main><div role="radiogroup">' +
      '<button role="radio" aria-checked="false">Chat</button>' +
      '<button role="radio" aria-checked="true">Work</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button aria-label="Send">Send</button></main>');
    const work = await adapter.observe(task);
    assert.equal(work.surface, 'work');
    assert.equal(work.blocker, 'unsupported');
    assert.equal(work.actions.length, 0);

    allowedLease = null;
    await assert.rejects(adapter.observe(task), /Stale exact Task/);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT provider question offers enabled typed choices and runs once after exact evidence check', {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-b-question-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'), pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<main><div id="prompt-textarea" contenteditable="true"></div>' +
        '<div data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
        '<h3>Choose an implementation</h3><div role="radiogroup">' +
        '<button type="button" role="radio" aria-label="Keep existing" ' +
        'onclick="window.choice=\'existing\';this.closest(\'[data-codex-composer-request-navigation]\').remove()">Existing</button>' +
        '<button type="button" role="radio" aria-label="Replace" disabled>Replace</button>' +
        '</div></div></main><script>window.choice=null;</script>',
    }));
    await page.goto('https://chatgpt.com/c/conversation-b');
    const current = registry.getBinding(binding.pageKey);
    const lease: OwnedPageIdentity = {
      projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
      pageKey: current.pageKey, targetId: current.targetId!, bindingEpoch: current.bindingEpoch,
    };
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => page,
      isAuthorizedAttempt: input => input.attemptId === 'decision-once',
    });
    const task = context(lease);
    const observed = await adapter.observe(task);
    assert.equal(observed.blocker, 'provider_question');
    assert.match(observed.questionText ?? '', /Choose an implementation/);
    assert.equal(observed.actions.length, 1);
    const action = observed.actions[0]!;
    assert.equal(action.purpose, 'answer_question');
    assert.equal(action.input.kind, 'option');
    if (action.input.kind !== 'option') throw new Error('Expected option schema');
    assert.deepEqual(action.input.options.map(o => [o.value, o.enabled]),
      [['Keep existing', true], ['Replace', false]]);
    const denied = await adapter.act({ context: task, snapshotId: observed.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      input: 'Keep existing' });
    assert.equal(denied.kind, 'authorization_required');
    const applied = await adapter.act({ context: task, snapshotId: observed.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      input: 'Keep existing', authorizedAttemptId: 'decision-once' });
    assert.deepEqual(applied, { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).choice), 'existing');
    assert.equal((await adapter.act({ context: task, snapshotId: observed.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      input: 'Keep existing', authorizedAttemptId: 'decision-twice' })).kind, 'stale');
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical ACK and FINAL recovery works read-only without a page or foreground activation', async () => {
  const cid = 'conversation-b', prompt = 'Exact question', userId = 'user-b', userTurn = 'turn-b';
  const user = { id: userId, turn_id: userTurn, author: { role: 'user' }, content: { parts: [prompt] } };
  const answer = { id: 'assistant-b', author: { role: 'assistant' }, channel: 'final',
    status: 'finished_successfully', end_turn: true, content: { parts: ['Exact answer'] }, metadata: {} };
  const payload = { id: cid, current_node: 'assistant-node', mapping: {
    root: { id: 'root', parent: null, children: [], message: null },
    'user-node': { id: 'user-node', parent: 'root', children: [], message: user },
    'assistant-node': { id: 'assistant-node', parent: 'user-node', children: [], message: answer },
  } };
  let reads = 0;
  const client: BackendJsonClient = { async get(url) {
    reads++;
    return { status: 200, headers: {},
      body: url.endsWith('/api/auth/session') ? { accessToken: 'fixture-memory-token' } : payload };
  } };
  const options = {
    isExactLease: (_: OwnedPageIdentity) => false,
    resolvePage: () => { throw new Error('No browser page exists'); },
    backendClient: client,
    backendOrigin: 'https://chatgpt.com',
  };
  const readOnly = new ChatGptSemanticAdapter(options);
  const exact = { ...context(null, userId), submittedUserTurnId: userTurn };
  const result = await readOnly.recover({ context: exact, kind: 'final' });
  assert.deepEqual(result, { kind: 'exact_final', externalTurnId: userTurn,
    answerText: 'Exact answer' });
  assert.equal(reads, 2, 'authenticated read-only GETs only');
  const ackReader = new ChatGptSemanticAdapter({ ...options,
    backendRecovery: new ChatGptBackendRecovery({ requestTimeoutMs: 500,
      tokenCacheTtlMs: 10_000 }) });
  const ack = await ackReader.verify({ context: exact, kind: 'ack', prompt,
    attempts: [{ conversationId: cid, messageId: userId, parentMessageId: 'root',
      textHash: digest(prompt), observedAt: new Date(0).toISOString() }] });
  assert.deepEqual(ack, { kind: 'verified_ack', externalTurnId: userTurn, messageId: userId });
  const invalid = await ackReader.verify({ context: exact, kind: 'ack', prompt });
  assert.equal(invalid.kind, 'unavailable', 'no attempt correlation cannot prove acceptance');
  assert.equal(reads, 4);
});
