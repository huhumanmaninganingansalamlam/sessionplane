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
import { inspectChatGptQuestion, answerChatGptQuestion } from '../../src/providers/chatgpt/question.ts';
import { inspectChatGptFreeTextQuestion, answerChatGptFreeTextQuestion } from '../../src/providers/chatgpt/semantic-free-text-question.ts';
import { ChatGptSemanticAdapter } from '../../src/providers/chatgpt/semantic-adapter.ts';
import { inspectSemanticHostSpanPermission } from '../../src/providers/chatgpt/semantic-hostspan-permission.ts';
import { inspectSemanticChatGptModelMenu, openExactChatGptModelMenu, selectExactChatGptModelMenu } from '../../src/providers/chatgpt/semantic-model-menu.ts';
import { observeChatGptDom } from '../../src/providers/chatgpt/dom-observer.ts';
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
    const durablePostObservations: string[] = [];
    const adapter = new ChatGptSemanticAdapter({
      onDispatchObserved: value => durablePostObservations.push(value.attemptId + ':' + value.evidence.messageId),
      isExactLease: value => allowedLease === value &&
        registry.getBinding(value.pageKey).bindingEpoch === value.bindingEpoch &&
        registry.getBinding(value.pageKey).targetId === value.targetId,
      resolvePage: value => registry.pageForObservation(value.pageKey, value.bindingEpoch),
      isAuthorizedAttempt: input => input.attemptId.startsWith('journaled-attempt-'),
      isAuthorizedDecision: input => input.decisionId === 'decision-model',
    });
    const task = context(lease);
    let foregroundCalls = 0;
    Object.defineProperty(page, 'bringToFront', {
      configurable: true, value: async () => { foregroundCalls++; throw new Error('Human focus forbidden'); },
    });
    // E17: a mounted assistant message is not evidence that the stored
    // canonical FINAL has the same text or response message identity.
    await page.setContent('<main><div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button>' +
      '<article data-message-author-role="user" data-message-id="user-b" data-turn-id="turn-b">Exact question</article>' +
      '<article data-message-author-role="assistant" data-message-id="mounted-other" data-end-turn="true">' +
      '<div class="markdown">Different mounted text</div></article></main>');
    let canonicalReads = 0;
    const canonicalClient: BackendJsonClient = { async get(url) {
      canonicalReads++;
      if (url.endsWith('/api/auth/session')) return {
        status: 200, headers: {}, body: { accessToken: 'fixture-only' },
      };
      return { status: 200, headers: {}, body: {
        id: 'conversation-b', current_node: 'assistant-node', mapping: {
          root: { id: 'root', parent: null, children: [], message: null },
          'user-node': { id: 'user-node', parent: 'root', children: [], message: {
            id: 'user-b', turn_id: 'turn-b', author: { role: 'user' },
            content: { parts: ['Exact question'] },
          } },
          'assistant-node': { id: 'assistant-node', parent: 'user-node', children: [], message: {
            id: 'backend-answer', author: { role: 'assistant' }, channel: 'final',
            status: 'finished_successfully', end_turn: true,
            content: { parts: ['Canonical FINAL text'] }, metadata: {},
          } },
        },
      } };
    } };
    const independent = new ChatGptSemanticAdapter({
      isExactLease: value => allowedLease === value,
      resolvePage: value => registry.pageForObservation(value.pageKey, value.bindingEpoch),
      backendClient: canonicalClient, backendOrigin: 'https://chatgpt.com',
    });
    const bound = context(lease, 'user-b');
    const mounted = await independent.observe(bound);
    assert.equal(mounted.turn.answerMessageId, 'mounted-other');
    assert.equal(mounted.turn.partialAnswer, 'Different mounted text');
    assert.deepEqual(await independent.recover({ context: bound, kind: 'final' }),
      { kind: 'exact_final', externalTurnId: 'turn-b', answerText: 'Canonical FINAL text' });
    assert.equal(canonicalReads, 2, 'mounted observation cannot substitute for authenticated FINAL');
    assert.equal(foregroundCalls, 0);
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

    // A generic dialog may contain its own Send-labelled control. It is not
    // the chat composer submit target and must never become a semantic send.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true">Protected draft</div>' +
      '<div role="dialog"><p>Share this item?</p><button aria-label="Send" onclick="window.dialogSends++">Send</button></div></main>' +
      '<script>window.dialogSends=0;</script>');
    const foreignDialog = await adapter.observe(task);
    assert.equal(foreignDialog.actions.some(action => action.purpose === 'submit'), false,
      'dialog-local Send control cannot stand in for the composer submit control');
    assert.equal(await page.evaluate(() => (window as any).dialogSends), 0);

    await page.setContent('<main><section data-chatgpt-composer>' +
      '<div id="prompt-textarea" contenteditable="true">Protected draft</div></section>' +
      '<section><button aria-label="Send" onclick="window.foreignSends++">Send</button></section></main>' +
      '<script>window.foreignSends=0;</script>');
    const foreignSibling = await adapter.observe(task);
    assert.equal(foreignSibling.actions.some(action => action.purpose === 'submit'), false,
      'an unrelated main control cannot become a send candidate from its label alone');
    assert.equal(await page.evaluate(() => (window as any).foreignSends), 0);

    await page.setContent('<main><section data-chatgpt-composer>' +
      '<div id="prompt-textarea" contenteditable="true">Protected draft</div></section>' +
      '<section><button data-testid="send-button" onclick="window.foreignKnownSends++">Send</button></section></main>' +
      '<script>window.foreignKnownSends=0;</script>');
    const foreignKnown = await adapter.observe(task);
    assert.equal(foreignKnown.actions.some(action => action.purpose === 'submit'), false,
      'a send-button testid outside a known composer cannot authorize a foreign action');
    assert.equal(await page.evaluate(() => (window as any).foreignKnownSends), 0);

    await page.setContent('<main><section data-chatgpt-composer><div id="prompt-textarea" contenteditable="true">Composer draft</div>' +
      '<button aria-label="Send message">Send</button></section></main>');
    assert.equal((await adapter.observe(task)).actions.some(action => action.purpose === 'submit'), true,
      'a unique labelled fallback remains valid inside the exact composer region');

    // Async authorization can overlap on the same ref; only one click is allowed.
    // Preserve the draft after click to expose a second unintended dispatch.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true">Committed draft</div>' +
      '<button data-testid="send-button" onclick="window.sends++">Send</button></main>' +
      '<script>window.sends=0;</script>');
    let releaseSlow!: () => void;
    const slowAuthorization = new Promise<void>(resolve => { releaseSlow = resolve; });
    let signalSlowEntered!: () => void;
    const slowEntered = new Promise<void>(resolve => { signalSlowEntered = resolve; });
    const overlapping = new ChatGptSemanticAdapter({
      isExactLease: value => allowedLease === value,
      resolvePage: value => registry.pageForObservation(value.pageKey, value.bindingEpoch),
      isAuthorizedAttempt: async ({ attemptId }) => {
        if (attemptId === 'journaled-attempt-slow') {
          signalSlowEntered();
          await slowAuthorization;
        }
        return true;
      },
    });
    const overlapView = await overlapping.observe(task);
    const overlapSend = overlapView.actions.find(a => a.purpose === 'submit')!;
    assert.ok(overlapSend);
    const sameRef = {
      context: task, snapshotId: overlapView.snapshotId, actionRef: overlapSend.actionRef,
      evidenceHash: overlapSend.evidenceHash, expectedContentSha256: digest('Committed draft'),
    };
    const delayed = overlapping.act({ ...sameRef, authorizedAttemptId: 'journaled-attempt-slow' });
    await slowEntered;
    let immediate;
    try {
      immediate = await overlapping.act({ ...sameRef, authorizedAttemptId: 'journaled-attempt-fast' });
    } finally { releaseSlow(); }
    assert.equal(immediate.kind, 'dispatched_unverified');
    assert.equal((await delayed).kind, 'stale',
      'a ref consumed while authorization was pending cannot dispatch again');
    assert.equal(await page.evaluate(() => (window as any).sends), 1,
      'an overlapping authorized action must not click Send twice');

    // A delayed observation cannot publish a new send ref after another
    // authorized action has consumed the snapshot it began under.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true">Retained race draft</div>' +
      '<button data-testid="send-button" onclick="window.sends++">Send</button></main>' +
      '<script>window.sends=0;</script>');
    let holdResolution = false;
    let releaseResolution!: () => void;
    const resolution = new Promise<void>(resolve => { releaseResolution = resolve; });
    let signalHeld!: () => void;
    const held = new Promise<void>(resolve => { signalHeld = resolve; });
    const racing = new ChatGptSemanticAdapter({
      isExactLease: value => allowedLease === value,
      resolvePage: async value => {
        if (holdResolution) {
          holdResolution = false;
          signalHeld();
          await resolution;
        }
        return registry.pageForObservation(value.pageKey, value.bindingEpoch);
      },
      isAuthorizedAttempt: () => true,
    });
    const beforeRace = await racing.observe(task);
    const raceSend = beforeRace.actions.find(action => action.purpose === 'submit')!;
    assert.ok(raceSend);
    holdResolution = true;
    const pendingObservation = racing.observe(task);
    await held;
    let racedSend;
    try {
      racedSend = await racing.act({
        context: task, snapshotId: beforeRace.snapshotId,
        actionRef: raceSend.actionRef, evidenceHash: raceSend.evidenceHash,
        authorizedAttemptId: 'journaled-racing-send',
        expectedContentSha256: digest('Retained race draft'),
      });
    } finally { releaseResolution(); }
    assert.equal(racedSend.kind, 'dispatched_unverified');
    const afterRace = await pendingObservation;
    assert.equal(afterRace.blocker, 'unsupported', 'the pre-send observation was superseded');
    assert.equal(afterRace.actions.length, 0);
    assert.equal(await page.evaluate(() => (window as any).sends), 1);

    // Losing the exact lease while the second durable authorization check is
    // pending must stop the side effect, not merely report uncertainty after
    // clicking a page now owned by someone else.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true">Committed lease draft</div>' +
      '<button data-testid="send-button" onclick="window.sends++">Send</button></main>' +
      '<script>window.sends=0;</script>');
    let authorizationChecks = 0;
    let signalMutationAuthorization!: () => void;
    const mutationAuthorizationEntered = new Promise<void>(resolve => {
      signalMutationAuthorization = resolve;
    });
    let releaseMutationAuthorization!: () => void;
    const mutationAuthorization = new Promise<void>(resolve => {
      releaseMutationAuthorization = resolve;
    });
    const revokedDuringAuthorization = new ChatGptSemanticAdapter({
      isExactLease: value => allowedLease === value,
      resolvePage: value => registry.pageForObservation(value.pageKey, value.bindingEpoch),
      isAuthorizedAttempt: async () => {
        authorizationChecks++;
        if (authorizationChecks === 2) {
          signalMutationAuthorization();
          await mutationAuthorization;
        }
        return true;
      },
    });
    const leaseView = await revokedDuringAuthorization.observe(task);
    const leaseSend = leaseView.actions.find(action => action.purpose === 'submit')!;
    assert.ok(leaseSend);
    const pendingLeaseAction = revokedDuringAuthorization.act({
      context: task, snapshotId: leaseView.snapshotId,
      actionRef: leaseSend.actionRef, evidenceHash: leaseSend.evidenceHash,
      authorizedAttemptId: 'journaled-attempt-revoked-lease',
      expectedContentSha256: digest('Committed lease draft'),
    });
    await mutationAuthorizationEntered;
    allowedLease = null;
    releaseMutationAuthorization();
    const revokedAction = await pendingLeaseAction;
    allowedLease = lease;
    assert.equal(revokedAction.kind, 'uncertain');
    assert.equal(await page.evaluate(() => (window as any).sends), 0,
      'revoked ownership must prevent the pending Send click');

    // A later human user turn invalidates the original continuation, even if
    // the composer retains the exact text and the journal check was authorized.
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Original</div>' +
      '<div id="prompt-textarea" contenteditable="true">계속</div>' +
      '<button data-testid="send-button" onclick="window.sends++">Send</button></main>' +
      '<script>window.sends=0;</script>');
    let continueChecks = 0;
    let signalContinueAuthorization!: () => void;
    const continueAuthorizationEntered = new Promise<void>(resolve => {
      signalContinueAuthorization = resolve;
    });
    let releaseContinueAuthorization!: () => void;
    const continueAuthorization = new Promise<void>(resolve => {
      releaseContinueAuthorization = resolve;
    });
    const continueAdapter = new ChatGptSemanticAdapter({
      isExactLease: value => allowedLease === value,
      resolvePage: value => registry.pageForObservation(value.pageKey, value.bindingEpoch),
      isAuthorizedAttempt: async () => {
        if (++continueChecks === 2) {
          signalContinueAuthorization();
          await continueAuthorization;
        }
        return true;
      },
    });
    const continuedTask = context(lease, 'user-b');
    const continuation = await continueAdapter.observe(continuedTask);
    const continueAction = continuation.actions.find(a => a.purpose === 'continue')!;
    assert.ok(continueAction, 'the exact continuation is available before the human follow-up');
    const staleContinue = continueAdapter.act({
      context: continuedTask, snapshotId: continuation.snapshotId,
      actionRef: continueAction.actionRef, evidenceHash: continueAction.evidenceHash,
      authorizedAttemptId: 'journaled-later-user-continue',
      expectedContentSha256: digest('계속'),
    });
    await continueAuthorizationEntered;
    await page.locator('#prompt-textarea').evaluate(editor => {
      const later = document.createElement('div');
      later.setAttribute('data-message-author-role', 'user');
      later.setAttribute('data-message-id', 'later-user');
      later.textContent = 'A newer user request';
      editor.before(later);
    });
    releaseContinueAuthorization();
    const continueOutcome = await staleContinue;
    assert.notEqual(continueOutcome.kind, 'dispatched_unverified',
      'a continuation for a displaced original turn must not dispatch');
    assert.equal(await page.evaluate(() => (window as any).sends), 0,
      'a newer user turn must prevent an already authorized Continue click');

    // The real Chat editor renders an empty ProseMirror paragraph as innerText '\n'.
    // It is a structural placeholder, not a human-written draft.
    await page.setContent('<main><section data-chatgpt-composer><div class="ProseMirror" role="textbox" contenteditable="true">' +
      '<p class="placeholder before:composer-placeholder"><br class="ProseMirror-trailingBreak"></p></div>' +
      '<button data-testid="send-button">Send</button></section></main>');
    assert.equal(await page.locator('.ProseMirror').innerText(), '\n');
    assert.equal(await page.locator('.ProseMirror').textContent(), '');
    const placeholder = await adapter.observe(task);
    assert.equal(placeholder.blocker, 'none');
    const placeholderCompose = placeholder.actions.find(action => action.purpose === 'compose')!;
    assert.ok(placeholderCompose, 'structurally empty ProseMirror must allow composing');
    assert.equal((await adapter.act({ context: task, snapshotId: placeholder.snapshotId,
      actionRef: placeholderCompose.actionRef, evidenceHash: placeholderCompose.evidenceHash,
      input: 'Exact blank editor' })).kind, 'performed');
    assert.equal(await page.locator('.ProseMirror').innerText(), 'Exact blank editor');
    await page.setContent('<main><section data-chatgpt-composer><div class="ProseMirror" role="textbox" contenteditable="true">' +
      '<p> </p></div><button data-testid="send-button">Send</button></section></main>');
    const humanWhitespace = await adapter.observe(task);
    assert.equal(humanWhitespace.actions.some(action => action.purpose === 'compose'), false,
      'a literal human space remains a protected draft');

    // An unsubmitted Task has no canonical user ID yet. A later human turn
    // must still invalidate its previously observed composer action.
    await page.setContent('<main><article data-message-author-role="user" ' +
      'data-message-id="history-user">Existing conversation</article>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>');
    const unboundBefore = await adapter.observe(task);
    const unboundNewUserCompose = unboundBefore.actions.find(a => a.purpose === 'compose')!;
    assert.ok(unboundNewUserCompose);
    await page.locator('#prompt-textarea').evaluate(editor => {
      const newer = document.createElement('article');
      newer.setAttribute('data-message-author-role', 'user');
      newer.setAttribute('data-message-id', 'human-new-turn');
      newer.textContent = 'Human follow-up before the old Task drafts';
      editor.before(newer);
    });
    const unboundAfter = await adapter.act({
      context: task, snapshotId: unboundBefore.snapshotId,
      actionRef: unboundNewUserCompose.actionRef, evidenceHash: unboundNewUserCompose.evidenceHash,
      input: 'Must not draft on a human-advanced conversation',
    });
    assert.notEqual(unboundAfter.kind, 'performed');
    assert.equal(await page.locator('#prompt-textarea').innerText(), '');


    // New user input after the final UI capture but before the draft fill
    // invalidates the old exact turn without changing the composer fingerprint.
    await page.setContent('<main><article data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">Original task</article>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>');
    let advanceOnCapture = false;
    const racedPage = new Proxy(page, { get(target, prop) {
      if (prop === 'evaluate') return async (fn: unknown, arg: unknown) => {
        const value = await page.evaluate(fn as never, arg as never);
        if (advanceOnCapture && typeof fn === 'function' &&
          fn.toString().includes('editorsSelector')) {
          advanceOnCapture = false;
          await page.locator('#prompt-textarea').evaluate(editor => {
            const later = document.createElement('article');
            later.setAttribute('data-message-author-role', 'user');
            later.setAttribute('data-message-id', 'later-user');
            later.textContent = 'New human turn before draft fill';
            editor.before(later);
          });
        }
        return value;
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const draftRaceAdapter = new ChatGptSemanticAdapter({
      isExactLease: candidate => allowedLease === candidate,
      resolvePage: () => racedPage,
    });
    const originalTurn = context(lease, 'user-b');
    const beforeAdvance = await draftRaceAdapter.observe(originalTurn);
    const raceCompose = beforeAdvance.actions.find(a => a.purpose === 'compose')!;
    assert.ok(raceCompose);
    advanceOnCapture = true;
    const raceOutcome = await draftRaceAdapter.act({
      context: originalTurn, snapshotId: beforeAdvance.snapshotId,
      actionRef: raceCompose.actionRef, evidenceHash: raceCompose.evidenceHash,
      input: 'Must not draft after human follow-up',
    });
    assert.notEqual(raceOutcome.kind, 'performed',
      'late human follow-up must revoke the old task before filling');
    assert.equal(await page.locator('#prompt-textarea').innerText(), '',
      'a displaced task cannot edit the live chat composer');

    await page.setContent('<main><section data-chatgpt-composer><div class="ProseMirror" role="textbox" contenteditable="true">' +
      '<p> </p></div><button data-testid="send-button">Send</button></section></main>');

    // If a person types after observation, the stale compose ref must not erase it.
    await page.locator('.ProseMirror').evaluate(element => {
      element.innerHTML = '<p class="placeholder"><br class="ProseMirror-trailingBreak"></p>';
    });
    const beforeTyping = await adapter.observe(task);
    const pendingCompose = beforeTyping.actions.find(action => action.purpose === 'compose')!;
    assert.ok(pendingCompose);
    await page.locator('.ProseMirror').evaluate(element => { element.innerHTML = '<p> </p>'; });
    assert.equal((await adapter.act({ context: task, snapshotId: beforeTyping.snapshotId,
      actionRef: pendingCompose.actionRef, evidenceHash: pendingCompose.evidenceHash,
      input: 'Must not replace a human draft' })).kind, 'stale');
    assert.equal(await page.locator('.ProseMirror').textContent(), ' ');

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
    assert.deepEqual(durablePostObservations, ['journaled-attempt-network:user-b'],
      'the exact outgoing POST invokes its durable journal hook before returning');

    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div role="dialog"><button id="foreign-model" aria-label="Model" aria-haspopup="menu" ' +
      'aria-controls="foreign-model-menu" aria-expanded="false">Details</button>' +
      '<div role="menu" id="foreign-model-menu" hidden>' +
      '<button role="menuitemradio" aria-checked="true">One</button>' +
      '<button role="menuitemradio" aria-checked="false">Two</button></div></div></main>');
    const foreignModel = await adapter.observe(task);
    assert.equal(foreignModel.actions.some(action => action.purpose === 'open_model_chooser'), false,
      'dialog-local model menu cannot become the chat configuration chooser');

    await page.setContent('<button id="external-model" aria-label="Model" aria-haspopup="menu" ' +
      'aria-controls="external-model-menu" aria-expanded="false">Details</button>' +
      '<div role="menu" id="external-model-menu" hidden>' +
      '<button role="menuitemradio" aria-checked="true">One</button>' +
      '<button role="menuitemradio" aria-checked="false">Two</button></div>' +
      '<main><div id="prompt-textarea" contenteditable="true"></div></main>');
    const externalModel = await adapter.observe(task);
    assert.equal(externalModel.actions.some(action => action.purpose === 'open_model_chooser'), false,
      'model menu outside the chat main cannot become the composer configuration chooser');

    // Model choice is a separate, explicit two-step configuration decision.
    // Observe itself must not open the popup or change the current selection.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<button id="model-trigger" aria-label="Model" aria-haspopup="menu" ' +
      'aria-controls="model-menu" aria-expanded="false" type="button">Current</button>' +
      '<div role="menu" id="model-menu" hidden>' +
      '<button role="menuitemradio" aria-checked="true">Default</button>' +
      '<button role="menuitemradio" aria-checked="false">Pro</button></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.modelOpens=0;window.modelChanges=0;' +
      'document.querySelector("#model-trigger").onclick=()=>{window.modelOpens++;' +
      'document.querySelector("#model-trigger").setAttribute("aria-expanded","true");' +
      'document.querySelector("#model-menu").hidden=false;};' +
      'document.querySelectorAll("[role=menuitemradio]").forEach(button=>button.onclick=()=>{' +
      'window.modelChanges++;document.querySelectorAll("[role=menuitemradio]")' +
      '.forEach(other=>other.setAttribute("aria-checked",String(other===button)));});' +
      '</script>');
    const beforeModel = await adapter.observe(task);
    assert.equal(beforeModel.actions.some(a => a.purpose === 'choose_model'), false);
    const openModel = beforeModel.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openModel);
    assert.equal(await page.evaluate(() => (window as any).modelOpens), 0,
      'observation must not mutate the provider model chooser');
    assert.equal((await adapter.act({ context: task, snapshotId: beforeModel.snapshotId,
      actionRef: openModel.actionRef, evidenceHash: openModel.evidenceHash })).kind,
    'authorization_required');
    assert.deepEqual(await adapter.act({ context: task, snapshotId: beforeModel.snapshotId,
      actionRef: openModel.actionRef, evidenceHash: openModel.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    assert.equal(await page.evaluate(() => (window as any).modelOpens), 1);
    const optionsModel = await adapter.observe(task);
    const choiceModel = optionsModel.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(choiceModel && choiceModel.input.kind === 'option');
    if (choiceModel.input.kind !== 'option') throw new Error('Expected model option schema');
    assert.deepEqual(choiceModel.input.options.map(o => o.value), ['Default', 'Pro']);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: optionsModel.snapshotId,
      actionRef: choiceModel.actionRef, evidenceHash: choiceModel.evidenceHash,
      input: 'Pro', authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_selected' });
    assert.equal(await page.evaluate(() => (window as any).modelChanges), 1);
    assert.equal((await adapter.act({ context: task, snapshotId: optionsModel.snapshotId,
      actionRef: choiceModel.actionRef, evidenceHash: choiceModel.evidenceHash,
      input: 'Pro', authorizedDecisionId: 'decision-model' })).kind, 'stale');

    // The documented Pro Standard/Extended picker may sit under Pro.
    // Both disclosure levels require a new journal-authorized action and a
    // fresh linked-menu observation; no menu opens during observe.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<button id="model-trigger" aria-label="Model" aria-haspopup="menu" ' +
      'aria-controls="model-menu" aria-expanded="false" type="button">Current</button>' +
      '<div role="menu" id="model-menu" hidden>' +
      '<button role="menuitemradio" aria-checked="true">Instant</button>' +
      '<button id="pro-trigger" role="menuitem" aria-haspopup="menu" ' +
      'aria-controls="pro-effort" aria-expanded="false">Pro</button></div>' +
      '<div role="menu" id="pro-effort" hidden>' +
      '<button role="menuitemradio" aria-checked="true">Standard</button>' +
      '<button role="menuitemradio" aria-checked="false">Extended</button></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.proRootOpens=0;window.proSubmenuOpens=0;window.proEffortChanges=0;' +
      'document.querySelector("#model-trigger").onclick=()=>{' +
      'window.proRootOpens++;document.querySelector("#model-trigger")' +
      '.setAttribute("aria-expanded","true");' +
      'document.querySelector("#model-menu").hidden=false;};' +
      'document.querySelector("#pro-trigger").onclick=()=>{' +
      'window.proSubmenuOpens++;document.querySelector("#pro-trigger")' +
      '.setAttribute("aria-expanded","true");' +
      'document.querySelector("#pro-effort").hidden=false;};' +
      'document.querySelectorAll("#pro-effort [role=menuitemradio]")' +
      '.forEach(button=>button.onclick=()=>{window.proEffortChanges++;' +
      'document.querySelectorAll("#pro-effort [role=menuitemradio]")' +
      '.forEach(other=>other.setAttribute("aria-checked",String(other===button)));});' +
      '</script>');
    const proClosed = await adapter.observe(task);
    const openProRoot = proClosed.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openProRoot);
    assert.equal(await page.evaluate(() => (window as any).proRootOpens), 0);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: proClosed.snapshotId,
      actionRef: openProRoot.actionRef, evidenceHash: openProRoot.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    const proNested = await adapter.observe(task);
    assert.equal(proNested.actions.some(a => a.purpose === 'choose_model'), false,
      'a Pro parent entry is not a verified reasoning level');
    const openProEffort = proNested.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openProEffort);
    assert.equal(await page.evaluate(() => (window as any).proSubmenuOpens), 0);
    assert.equal((await adapter.act({ context: task, snapshotId: proNested.snapshotId,
      actionRef: openProEffort.actionRef, evidenceHash: openProEffort.evidenceHash })).kind,
    'authorization_required');
    assert.deepEqual(await adapter.act({ context: task, snapshotId: proNested.snapshotId,
      actionRef: openProEffort.actionRef, evidenceHash: openProEffort.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    assert.equal(await page.evaluate(() => (window as any).proSubmenuOpens), 1);
    const proEffort = await adapter.observe(task);
    const selectEffort = proEffort.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(selectEffort && selectEffort.input.kind === 'option');
    if (selectEffort.input.kind !== 'option') throw new Error('Missing Pro level schema');
    assert.deepEqual(selectEffort.input.options.map(o => o.value),
      ['Pro Standard', 'Pro Extended']);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: proEffort.snapshotId,
      actionRef: selectEffort.actionRef, evidenceHash: selectEffort.evidenceHash,
      input: 'Pro Extended', authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_selected' });
    assert.equal(await page.evaluate(() => (window as any).proEffortChanges), 1);
    assert.equal((await adapter.act({ context: task, snapshotId: proEffort.snapshotId,
      actionRef: selectEffort.actionRef, evidenceHash: selectEffort.evidenceHash,
      input: 'Pro Extended', authorizedDecisionId: 'decision-model' })).kind, 'stale');
    // A portal may lazily mount the menu only after disclosure. Use the
    // declared exact aria-controls ID, then verify the mounted menu afresh.
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('#model-menu')!;
      const sub = document.querySelector<HTMLElement>('#pro-effort')!;
      const opener = document.querySelector<HTMLButtonElement>('#model-trigger')!;
      const trigger = document.querySelector<HTMLButtonElement>('#pro-trigger')!;
      const main = document.querySelector<HTMLElement>('main')!;
      root.hidden = true;
      sub.hidden = true;
      opener.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-expanded', 'false');
      root.remove();
      sub.remove();
      opener.onclick = () => {
        opener.setAttribute('aria-expanded', 'true');
        root.hidden = false;
        main.append(root);
      };
      trigger.onclick = () => {
        trigger.setAttribute('aria-expanded', 'true');
        sub.hidden = false;
        main.append(sub);
      };
    });
    const lazyModel = await adapter.observe(task);
    const lazyOpen = lazyModel.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(lazyOpen);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: lazyModel.snapshotId,
      actionRef: lazyOpen.actionRef, evidenceHash: lazyOpen.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    const lazyParent = await adapter.observe(task);
    assert.equal(lazyParent.actions.some(a => a.purpose === 'choose_model'), false);
    const lazyDisclosure = lazyParent.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(lazyDisclosure);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: lazyParent.snapshotId,
      actionRef: lazyDisclosure.actionRef, evidenceHash: lazyDisclosure.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    const lazyEffort = await adapter.observe(task);
    const lazyChoice = lazyEffort.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(lazyChoice && lazyChoice.input.kind === 'option');
    assert.equal(lazyEffort.capabilityIssues, undefined);

    // Missing submenu linkage is not a license to guess a Pro control.
    await page.evaluate(() => document.querySelector('#pro-trigger')!
      .removeAttribute('aria-controls'));
    const brokenPro = await adapter.observe(task);
    assert.equal(brokenPro.actions.some(a => a.purpose === 'choose_model' ||
      a.purpose === 'open_model_chooser'), false);
    assert.equal(brokenPro.blocker, 'none');
    assert.deepEqual(brokenPro.capabilityIssues, [
      { capability: 'model_choice', reason: 'pro-submenu-link-unverified' },
    ]);

    // Observed ChatGPT composer picker: the root portal is lazy and gains
    // aria-controls only after opening. The effort slider and model radios
    // coexist in the DOM, but only one view is visible at a time.
    await page.setContent(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button id="radix-opener" aria-label="ChatGPT 모델 선택"
          aria-haspopup="menu" aria-expanded="false" data-state="closed">추론 수준 Medium</button>
        <button data-testid="send-button">Send</button>
      </main>
      <script>
        window.radixRootOpens = 0;
        window.radixModelDisclosures = 0;
        window.radixSliderChanges = 0;
        window.radixModelChanges = 0;
        const opener = document.getElementById('radix-opener');
        opener.onclick = () => {
          window.radixRootOpens++;
          opener.setAttribute('aria-expanded', 'true');
          opener.setAttribute('data-state', 'open');
          opener.setAttribute('aria-controls', 'radix-menu');
          const menu = document.createElement('div');
          menu.id = 'radix-menu';
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-labelledby', 'radix-opener');
          menu.setAttribute('data-state', 'open');
          menu.style.opacity = '0';
          menu.innerHTML = '<div role="group">' +
            '<div id="radix-effort-view">' +
              '<div role="menuitem" aria-label="모델 선택" id="radix-choose">Medium</div>' +
              '<div role="menuitem" aria-label="파워">' +
                '<span role="slider" aria-valuenow="1" aria-valuemin="0" aria-valuemax="4" ' +
                'style="display:inline-block;width:28px;height:28px"></span>' +
              '</div></div>' +
            '<div id="radix-model-view" style="display:none">' +
              '<div role="menuitemradio" aria-checked="true">GPT-6</div>' +
              '<div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div>' +
            '</div></div>';
          document.querySelector('main').append(menu);
          window.setTimeout(() => { menu.style.opacity = '1'; }, 900);
          document.querySelector('[role=slider]').onclick = () => window.radixSliderChanges++;
          document.getElementById('radix-choose').onclick = () => {
            window.radixModelDisclosures++;
            window.setTimeout(() => {
              document.getElementById('radix-effort-view').style.display = 'none';
              document.getElementById('radix-model-view').style.display = 'block';
            }, 900);
          };
          document.querySelectorAll('#radix-model-view [role=menuitemradio]')
            .forEach(radio => radio.onclick = () => {
              window.radixModelChanges++;
              document.querySelectorAll('#radix-model-view [role=menuitemradio]')
                .forEach(other => other.setAttribute('aria-checked', String(other === radio)));
            });
        };
      </script>
    `);
    const radixClosed = await adapter.observe(task);
    assert.equal(radixClosed.actions.some(a => a.purpose === 'choose_model'), false);
    const openRadix = radixClosed.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openRadix, 'unmounted composer picker is a read-only disclosed candidate');
    assert.equal((await adapter.act({ context: task, snapshotId: radixClosed.snapshotId,
      actionRef: openRadix.actionRef, evidenceHash: openRadix.evidenceHash })).kind,
    'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).radixRootOpens), 0);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: radixClosed.snapshotId,
      actionRef: openRadix.actionRef, evidenceHash: openRadix.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    assert.equal(await page.evaluate(() => (window as any).radixRootOpens), 1,
      'opening animation cannot cause a second root click');
    const radixEffort = await adapter.observe(task);
    assert.equal(radixEffort.actions.some(a => a.purpose === 'choose_model'), false,
      'the visible slider is not a model option');
    const discloseRadix = radixEffort.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(discloseRadix, 'model list disclosure must be a separate authorized action');
    assert.equal((await adapter.act({ context: task, snapshotId: radixEffort.snapshotId,
      actionRef: discloseRadix.actionRef, evidenceHash: discloseRadix.evidenceHash })).kind,
    'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).radixModelDisclosures), 0);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: radixEffort.snapshotId,
      actionRef: discloseRadix.actionRef, evidenceHash: discloseRadix.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    assert.equal(await page.evaluate(() => (window as any).radixModelDisclosures), 1,
      'model view delay cannot cause a second disclosure click');
    const radixModels = await adapter.observe(task);
    const radixChoice = radixModels.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(radixChoice && radixChoice.input.kind === 'option');
    if (radixChoice.input.kind !== 'option') throw new Error('Missing visible Radix model options');
    assert.deepEqual(radixChoice.input.options.map(o => o.value), ['GPT-6', 'GPT-5.6 Sol']);
    assert.equal(await page.evaluate(() => (window as any).radixSliderChanges), 0,
      'no model enumeration may change reasoning effort');
    assert.equal((await adapter.act({ context: task, snapshotId: radixModels.snapshotId,
      actionRef: radixChoice.actionRef, evidenceHash: radixChoice.evidenceHash,
      input: 'GPT-5.6 Sol' })).kind, 'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).radixModelChanges), 0);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: radixModels.snapshotId,
      actionRef: radixChoice.actionRef, evidenceHash: radixChoice.evidenceHash,
      input: 'GPT-5.6 Sol', authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_selected' });
    assert.equal(await page.evaluate(() => (window as any).radixModelChanges), 1);
    assert.equal(await page.evaluate(() => (window as any).radixSliderChanges), 0);
    await page.evaluate(() => document.querySelector('#radix-menu')!
      .removeAttribute('aria-labelledby'));
    const unlinkedRadix = await adapter.observe(task);
    assert.equal(unlinkedRadix.actions.some(a => a.purpose === 'choose_model' ||
      a.purpose === 'open_model_chooser'), false,
      'a same-page but unlinked popover is not a trusted model chooser');
    assert.equal(unlinkedRadix.blocker, 'none');
    assert.deepEqual(unlinkedRadix.capabilityIssues, [
      { capability: 'model_choice', reason: 'composer-model-menu-link-or-controls-unverified' },
    ]);
    assert.ok(unlinkedRadix.actions.some(a => a.purpose === 'compose'),
      'an unverified model menu must not disable unrelated chat composition');

    // If the provider never finishes its transition, a one-shot decision
    // expires uncertain instead of clicking the disclosure again.
    await page.evaluate(() => {
      document.getElementById('radix-menu')!.setAttribute('aria-labelledby', 'radix-opener');
      document.getElementById('radix-effort-view')!.style.display = 'block';
      document.getElementById('radix-model-view')!.style.display = 'none';
      (window as any).radixModelDisclosures = 0;
      (document.getElementById('radix-choose') as HTMLElement).onclick = () => {
        (window as any).radixModelDisclosures++;
      };
    });
    const stalledView = await adapter.observe(task);
    const stalledDisclosure = stalledView.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(stalledDisclosure);
    const stalledViewResult = await adapter.act({ context: task, snapshotId: stalledView.snapshotId,
      actionRef: stalledDisclosure.actionRef, evidenceHash: stalledDisclosure.evidenceHash,
      authorizedDecisionId: 'decision-model' });
    assert.equal(stalledViewResult.kind, 'uncertain', 'no successful action without visible model radios');
    assert.equal(await page.evaluate(() => (window as any).radixModelDisclosures), 1);
    assert.equal((await adapter.act({ context: task, snapshotId: stalledView.snapshotId,
      actionRef: stalledDisclosure.actionRef, evidenceHash: stalledDisclosure.evidenceHash,
      authorizedDecisionId: 'decision-model' })).kind, 'stale');

    // Likewise, a Radix portal that stays unpainted must not be reopened.
    await page.setContent(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button id="stalled-root-opener" aria-label="ChatGPT 모델 선택"
          aria-haspopup="menu" aria-expanded="false" data-state="closed">Medium</button>
        <button data-testid="send-button">Send</button>
      </main>
      <script>
        window.stalledRootOpens = 0;
        document.getElementById('stalled-root-opener').onclick = () => {
          window.stalledRootOpens++;
          const opener = document.getElementById('stalled-root-opener');
          opener.setAttribute('aria-expanded', 'true');
          opener.setAttribute('data-state', 'open');
          opener.setAttribute('aria-controls', 'stalled-root-menu');
          const menu = document.createElement('div');
          menu.id = 'stalled-root-menu';
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-labelledby', 'stalled-root-opener');
          menu.setAttribute('data-state', 'open');
          menu.style.cssText = 'width:160px;height:80px;opacity:0';
          document.querySelector('main').append(menu);
        };
      </script>
    `);
    const stalledRoot = await adapter.observe(task);
    const stalledOpen = stalledRoot.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(stalledOpen);
    const stalledRootResult = await adapter.act({ context: task, snapshotId: stalledRoot.snapshotId,
      actionRef: stalledOpen.actionRef, evidenceHash: stalledOpen.evidenceHash,
      authorizedDecisionId: 'decision-model' });
    assert.equal(stalledRootResult.kind, 'uncertain', 'no successful action without a painted root');
    assert.equal(await page.evaluate(() => (window as any).stalledRootOpens), 1);
    assert.equal((await adapter.act({ context: task, snapshotId: stalledRoot.snapshotId,
      actionRef: stalledOpen.actionRef, evidenceHash: stalledOpen.evidenceHash,
      authorizedDecisionId: 'decision-model' })).kind, 'stale');

    // The observed ChatGPT DIL renderer has no legacy author-role nodes.
    // A complete turn wrapper is a UI hint, never canonical final evidence.
    await page.setContent(`<main>
      <section data-talvt-turn-state="complete">
        <div data-chatgpt-search-unit-key="user-b:user" data-chatgpt-search-message-ids="user-b">
          <div data-user-message-bubble="true">SessionPlane 연결 테스트입니다. OK만 답해주세요.</div>
        </div>
        <div data-chatgpt-search-unit-key="answer-b:assistant"
          data-chatgpt-search-message-ids="answer-b">
          <div data-chatgpt-selection-message-id="answer-b">
            <div data-dil-message-id="answer-b" data-dil-response>
              <p><span data-d-stream-run>OK</span></p>
            </div>
          </div>
        </div>
      </section>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    </main>`);
    const dilTurn = await adapter.observe(context(lease, 'user-b'));
    assert.equal(dilTurn.surface, 'chat');
    assert.equal(dilTurn.turn.submittedUserFound, true);
    assert.equal(dilTurn.turn.answerMessageId, 'answer-b');
    assert.equal(dilTurn.turn.partialAnswer, 'OK');
    const dilCandidate = await observeChatGptDom(page, {
      submittedUserMessageId: 'user-b', submittedUserTurnId: null,
    });
    assert.equal(dilCandidate.candidate?.terminalMarker, false,
      'provider turn wrapper alone is not canonical final evidence');
    assert.equal(dilCandidate.candidate?.streamingMarker, false);

    // A renderer may omit turn IDs; when it explicitly exposes one, a
    // conflicting turn or message identity must not anchor this submission.
    const exactUser = page.locator('[data-chatgpt-search-unit-key="user-b:user"]');
    await exactUser.evaluate(node => node.setAttribute('data-turn-id', 'foreign-turn'));
    const wrongTurn = await adapter.observe(context(lease, 'user-b'));
    assert.equal(wrongTurn.turn.submittedUserFound, false);
    assert.equal(wrongTurn.blocker, 'unsupported');
    assert.equal(wrongTurn.actions.length, 0);
    await exactUser.evaluate(node => {
      node.setAttribute('data-turn-id', 'turn-b');
      node.setAttribute('data-chatgpt-search-message-ids', 'foreign-user');
    });
    const wrongMessage = await adapter.observe(context(lease, 'user-b'));
    assert.equal(wrongMessage.turn.submittedUserFound, false);
    assert.equal(wrongMessage.blocker, 'unsupported');
    assert.equal(wrongMessage.actions.length, 0);
    await exactUser.evaluate(node => {
      node.removeAttribute('data-turn-id');
      node.setAttribute('data-chatgpt-search-message-ids', 'user-b');
    });

    // A matching conversation URL is insufficient if the submitted user
    // anchor is no longer in the mounted transcript.
    const missingAnchor = await adapter.observe(context(lease, 'missing-user-b'));
    assert.equal(missingAnchor.turn.submittedUserFound, false);
    assert.equal(missingAnchor.blocker, 'unsupported');
    assert.equal(missingAnchor.reason, 'submitted-user-boundary-unverified');
    assert.equal(missingAnchor.actions.length, 0);

    // A transcript rerender after observation invalidates its pending actionRef.
    const anchoredContext = context(lease, 'user-b');
    const beforeUnmount = await adapter.observe(anchoredContext);
    const staleCompose = beforeUnmount.actions.find(action => action.purpose === 'compose')!;
    assert.ok(staleCompose);
    await page.locator('[data-chatgpt-search-unit-key="user-b:user"]')
      .evaluate(node => node.remove());
    const staleBoundaryAction = await adapter.act({ context: anchoredContext,
      snapshotId: beforeUnmount.snapshotId, actionRef: staleCompose.actionRef,
      evidenceHash: staleCompose.evidenceHash, input: 'Must not fill after anchor loss' });
    assert.equal(staleBoundaryAction.kind, 'stale');
    assert.equal(await page.locator('#prompt-textarea').innerText(), '');

    // Reuse the exact last-turn stream-retry guard. An approved retry click
    // still cannot prove that generation resumed or a final answer exists.
    const retryTask = context(lease, 'user-b');
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div role="alert">Error in message stream <button id="retry">Retry</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.retries=0;document.querySelector("#retry").onclick=()=>{' +
      'window.retries++;document.querySelector("[role=alert]").remove();};</script>');
    const retryObserved = await adapter.observe(retryTask);
    assert.equal(retryObserved.blocker, 'provider_retry');
    const retryAction = retryObserved.actions.find(a => a.purpose === 'retry')!;
    assert.ok(retryAction && retryAction.risk === 'retry_once');
    assert.equal((await adapter.act({ context: retryTask,
      snapshotId: retryObserved.snapshotId, actionRef: retryAction.actionRef,
      evidenceHash: retryAction.evidenceHash })).kind, 'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).retries), 0);
    const clickedRetry = await adapter.act({ context: retryTask,
      snapshotId: retryObserved.snapshotId, actionRef: retryAction.actionRef,
      evidenceHash: retryAction.evidenceHash, authorizedAttemptId: 'journaled-attempt-retry' });
    assert.deepEqual(clickedRetry, { kind: 'uncertain',
      reason: 'retry-clicked-provider-progress-unverified' });
    assert.equal(await page.evaluate(() => (window as any).retries), 1);
    assert.equal((await adapter.act({ context: retryTask,
      snapshotId: retryObserved.snapshotId, actionRef: retryAction.actionRef,
      evidenceHash: retryAction.evidenceHash, authorizedAttemptId: 'journaled-attempt-retry' })).kind,
    'stale', 'exact Retry cannot be replayed after uncertain click');

    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div role="alert">Error in message stream <button id="retry">Retry</button></div>' +
      '<div id="prompt-textarea" contenteditable="true">Human draft</div>' +
      '<button data-testid="send-button">Send</button></main>');
    const guardedRetry = await adapter.observe(retryTask);
    assert.equal(guardedRetry.blocker, 'unsupported');
    assert.match(guardedRetry.reason ?? '', /stream-retry-preserve-draft/);
    assert.equal(guardedRetry.actions.some(a => a.purpose === 'retry'), false);

    // A currently streaming exact assistant response suppresses any send
    // candidate, even if a retained editable draft and Send button exist.
    await page.setContent('<main>' +
      '<div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div data-message-author-role="assistant" data-message-id="answer-b" ' +
      'data-is-streaming="true">Partial output</div>' +
      '<div id="prompt-textarea" contenteditable="true">Human draft</div>' +
      '<button data-testid="send-button">Send</button></main>');
    const streaming = await adapter.observe(context(lease, 'user-b'));
    assert.equal(streaming.progress, 'streaming');
    assert.equal(streaming.blocker, 'unsupported');
    assert.equal(streaming.reason, 'generation-active-preserve-current-turn');
    assert.equal(streaming.actions.length, 0);
    const unboundDuringStream = await adapter.observe(task);
    assert.equal(unboundDuringStream.blocker, 'unsupported',
      'a new task cannot replace another active streamed answer');
    assert.equal(unboundDuringStream.actions.length, 0);

    // A previously issued draft action must also become stale if another
    // streamed answer starts before mutation, with unchanged composer controls.
    await page.setContent(NORMAL);
    const beforeUnboundStream = await adapter.observe(task);
    const unboundCompose = beforeUnboundStream.actions.find(a => a.purpose === 'compose')!;
    assert.ok(unboundCompose);
    await page.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="assistant" data-message-id="foreign-stream" data-is-streaming="true">Active answer</div>'));
    const staleUnboundCompose = await adapter.act({
      context: task, snapshotId: beforeUnboundStream.snapshotId,
      actionRef: unboundCompose.actionRef, evidenceHash: unboundCompose.evidenceHash,
      input: 'Must not replace an active answer',
    });
    assert.equal(staleUnboundCompose.kind, 'stale');
    assert.equal(await page.locator('#prompt-textarea').innerText(), '');

    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>');
    const boundContext = context(lease, 'user-b');
    const beforeBoundStream = await adapter.observe(boundContext);
    const boundCompose = beforeBoundStream.actions.find(a => a.purpose === 'compose')!;
    assert.ok(boundCompose);
    await page.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="assistant" data-message-id="answer-b" data-is-streaming="true">Streaming</div>'));
    const staleBoundCompose = await adapter.act({
      context: boundContext, snapshotId: beforeBoundStream.snapshotId,
      actionRef: boundCompose.actionRef, evidenceHash: boundCompose.evidenceHash,
      input: 'Must not draft during newly active generation',
    });
    assert.equal(staleBoundCompose.kind, 'stale');
    assert.equal(await page.locator('#prompt-textarea').innerText(), '');

    // A provider question mounted after observation supersedes a draft
    // action even if no composer control or fingerprint has changed.
    await page.setContent(NORMAL);
    const beforeQuestion = await adapter.observe(task);
    const pendingDraftForQuestion = beforeQuestion.actions.find(a => a.purpose === 'compose')!;
    assert.ok(pendingDraftForQuestion);
    await page.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend',
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<div role="radiogroup"><button type="button" role="radio" aria-label="Proceed">Proceed</button>' +
      '<button type="button" role="radio" aria-label="Pause">Pause</button></div></section>'));
    const staleDraftForQuestion = await adapter.act({
      context: task, snapshotId: beforeQuestion.snapshotId,
      actionRef: pendingDraftForQuestion.actionRef, evidenceHash: pendingDraftForQuestion.evidenceHash,
      input: 'Must not draft over a new question',
    });
    assert.equal(staleDraftForQuestion.kind, 'stale');
    assert.equal(await page.locator('#prompt-textarea').innerText(), '');

    // Likewise, an intervening scoped permission request must invalidate a
    // previously authorized send without clicking Send or Allow.
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div id="prompt-textarea" contenteditable="true">Committed reply</div>' +
      '<button data-testid="send-button" onclick="window.sent++">Send</button></main>' +
      '<script>window.sent=0;</script>');
    const boundBeforePermission = context(lease, 'user-b');
    const beforePermission = await adapter.observe(boundBeforePermission);
    const pendingSend = beforePermission.actions.find(a => a.purpose === 'submit')!;
    assert.ok(pendingSend);
    await page.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend',
      '<div role="alert">hostspan-git requires repository read <button>Allow once</button></div>'));
    const staleSendForPermission = await adapter.act({
      context: boundBeforePermission, snapshotId: beforePermission.snapshotId,
      actionRef: pendingSend.actionRef, evidenceHash: pendingSend.evidenceHash,
      expectedContentSha256: digest('Committed reply'), authorizedAttemptId: 'journaled-attempt-permission',
    });
    assert.equal(staleSendForPermission.kind, 'stale');
    assert.equal(await page.evaluate(() => (window as any).sent), 0);

    // A newly mounted exact stream-error Retry also supersedes an old send,
    // including when the retained draft itself makes Retry unavailable.
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div id="prompt-textarea" contenteditable="true">Committed reply</div>' +
      '<button data-testid="send-button" onclick="window.sent++">Send</button></main>' +
      '<script>window.sent=0;</script>');
    const beforeRetryAlert = await adapter.observe(boundBeforePermission);
    const pendingSendForRetry = beforeRetryAlert.actions.find(a => a.purpose === 'submit')!;
    assert.ok(pendingSendForRetry);
    await page.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend',
      '<div role="alert">Error in message stream <button>Retry</button></div>'));
    const staleSendForRetry = await adapter.act({
      context: boundBeforePermission, snapshotId: beforeRetryAlert.snapshotId,
      actionRef: pendingSendForRetry.actionRef, evidenceHash: pendingSendForRetry.evidenceHash,
      expectedContentSha256: digest('Committed reply'), authorizedAttemptId: 'journaled-attempt-retry-alert',
    });
    assert.equal(staleSendForRetry.kind, 'stale');
    assert.equal(await page.evaluate(() => (window as any).sent), 0);
    await page.setContent('<main><div data-chatgpt-composer>' +
      '<div role="textbox" contenteditable="true"></div>' +
      '<textarea></textarea><button aria-label="Send message">Send</button>' +
      '</div></main>');
    const ambiguous = await adapter.observe(task);
    assert.equal(ambiguous.blocker, 'unsupported');
    assert.match(ambiguous.reason ?? '', /composer-ambiguous/);
    assert.equal(ambiguous.actions.length, 0);

    // Visible provider error and identity-check dialogs are read-only blockers.
    // Neither an available Send button nor a writable composer overrides them.
    for (const [dialogText, blocker] of [
      ['Rate limit reached', 'rate_limit'],
      ['Verify you are human', 'human_verification'],
    ] as const) {
      await page.setContent('<main><div role="alertdialog">' + dialogText + '</div>' +
        '<div id="prompt-textarea" contenteditable="true"></div>' +
        '<button data-testid="send-button">Send</button></main>');
      const blocked = await adapter.observe(task);
      assert.equal(blocked.blocker, blocker);
      assert.equal(blocked.actions.length, 0, 'provider dialog cannot authorize a send');
    }

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

    // Page ownership may be revoked while observe awaits several DOM reads.
    // Its final packet must not expose an executable ref from the old lease.
    let leaseChecks = 0;
    const revokedMidObservation = new ChatGptSemanticAdapter({
      isExactLease: () => ++leaseChecks <= 2, resolvePage: () => page,
    });
    const revokedPacket = await revokedMidObservation.observe(task);
    assert.equal(revokedPacket.blocker, 'unsupported');
    assert.equal(revokedPacket.actions.length, 0);
    assert.equal(revokedPacket.turn.partialAnswer, null);

    await page.setContent('<main><div role="radiogroup">' +
      '<button role="radio" aria-checked="false">Chat</button>' +
      '<button role="radio" aria-checked="true">Work</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<article data-message-author-role="user" data-message-id="user-b" data-turn-id="turn-b">' +
      'Work-only request</article>' +
      '<article data-message-author-role="assistant" data-message-id="work-answer">' +
      '<div class="markdown">Work-only answer</div></article>' +
      '<button aria-label="Send">Send</button></main>');
    const work = await adapter.observe(context(lease, 'user-b'));
    assert.equal(work.surface, 'work');
    assert.equal(work.blocker, 'unsupported');
    assert.equal(work.actions.length, 0);
    assert.equal(work.turn.submittedUserFound, false);
    assert.equal(work.turn.answerMessageId, null);
    assert.equal(work.turn.partialAnswer, null, 'unsupported Work transcript must not escape a Chat adapter');

    // Defense in depth: even if an external ownership implementation
    // mistakenly retains a lease after navigation, the semantic adapter
    // never treats a foreign ChatGPT conversation as the bound Main.
    await page.goto('https://chatgpt.com/c/foreign-conversation');
    const permissiveFixtureLease = new ChatGptSemanticAdapter({
      isExactLease: () => true, resolvePage: () => page,
    });
    const foreign = await permissiveFixtureLease.observe(task);
    assert.equal(foreign.blocker, 'unsupported');
    assert.equal(foreign.reason, 'conversation-url-mismatch');
    assert.equal(foreign.actions.length, 0);
    const oversizedForeign = await permissiveFixtureLease.observe({
      ...task, submittedUserMessageId: 'm'.repeat(20_000),
    });
    assert.equal(oversizedForeign.blocker, 'unsupported');
    assert.equal(oversizedForeign.reason, 'conversation-url-mismatch');
    assert.equal(oversizedForeign.actions.length, 0);
    assert.equal(oversizedForeign.turn.submittedUserMessageId, null);
    assert.ok(oversizedForeign.evidenceBytes <= 12 * 1024,
      'fail-closed observations must remain within the semantic evidence budget');
    assert.equal(oversizedForeign.evidenceBytes, Buffer.byteLength(JSON.stringify(oversizedForeign)));
    const unbound = await permissiveFixtureLease.observe({
      ...task, providerConversationId: null,
    });
    assert.equal(unbound.blocker, 'unsupported');
    assert.equal(unbound.reason, 'conversation-binding-required');
    assert.equal(unbound.actions.length, 0);

    allowedLease = null;
    await assert.rejects(adapter.observe(task), /Stale exact Task/);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT model action refuses an intervening user turn after authorization', {
  timeout: 40_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-b-model-turn-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'), pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body:
        '<main><div data-message-author-role="user" data-message-id="user-b">Original task</div>' +
        '<div id="prompt-textarea" contenteditable="true"></div>' +
        '<button id="model-turn-opener" aria-label="Model" aria-haspopup="menu" ' +
        'aria-controls="model-turn-menu" aria-expanded="false">Current</button>' +
        '<div id="model-turn-menu" role="menu" hidden>' +
        '<button role="menuitemradio" aria-checked="true">Default</button>' +
        '<button role="menuitemradio" aria-checked="false">Pro</button></div></main>' +
        '<script>window.modelOpens=0;document.querySelector("#model-turn-opener").onclick=()=>{' +
        'window.modelOpens++;document.querySelector("#model-turn-opener")' +
        '.setAttribute("aria-expanded","true");document.querySelector("#model-turn-menu").hidden=false;};</script>',
    }));
    await page.goto('https://chatgpt.com/c/conversation-b');
    const current = registry.getBinding(binding.pageKey);
    const lease: OwnedPageIdentity = {
      projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
      pageKey: current.pageKey, targetId: current.targetId!, bindingEpoch: current.bindingEpoch,
    };
    let authorizationChecks = 0;
    let entered!: () => void;
    const authorizationEntered = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void;
    const authorization = new Promise<void>(resolve => { resume = resolve; });
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => page,
      isAuthorizedDecision: async () => {
        if (++authorizationChecks === 2) { entered(); await authorization; }
        return true;
      },
    });
    const task = context(lease, 'user-b');
    const observed = await adapter.observe(task);
    const action = observed.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(action, 'current task must have a unique model disclosure');
    const pending = adapter.act({
      context: task, snapshotId: observed.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      authorizedDecisionId: 'decision-model-after-user',
    });
    await authorizationEntered;
    await page.locator('#model-turn-opener').evaluate(opener => {
      const later = document.createElement('div');
      later.setAttribute('data-message-author-role', 'user');
      later.setAttribute('data-message-id', 'later-user');
      later.textContent = 'New question overrides the original turn';
      opener.before(later);
    });
    resume();
    const result = await pending;
    assert.notEqual(result.kind, 'performed',
      'a previously authorized model action cannot mutate after another user turn');
    assert.equal(await page.evaluate(() => (window as any).modelOpens), 0);
    await page.locator('[data-message-id="later-user"]').evaluate(element => element.remove());
    await page.locator('#model-turn-opener').evaluate(opener => {
      opener.setAttribute('aria-expanded', 'true');
      const menu = document.getElementById('model-turn-menu')!;
      menu.hidden = false;
      (window as any).modelSelections = 0;
      menu.querySelectorAll('[role="menuitemradio"]').forEach(radio => {
        (radio as HTMLElement).onclick = () => {
          (window as any).modelSelections++;
          menu.querySelectorAll('[role="menuitemradio"]').forEach(other =>
            other.setAttribute('aria-checked', String(other === radio)));
        };
      });
    });
    let selectionChecks = 0;
    let selectionEntered!: () => void;
    const selectionWaiting = new Promise<void>(resolve => { selectionEntered = resolve; });
    let allowSelection!: () => void;
    const selectionAuthorization = new Promise<void>(resolve => { allowSelection = resolve; });
    const selector = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => page,
      isAuthorizedDecision: async () => {
        if (++selectionChecks === 2) { selectionEntered(); await selectionAuthorization; }
        return true;
      },
    });
    const options = await selector.observe(task);
    const selection = options.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(selection, 'an open owned menu must expose the exact model choices');
    const pendingSelection = selector.act({
      context: task, snapshotId: options.snapshotId,
      actionRef: selection.actionRef, evidenceHash: selection.evidenceHash,
      input: 'Pro', authorizedDecisionId: 'decision-select-after-user',
    });
    await selectionWaiting;
    await page.locator('#model-turn-opener').evaluate(opener => {
      const later = document.createElement('div');
      later.setAttribute('data-message-author-role', 'user');
      later.setAttribute('data-message-id', 'next-user');
      later.textContent = 'New question before model selection';
      opener.before(later);
    });
    allowSelection();
    const selected = await pendingSelection;
    assert.notEqual(selected.kind, 'performed',
      'a previous model selection cannot apply after a new user turn');
    assert.equal(await page.evaluate(() => (window as any).modelSelections), 0);

    // The user may advance the transcript during the final model-menu read.
    // An old observation must not publish fresh executable refs for that turn.
    await page.locator('[data-message-id="next-user"]').evaluate(element => element.remove());
    let releaseModelObservation!: () => void;
    const modelObservationGate = new Promise<void>(resolve => { releaseModelObservation = resolve; });
    let signalModelObservation!: () => void;
    const modelObservationEntered = new Promise<void>(resolve => { signalModelObservation = resolve; });
    let holdModelObservation = true;
    const delayedPage = new Proxy(page, { get(target, prop) {
      if (prop === 'evaluate') return async (fn: unknown, arg: unknown) => {
        if (holdModelObservation && typeof fn === 'function' &&
            fn.toString().includes('openerSelector')) {
          holdModelObservation = false;
          signalModelObservation();
          await modelObservationGate;
        }
        return await page.evaluate(fn as never, arg as never);
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const delayedObserver = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => delayedPage,
    });
    const pendingObservation = delayedObserver.observe(task);
    await modelObservationEntered;
    await page.locator('#model-turn-opener').evaluate(opener => {
      const later = document.createElement('div');
      later.setAttribute('data-message-author-role', 'user');
      later.setAttribute('data-message-id', 'observed-later-user');
      later.textContent = 'Later user during slow observation';
      opener.before(later);
    });
    releaseModelObservation();
    const staleObservation = await pendingObservation;
    assert.equal(staleObservation.blocker, 'unsupported',
      'turn changes during observation must invalidate old semantic decisions');
    assert.equal(staleObservation.actions.length, 0);

    // A Chat -> Work mode change during a slow semantic read must revoke
    // the whole Chat snapshot, even with unchanged turn and composer.
    await page.locator('[data-message-id="observed-later-user"]').evaluate(node => node.remove());
    await page.locator('#model-turn-opener').evaluate(opener => {
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      group.innerHTML = '<button aria-pressed="true">Chat</button>' +
        '<button aria-pressed="false">Work</button>';
      opener.before(group);
    });
    let changedMode = false;
    const modeRacePage = new Proxy(page, { get(target, prop) {
      if (prop === 'evaluate') return async (fn: unknown, arg: unknown) => {
        const result = await page.evaluate(fn as never, arg as never);
        if (!changedMode && typeof fn === 'function' &&
            fn.toString().includes('openerSelector')) {
          changedMode = true;
          await page.locator('[role="group"]').evaluate(group => {
            group.querySelectorAll('button').forEach(button => button.setAttribute(
              'aria-pressed', String(button.textContent === 'Work')));
          });
        }
        return result;
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const modeObserver = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => modeRacePage,
    });
    const modeRace = await modeObserver.observe(task);
    assert.equal(changedMode, true, 'fixture must change the selected mode mid-read');
    assert.equal(modeRace.blocker, 'unsupported');
    assert.equal(modeRace.surface, 'work');
    assert.equal(modeRace.actions.length, 0, 'Work cannot inherit Chat actionRefs');
    assert.equal(modeRace.turn.partialAnswer, null);
    await page.locator('[role="group"]').evaluate(group => group.remove());


    // Reordering a linked model opener between inspection and elementHandle
    // must not redirect a verified menu action to another in-main button.
    await page.locator('#model-turn-opener').evaluate(opener => {
      opener.setAttribute('aria-expanded', 'false');
      document.getElementById('model-turn-menu')!.hidden = true;
    });
    await page.evaluate(() => { (window as any).wrongModelOpens = 0; });
    const beforeReorder = await inspectSemanticChatGptModelMenu(page);
    assert.ok(beforeReorder && beforeReorder.status === 'closed');
    const reorderedPage = new Proxy(page, { get(target, prop) {
      if (prop === 'locator') return (selector: string) => {
        if (selector !== 'button[aria-haspopup="menu"]') return page.locator(selector);
        return { nth: (index: number) => ({ elementHandle: async () => {
          await page.locator('#model-turn-opener').evaluate(opener => {
            const wrong = document.createElement('button');
            wrong.id = 'wrong-model-opener';
            wrong.textContent = 'Other model';
            wrong.setAttribute('aria-label', 'Model');
            wrong.setAttribute('aria-haspopup', 'menu');
            wrong.setAttribute('aria-controls', 'wrong-menu');
            wrong.setAttribute('aria-expanded', 'false');
            wrong.onclick = () => { (window as any).wrongModelOpens++; };
            opener.before(wrong);
          });
          return page.locator(selector).nth(index).elementHandle();
        } }) };
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    let openerError: unknown;
    try {
      await openExactChatGptModelMenu(reorderedPage, beforeReorder.evidenceHash, () => {});
    } catch (error) { openerError = error; }
    assert.ok(openerError instanceof Error, 'a reordered menu should require a new observation');
    assert.equal(await page.evaluate(() => (window as any).wrongModelOpens), 0,
      'the original menu index must never click the newly inserted wrong opener');

    // Replacing a radio with the same accessible label during the async
    // pre-click check cannot transfer this exact model choice to a new node.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<button id="select-model-opener" aria-label="Model" aria-haspopup="menu" ' +
      'aria-controls="select-model-menu" aria-expanded="true">Current</button>' +
      '<div id="select-model-menu" role="menu">' +
      '<button role="menuitemradio" aria-checked="true">Default</button>' +
      '<button id="original-pro" role="menuitemradio" aria-checked="false">Pro</button>' +
      '</div></main><script>window.foreignModelSelections=0;</script>');
    const originalSelection = await inspectSemanticChatGptModelMenu(page);
    assert.ok(originalSelection && originalSelection.status === 'open');
    let selectionError: unknown;
    try {
      await selectExactChatGptModelMenu(page, originalSelection.evidenceHash, 'Pro', async () => {
        await page.locator('#original-pro').evaluate(original => {
          const replacement = original.cloneNode(true) as HTMLElement;
          replacement.id = 'replacement-pro';
          replacement.onclick = () => {
            (window as any).foreignModelSelections++;
            document.querySelectorAll('#select-model-menu [role="menuitemradio"]').forEach(other =>
              other.setAttribute('aria-checked', String(other === replacement)));
          };
          original.replaceWith(replacement);
        });
      });
    } catch (error) { selectionError = error; }
    assert.ok(selectionError instanceof Error,
      'a replaced radio requires fresh exact option authorization');
    assert.equal(await page.evaluate(() => (window as any).foreignModelSelections), 0,
      'a replacement with identical text cannot inherit the original action');

  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT permission facts do not outlive their exact user turn during observe', {
  timeout: 35_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-b-permission-turn-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'), pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<main></main>',
    }));
    await page.goto('https://chatgpt.com/c/conversation-b');
    registry.reservePage(binding.pageKey, {
      sessionId: 'fixture-b', generation: 1, conversationId: 'conversation-b',
    });
    const current = registry.getBinding(binding.pageKey);
    const lease: OwnedPageIdentity = {
      projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
      pageKey: current.pageKey, targetId: current.targetId!, bindingEpoch: current.bindingEpoch,
    };
    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">Original task</div>' +
      '<div role="alert">hostspan-git requests repository access ' +
      '<button type="button" onclick="window.grants++">Allow once</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>' +
      '<script>window.grants=0;</script>');
    let advanceDuringPermission = false;
    let advanced = false;
    const racedPage = new Proxy(page, { get(target, prop) {
      if (prop === 'evaluate') return async (fn: unknown, arg: unknown) => {
        const result = await page.evaluate(fn as never, arg as never);
        if (advanceDuringPermission && typeof fn === 'function' &&
          fn.toString().includes('maxSummary') && fn.toString().includes('userId')) {
          advanceDuringPermission = false;
          advanced = true;
          await page.locator('#prompt-textarea').evaluate(editor => {
            const later = document.createElement('article');
            later.setAttribute('data-message-author-role', 'user');
            later.setAttribute('data-message-id', 'later-user');
            later.textContent = 'Human follow-up displaces the permission';
            editor.before(later);
          });
        }
        return result;
      };
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => racedPage,
    });
    const task = context(lease, 'user-b');
    const fresh = await adapter.observe(task);
    assert.equal(fresh.blocker, 'provider_permission');
    assert.ok(fresh.capabilityManifest.supports.includes('permission'));
    assert.equal(fresh.actions.length, 0);
    assert.equal(fresh.permission?.canGrant, false);
    advanceDuringPermission = true;
    const stale = await adapter.observe(task);
    assert.equal(advanced, true, 'fixture must advance after the permission was read');
    assert.equal(stale.blocker, 'unsupported',
      'no-action permission facts must be fenced like executable refs');
    assert.equal(stale.reason, 'semantic-turn-boundary-changed-during-observation');
    assert.equal(stale.permission, null);
    assert.equal(stale.turn.submittedUserMessageId, null);
    assert.equal(stale.turn.partialAnswer, null);
    assert.equal(stale.actions.length, 0);
    assert.equal(stale.evidenceBytes, Buffer.byteLength(JSON.stringify(stale)));
    assert.equal(await page.evaluate(() => (window as any).grants), 0);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('ChatGPT mutations revalidate exact controls after asynchronous turn checks', {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-b-mutation-race-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'), pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<main></main>',
    }));
    await page.goto('https://chatgpt.com/c/conversation-b');
    registry.reservePage(binding.pageKey, {
      sessionId: 'fixture-b', generation: 1, conversationId: 'conversation-b',
    });
    const current = registry.getBinding(binding.pageKey);
    const lease: OwnedPageIdentity = {
      projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
      pageKey: current.pageKey, targetId: current.targetId!, bindingEpoch: current.bindingEpoch,
    };
    const task = context(lease, 'user-b');
    const bind = (target: object, prop: PropertyKey) => {
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    };
    let mutateComposer: (() => Promise<void>) | null = null;
    let messageObservations = 0;
    const racedPage = new Proxy(page, { get(target, prop) {
      if (prop !== 'locator') return bind(target, prop);
      return (selector: string) => {
        const locator = page.locator(selector);
        return new Proxy(locator, { get(loc, member) {
          if (member !== 'evaluateAll') return bind(loc, member);
          return async (fn: unknown, arg: unknown) => {
            const value = await locator.evaluateAll(fn as never, arg as never);
            if (mutateComposer !== null && typeof fn === 'function' &&
              fn.toString().includes('anchorAttributeMatches') && ++messageObservations === 2) {
              const mutation = mutateComposer;
              mutateComposer = null;
              await mutation();
            }
            return value;
          };
        } });
      };
    } });
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => racedPage,
      isAuthorizedAttempt: () => true,
    });

    await page.setContent('<main><article data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">Task</article>' +
      '<section data-chatgpt-composer><div id="prompt-textarea" role="textbox" ' +
      'contenteditable="true"></div><button data-testid="send-button">Send</button></section></main>');
    const composeObservation = await adapter.observe(task);
    const composeAction = composeObservation.actions.find(action => action.purpose === 'compose')!;
    assert.ok(composeAction);
    messageObservations = 0;
    mutateComposer = async () => {
      await page.locator('#prompt-textarea').fill('Human compose draft');
    };
    const composeOutcome = await adapter.act({
      context: task, snapshotId: composeObservation.snapshotId,
      actionRef: composeAction.actionRef, evidenceHash: composeAction.evidenceHash,
      input: 'Agent draft',
    });
    const composeDraft = await page.locator('#prompt-textarea').innerText();

    await page.setContent('<main><article data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">Task</article>' +
      '<section data-chatgpt-composer><div id="prompt-textarea" role="textbox" ' +
      'contenteditable="true">Committed draft</div>' +
      '<button data-testid="send-button" onclick="window.sends++;' +
      'window.sent=document.querySelector(\'#prompt-textarea\').innerText">Send</button>' +
      '</section></main><script>window.sends=0;window.sent=null;</script>');
    const submitObservation = await adapter.observe(task);
    const submitAction = submitObservation.actions.find(action => action.purpose === 'submit')!;
    assert.ok(submitAction);
    messageObservations = 0;
    mutateComposer = async () => {
      await page.locator('#prompt-textarea').fill('Human submit replacement');
    };
    const submitOutcome = await adapter.act({
      context: task, snapshotId: submitObservation.snapshotId,
      actionRef: submitAction.actionRef, evidenceHash: submitAction.evidenceHash,
      authorizedAttemptId: 'journaled-raced-submit',
      expectedContentSha256: digest('Committed draft'),
    });
    const submitted = await page.evaluate(() => ({
      sends: (window as any).sends,
      sent: (window as any).sent,
      draft: document.getElementById('prompt-textarea')!.innerText,
    }));

    // An original control can be moved into unrelated provider chrome while
    // the exact-turn read awaits; retained element handles alone are not scope.
    await page.setContent('<main><article data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">Task</article>' +
      '<section data-chatgpt-composer><div id="prompt-textarea" role="textbox" ' +
      'contenteditable="true"></div><button data-testid="send-button">Send</button>' +
      '</section></main><div id="foreign-panel" role="dialog"></div>');
    const movedComposeBefore = await adapter.observe(task);
    const movedComposeAction = movedComposeBefore.actions.find(a => a.purpose === 'compose')!;
    assert.ok(movedComposeAction);
    messageObservations = 0;
    mutateComposer = async () => {
      await page.locator('#prompt-textarea').evaluate(editor =>
        document.querySelector('#foreign-panel')!.append(editor));
    };
    const movedCompose = await adapter.act({
      context: task, snapshotId: movedComposeBefore.snapshotId,
      actionRef: movedComposeAction.actionRef, evidenceHash: movedComposeAction.evidenceHash,
      input: 'Draft must remain in the actual Chat composer',
    });
    const foreignDraft = await page.locator('#foreign-panel #prompt-textarea').innerText();

    await page.setContent('<main><article data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">Task</article>' +
      '<section data-chatgpt-composer><div id="prompt-textarea" role="textbox" ' +
      'contenteditable="true">Committed draft</div><button data-testid="send-button" ' +
      'onclick="window.foreignClicks++">Send</button></section></main>' +
      '<div id="foreign-panel" role="dialog"></div>' +
      '<script>window.foreignClicks=0;</script>');
    const movedSubmitBefore = await adapter.observe(task);
    const movedSubmitAction = movedSubmitBefore.actions.find(a => a.purpose === 'submit')!;
    assert.ok(movedSubmitAction);
    messageObservations = 0;
    mutateComposer = async () => {
      await page.locator('[data-testid="send-button"]').evaluate(button =>
        document.querySelector('#foreign-panel')!.append(button));
    };
    const movedSubmit = await adapter.act({
      context: task, snapshotId: movedSubmitBefore.snapshotId,
      actionRef: movedSubmitAction.actionRef, evidenceHash: movedSubmitAction.evidenceHash,
      authorizedAttemptId: 'journaled-moved-control',
      expectedContentSha256: digest('Committed draft'),
    });
    const foreignClicks = await page.evaluate(() => (window as any).foreignClicks);
    assert.notEqual(movedCompose.kind, 'performed',
      'an editor moved outside Chat must not receive an old compose authorization');
    assert.equal(foreignDraft, '', 'the foreign dialog must remain unchanged');
    assert.notEqual(movedSubmit.kind, 'dispatched_unverified',
      'a Send control moved to another scope must not use a committed attempt');
    assert.equal(foreignClicks, 0, 'the foreign Send control must not be clicked');


    await page.setContent('<main><section data-codex-composer-request-navigation="true" ' +
      'data-user-input-auto-resolution="true"><h3>Original question</h3>' +
      '<div role="radiogroup"><button type="button" role="radio" ' +
      'aria-label="Proceed">Proceed</button><button type="button" role="radio" ' +
      'aria-label="Decline">Decline</button></div></section></main>' +
      '<script>window.replacementClicks=0;</script>');
    const radio = await inspectChatGptQuestion(page);
    assert.ok(radio?.available);
    let radioError: unknown;
    try {
      await answerChatGptQuestion(page, {
        answer: 'Proceed', evidenceHash: radio.evidenceHash,
      }, async () => {
        await page.locator('section').evaluate(panel => {
          panel.outerHTML = '<section data-codex-composer-request-navigation="true" ' +
            'data-user-input-auto-resolution="true"><h3>Replacement question</h3>' +
            '<div role="radiogroup"><button id="replacement-radio" type="button" ' +
            'role="radio" aria-label="Proceed">Proceed</button><button type="button" ' +
            'role="radio" aria-label="Decline">Decline</button></div></section>';
          document.getElementById('replacement-radio')!.onclick = () => {
            (window as any).replacementClicks++;
            document.querySelector('section')!.remove();
          };
        });
      });
    } catch (error) { radioError = error; }
    const replacementClicks = await page.evaluate(() => (window as any).replacementClicks);

    await page.setContent('<main><section data-codex-composer-request-navigation="true" ' +
      'data-user-input-auto-resolution="true"><h3>Which repository?</h3><form>' +
      '<textarea aria-label="Repository"></textarea><button type="submit">Submit</button>' +
      '</form></section></main><script>window.freeSubmits=0;' +
      'document.querySelector("form").onsubmit=e=>{e.preventDefault();window.freeSubmits++;' +
      'document.querySelector("section").remove();};</script>');
    const free = await inspectChatGptFreeTextQuestion(page);
    assert.ok(free?.available);
    let freeCallbacks = 0;
    let freeError: unknown;
    try {
      await answerChatGptFreeTextQuestion(page, {
        answer: 'sessionplane', evidenceHash: free.evidenceHash,
      }, async () => {
        if (++freeCallbacks === 1) {
          await page.locator('textarea').fill('Human draft during exact-turn check');
        }
      });
    } catch (error) { freeError = error; }
    const freeState = await page.evaluate(() => ({
      submits: (window as any).freeSubmits,
      draft: (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? null,
    }));

    await page.setContent('<main><section data-codex-composer-request-navigation="true" ' +
      'data-user-input-auto-resolution="true"><h3>Which repository?</h3><form>' +
      '<textarea aria-label="Repository"></textarea><button type="submit">Submit</button>' +
      '</form></section></main><script>window.lateFreeSubmits=0;' +
      'document.querySelector("form").onsubmit=e=>{e.preventDefault();window.lateFreeSubmits++;' +
      'document.querySelector("section").remove();};</script>');
    const lateFree = await inspectChatGptFreeTextQuestion(page);
    assert.ok(lateFree?.available);
    let lateFreeCallbacks = 0;
    let lateFreeError: unknown;
    try {
      await answerChatGptFreeTextQuestion(page, {
        answer: 'sessionplane', evidenceHash: lateFree.evidenceHash,
      }, async () => {
        if (++lateFreeCallbacks === 2) {
          await page.locator('textarea').fill('Human revision before submit');
        }
      });
    } catch (error) { lateFreeError = error; }
    const lateFreeState = await page.evaluate(() => ({
      submits: (window as any).lateFreeSubmits,
      draft: (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value ?? null,
    }));

    assert.notEqual(composeOutcome.kind, 'performed',
      'a human draft written during the exact-turn read must not be overwritten');
    assert.equal(composeDraft, 'Human compose draft');
    assert.notEqual(submitOutcome.kind, 'dispatched_unverified',
      'a changed draft after the exact-turn read must not be sent');
    assert.deepEqual(submitted, {
      sends: 0, sent: null, draft: 'Human submit replacement',
    });
    assert.ok(radioError instanceof Error,
      'a replacement provider question must require a fresh exact action');
    assert.equal(replacementClicks, 0,
      'a same-label replacement radio cannot inherit the old authorization');
    assert.ok(freeError instanceof Error,
      'a human question draft entered during the exact-turn read must be preserved');
    assert.deepEqual(freeState, {
      submits: 0, draft: 'Human draft during exact-turn check',
    });
    assert.ok(lateFreeError instanceof Error,
      'a changed question draft immediately before submit must remain unsubmitted');
    assert.deepEqual(lateFreeState, {
      submits: 0, draft: 'Human revision before submit',
    });
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
        '<div data-message-author-role="user" data-message-id="user-b">Original task</div>' +
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
      isAuthorizedAttempt: input => input.attemptId.startsWith('decision-'),
    });
    const unboundQuestion = await adapter.observe(context(lease));
    assert.equal(unboundQuestion.blocker, 'unsupported',
      'a provider question without an exact submitted user turn belongs to no new task');
    assert.equal(unboundQuestion.reason, 'provider-question-turn-unverified');
    assert.equal(unboundQuestion.actions.length, 0, 'unbound task must not answer an outstanding question');
    assert.equal(unboundQuestion.questionText, null, 'foreign question content must not enter an unbound task packet');
    const task = context(lease, 'user-b');
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

    // A question can interrupt the exact assistant stream; it is not a new chat draft.
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div data-message-author-role="assistant" data-message-id="answer-b" data-is-streaming="true">Working</div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3>Choose during generation</h3><div role="radiogroup">' +
      '<button type="button" role="radio" aria-label="Proceed" onclick="window.streamChoice=\'go\';this.closest(\'section\').remove()">Proceed</button>' +
      '<button type="button" role="radio" aria-label="Decline" disabled>Decline</button>' +
      '</div></section></main><script>window.streamChoice=null;</script>');
    const streamingTask = context(lease, 'user-b');
    const streamingQuestion = await adapter.observe(streamingTask);
    assert.equal(streamingQuestion.progress, 'streaming');
    assert.equal(streamingQuestion.blocker, 'provider_question');
    const streamingAction = streamingQuestion.actions.find(a => a.purpose === 'answer_question')!;
    assert.ok(streamingAction);
    const streamingDecision = await adapter.act({ context: streamingTask,
      snapshotId: streamingQuestion.snapshotId, actionRef: streamingAction.actionRef,
      evidenceHash: streamingAction.evidenceHash, input: 'Proceed',
      authorizedAttemptId: 'decision-streaming' });
    assert.deepEqual(streamingDecision, { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).streamChoice), 'go');

    // A provider may replace the question after a fresh lookup but before
    // the locator click. The same option label is not proof of the same task.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3 id="race-question">Which repository?</h3><div role="radiogroup">' +
      '<button type="button" role="radio" aria-label="Proceed" id="race-proceed">Proceed</button>' +
      '<button type="button" role="radio" aria-label="Decline">Decline</button></div></section></main>' +
      '<script>window.raceClicks=0;document.getElementById("race-proceed").onclick=()=>{' +
      'window.raceClicks++;document.querySelector("section").remove();};</script>');
    const radioBefore = await inspectChatGptQuestion(page);
    assert.ok(radioBefore?.available);
    let swapped = false;
    const bound = (target: object, prop: PropertyKey) => {
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    };
    const racedPage = new Proxy(page, { get(target, prop) {
      if (prop !== 'locator') return bound(target, prop);
      return (selector: string) => {
        const locator = page.locator(selector);
        if (selector !== '[data-codex-composer-request-navigation="true"][data-user-input-auto-resolution="true"]') {
          return locator;
        }
        return new Proxy(locator, { get(loc, member) {
          if (member !== 'getByRole') return bound(loc, member);
          return (...args: Parameters<typeof loc.getByRole>) => {
            const radio = loc.getByRole(...args);
            return new Proxy(radio, { get(option, method) {
              if (method !== 'count') return bound(option, method);
              return async () => {
                const count = await option.count();
                if (!swapped) {
                  swapped = true;
                  await page.locator('#race-question').evaluate(element => {
                    element.textContent = 'Which service should launch?';
                  });
                }
                return count;
              };
            } });
          };
        } });
      };
    } });
    let radioOutcome: unknown = null;
    try {
      radioOutcome = await answerChatGptQuestion(racedPage, {
        answer: 'Proceed', evidenceHash: radioBefore.evidenceHash,
      }, () => {});
    } catch (error) { radioOutcome = error; }
    assert.equal(swapped, true);
    assert.equal(await page.evaluate(() => (window as any).raceClicks), 0,
      'a retained radio label must not click after the provider question changes');
    assert.ok(radioOutcome instanceof Error, 'changed radio question must remain unsubmitted');

    // A failed one-shot click stays uncertain even if the provider advances
    // the question before the click error reaches SessionPlane.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3>Original click-failure question</h3><div role="radiogroup">' +
      '<button type="button" role="radio" aria-label="Proceed">Proceed</button>' +
      '<button type="button" role="radio" aria-label="Decline">Decline</button>' +
      '</div></section></main>');
    const clickFailureBefore = await inspectChatGptQuestion(page);
    assert.ok(clickFailureBefore?.available);
    const clickFailurePage = new Proxy(page, { get(target, prop) {
      if (prop !== 'locator') return bound(target, prop);
      return (selector: string) => {
        const locator = page.locator(selector);
        if (selector !== '[data-codex-composer-request-navigation="true"][data-user-input-auto-resolution="true"]') {
          return locator;
        }
        return new Proxy(locator, { get(loc, member) {
          if (member !== 'getByRole') return bound(loc, member);
          return (...args: Parameters<typeof loc.getByRole>) => {
            const radio = loc.getByRole(...args);
            return new Proxy(radio, { get(option, method) {
              if (method !== 'elementHandle') return bound(option, method);
              return async (..._args: unknown[]) => {
                const handle = await option.elementHandle();
                if (!handle) return null;
                return new Proxy(handle, { get(original, handleMethod) {
                  if (handleMethod !== 'click') return bound(original, handleMethod);
                  return async (..._clickArgs: unknown[]) => {
                    await page.locator('section').evaluate(panel => {
                      panel.outerHTML = '<section data-codex-composer-request-navigation="true" ' +
                        'data-user-input-auto-resolution="true"><h3>Replacement after failed click</h3>' +
                        '<div role="radiogroup"><button type="button" role="radio" ' +
                        'aria-label="Proceed">Proceed</button><button type="button" role="radio" ' +
                        'aria-label="Decline">Decline</button></div></section>';
                    });
                    throw new Error('simulated click failure after provider advance');
                  };
                } });
              };
            } });
          };
        } });
      };
    } });
    let clickFailureOutcome: unknown = null;
    try {
      clickFailureOutcome = await answerChatGptQuestion(clickFailurePage, {
        answer: 'Proceed', evidenceHash: clickFailureBefore.evidenceHash,
      }, () => {});
    } catch (error) { clickFailureOutcome = error; }
    assert.ok(clickFailureOutcome instanceof Error,
      'a failed click must not become a successful question transition');
    assert.equal((clickFailureOutcome as Error & { errorCode?: string }).errorCode,
      'provider.action-unknown');

    // A bounded free-text question is a distinct typed input; only a scoped
    // provider panel may submit it, never an arbitrary form or chat editor.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div data-message-author-role="user" data-message-id="user-b">Original task</div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3>Which repository should we inspect?</h3><form><textarea aria-label="Repository"></textarea>' +
      '<button type="submit">Submit</button></form></section></main>' +
      '<script>window.freeAnswer=null;document.querySelector("form").onsubmit=e=>{' +
      'e.preventDefault();window.freeAnswer=document.querySelector("textarea").value;' +
      'document.querySelector("section").remove();};</script>');
    const free = await adapter.observe(task);
    assert.equal(free.blocker, 'provider_question');
    assert.match(free.questionText ?? '', /Which repository/);
    const option = free.actions.find(a => a.purpose === 'answer_question')!;
    assert.deepEqual(option.input, { kind: 'text', maxLength: 2_000 });
    const answered = await adapter.act({ context: task, snapshotId: free.snapshotId,
      actionRef: option.actionRef, evidenceHash: option.evidenceHash,
      input: 'sessionplane', authorizedAttemptId: 'decision-free-text' });
    assert.deepEqual(answered, { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).freeAnswer), 'sessionplane');
    assert.equal((await adapter.act({ context: task, snapshotId: free.snapshotId,
      actionRef: option.actionRef, evidenceHash: option.evidenceHash,
      input: 'other', authorizedAttemptId: 'decision-free-text' })).kind, 'stale');

    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div data-message-author-role="user" data-message-id="user-b">Original task</div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3>Which description should be retained?</h3>' +
      '<div id="answer-box" role="textbox" contenteditable="true" aria-label="Description"></div>' +
      '<button id="confirm-box" type="button" aria-label="Confirm">Confirm</button></section></main>' +
      '<script>window.editableAnswer=null;document.getElementById("confirm-box").onclick=()=>{' +
      'window.editableAnswer=document.getElementById("answer-box").innerText;' +
      'document.querySelector("section").remove();};</script>');
    const editable = await adapter.observe(task);
    assert.equal(editable.blocker, 'provider_question');
    const editableAction = editable.actions.find(a => a.purpose === 'answer_question')!;
    assert.ok(editableAction && editableAction.input.kind === 'text');
    const editableResult = await adapter.act({ context: task, snapshotId: editable.snapshotId,
      actionRef: editableAction.actionRef, evidenceHash: editableAction.evidenceHash,
      input: 'sessionplane', authorizedAttemptId: 'decision-editable-question' });
    assert.deepEqual(editableResult, { kind: 'performed', effect: 'question_answered' },
      'a unique contenteditable question must remain usable after the shell recheck');
    assert.equal(await page.evaluate(() => (window as any).editableAnswer), 'sessionplane');

    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div data-message-author-role="user" data-message-id="user-b">Original task</div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3 id="question-title">Which repository should we inspect?</h3>' +
      '<form><textarea aria-label="Repository"></textarea><button type="submit">Submit</button></form>' +
      '</section></main><script>window.changedQuestionSubmits=0;' +
      'document.querySelector("textarea").addEventListener("input",()=>{' +
      'document.querySelector("#question-title").textContent="Which service should we deploy?";});' +
      'document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();' +
      'window.changedQuestionSubmits++;document.querySelector("section").remove();});</script>');
    const changing = await adapter.observe(task);
    const changingAction = changing.actions.find(a => a.purpose === 'answer_question')!;
    assert.ok(changingAction);
    const changed = await adapter.act({ context: task, snapshotId: changing.snapshotId,
      actionRef: changingAction.actionRef, evidenceHash: changingAction.evidenceHash,
      input: 'sessionplane', authorizedAttemptId: 'decision-changing-question' });
    assert.notEqual(changed.kind, 'performed',
      'the original free-text answer cannot submit a different question appearing during fill');
    assert.equal(await page.evaluate(() => (window as any).changedQuestionSubmits), 0);
    assert.equal(await page.locator('textarea').inputValue(), 'sessionplane',
      'the already entered answer remains a protected draft for fresh review');

    // The user's conversation may advance while the second journal check
    // awaits. An unchanged provider panel cannot authorize an old turn.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div data-message-author-role="user" data-message-id="user-b">Original task</div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3>Which repository should be inspected?</h3>' +
      '<form><textarea aria-label="Repository"></textarea><button type="submit">Submit</button></form>' +
      '</section></main><script>window.laterQuestionSubmits=0;' +
      'document.querySelector("form").onsubmit=e=>{e.preventDefault();' +
      'window.laterQuestionSubmits++;document.querySelector("section").remove();};</script>');
    let laterAuthorizationChecks = 0;
    let signalLaterAuthorization!: () => void;
    const laterAuthorizationEntered = new Promise<void>(resolve => {
      signalLaterAuthorization = resolve;
    });
    let releaseLaterAuthorization!: () => void;
    const laterAuthorization = new Promise<void>(resolve => {
      releaseLaterAuthorization = resolve;
    });
    const laterUserAdapter = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => page,
      isAuthorizedAttempt: async () => {
        if (++laterAuthorizationChecks === 2) {
          signalLaterAuthorization();
          await laterAuthorization;
        }
        return true;
      },
    });
    const laterOriginal = await laterUserAdapter.observe(task);
    const laterAnswer = laterOriginal.actions.find(a => a.purpose === 'answer_question')!;
    assert.ok(laterAnswer, 'the original question is available before the new user turn');
    const pendingOldAnswer = laterUserAdapter.act({
      context: task, snapshotId: laterOriginal.snapshotId,
      actionRef: laterAnswer.actionRef, evidenceHash: laterAnswer.evidenceHash,
      input: 'sessionplane', authorizedAttemptId: 'decision-later-user',
    });
    await laterAuthorizationEntered;
    await page.locator('section').evaluate(panel => {
      const newer = document.createElement('div');
      newer.setAttribute('data-message-author-role', 'user');
      newer.setAttribute('data-message-id', 'newer-user');
      newer.textContent = 'A newer user request';
      panel.before(newer);
    });
    releaseLaterAuthorization();
    const oldAnswerResult = await pendingOldAnswer;
    assert.notEqual(oldAnswerResult.kind, 'performed',
      'a later user turn must revoke an old question even when its panel is unchanged');
    assert.equal(await page.evaluate(() => (window as any).laterQuestionSubmits), 0);

    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<div data-message-author-role="user" data-message-id="user-b">Original task</div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3>Preserve this partial answer</h3><form><textarea>Human typed</textarea>' +
      '<button type="submit">Submit</button></form></section></main>');
    const held = await adapter.observe(task);
    assert.equal(held.blocker, 'provider_question');
    assert.equal(held.actions.length, 0, 'preexisting provider-question draft cannot be overwritten');

    // An oversized combination of a partial answer and an exact provider
    // question must not leak an unbounded semantic packet or executable ref.
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div data-message-author-role="assistant" data-message-id="answer-b"></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div></main>');
    await page.evaluate(() => {
      document.querySelector('[data-message-id="answer-b"]')!.textContent = '가'.repeat(3000);
      const panel = document.createElement('section');
      panel.setAttribute('data-codex-composer-request-navigation', 'true');
      panel.setAttribute('data-user-input-auto-resolution', 'true');
      panel.innerHTML = '<h3></h3><div role="radiogroup">' +
        '<button type="button" role="radio" aria-label="Proceed">Proceed</button>' +
        '<button type="button" role="radio" aria-label="Pause">Pause</button></div>';
      panel.querySelector('h3')!.textContent = 'Q'.repeat(3900);
      document.querySelector('main')!.append(panel);
    });
    const oversized = await adapter.observe(task);
    assert.equal(oversized.reason, 'semantic-packet-overflow-requires-bounded-expansion');
    assert.equal(oversized.blocker, 'unsupported');
    assert.equal(oversized.actions.length, 0);
    assert.ok(oversized.evidenceBytes <= 12 * 1024,
      'an unsupported packet still cannot exceed the semantic evidence budget');
    assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 12 * 1024,
      'the actual encoded observation must fit, including its evidenceBytes field');
    assert.equal(oversized.turn.partialAnswer, null);
    assert.ok(oversized.questionText?.startsWith('Q'.repeat(3900)),
      'retain the exact question when only incidental partial answer caused overflow');
    // Near 12 KiB, replacing evidenceBytes=0 with the actual byte count can
    // overflow an otherwise eligible exact question and its action.
    await page.evaluate(() => {
      document.querySelector('[data-codex-composer-request-navigation] h3')!.textContent =
        'Q'.repeat(1000);
    });
    const belowLimit = await adapter.observe(task);
    assert.equal(belowLimit.blocker, 'provider_question');
    const extraQuestionBytes = 12 * 1024 - 2 - belowLimit.evidenceBytes;
    assert.ok(extraQuestionBytes > 0 && extraQuestionBytes < 3000,
      'near-limit fixture must keep the exact provider question within the 4000-character cap');
    await page.evaluate(count => {
      document.querySelector('[data-codex-composer-request-navigation] h3')!.textContent =
        'Q'.repeat(count);
    }, 1000 + extraQuestionBytes);
    const nearLimit = await adapter.observe(task);
    assert.ok(Buffer.byteLength(JSON.stringify(nearLimit)) <= 12 * 1024,
      'the actual encoded semantic packet must fit even at the byte boundary');
    assert.equal(nearLimit.evidenceBytes, Buffer.byteLength(JSON.stringify(nearLimit)));
    assert.equal(nearLimit.blocker, 'provider_question',
      'an exact question remains actionable when the full serialized packet fits');
    assert.equal(nearLimit.actions.filter(action => action.purpose === 'answer_question').length, 1);
    assert.ok(nearLimit.questionText?.startsWith('Q'.repeat(1000 + extraQuestionBytes)));
    // Visible exact-work HostSpan permission is an agent review barrier,
    // never an authorization created by page text or an auto-Allow click.
    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">Original task</div>' +
      '<div role="alert">hostspan-git requests access to repository read ' +
      '<button type="button" onclick="window.grants++">Allow once</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>' +
      '<script>window.grants=0;</script>');
    const permission = await adapter.observe(context(lease, 'user-b'));
    assert.equal(permission.blocker, 'provider_permission');
    assert.equal(permission.actions.length, 0, 'permission effects/arguments need explicit review');
    assert.equal(permission.permission?.appName, 'hostspan-git');
    assert.equal(permission.permission?.toolName, null, 'do not guess a tool from prose');
    assert.equal(permission.permission?.detailState, 'not_visible');
    assert.equal(permission.permission?.canGrant, false);
    assert.equal(await page.evaluate(() => (window as any).grants), 0);

    assert.equal((await inspectSemanticHostSpanPermission(page, 'user-b'))?.appName, 'hostspan-git');
    const legacyUser = page.locator('[data-message-author-role="user"]');
    await legacyUser.evaluate(node => node.setAttribute('data-dil-message-id', 'other-user'));
    assert.equal(await inspectSemanticHostSpanPermission(page, 'user-b'), null,
      'conflicting DIL ID cannot borrow the requested user identity');
    await legacyUser.evaluate(node => {
      node.setAttribute('data-message-id', 'other-user');
      node.setAttribute('data-dil-message-id', 'user-b');
    });
    assert.equal(await inspectSemanticHostSpanPermission(page, 'user-b'), null,
      'a foreign message cannot borrow the requested DIL identity');

    // The live DIL renderer places the user ID on an ancestor search group,
    // not on the visible user bubble; a real permission card must still bind.
    await page.setContent(`<main>
      <section data-talvt-turn-state="complete">
        <div data-chatgpt-search-unit-key="user-b:user" data-chatgpt-search-message-ids="user-b">
          <div data-user-message-bubble="true">Original task</div>
        </div>
        <div data-chatgpt-search-unit-key="answer-b:assistant" data-chatgpt-search-message-ids="answer-b">
          <div data-chatgpt-selection-message-id="answer-b">
            <div data-dil-message-id="answer-b">OK</div>
          </div>
        </div>
      </section>
      <div role="alert">hostspan-git requests access to repository read
        <button type="button">Allow once</button>
      </div>
      <div id="prompt-textarea" contenteditable="true"></div>
      <button data-testid="send-button">Send</button>
    </main>`);
    const dilPermission = await adapter.observe(context(lease, 'user-b'));
    assert.equal(dilPermission.blocker, 'provider_permission');
    assert.equal(dilPermission.permission?.appName, 'hostspan-git');
    assert.equal(dilPermission.permission?.canGrant, false);
    await page.evaluate(() => document.querySelector('[data-chatgpt-search-message-ids]')!
      .setAttribute('data-chatgpt-search-message-ids', 'user-b other-user'));
    const ambiguousDilPermission = await adapter.observe(context(lease, 'user-b'));
    assert.equal(ambiguousDilPermission.permission, null,
      'multiple ancestor message IDs cannot grant the original user identity');
    await page.evaluate(() => {
      const group = document.querySelector('[data-chatgpt-search-message-ids]')!;
      group.setAttribute('data-chatgpt-search-message-ids', 'user-b');
      group.setAttribute('data-chatgpt-search-unit-key', 'answer-b:assistant');
    });
    assert.equal((await adapter.observe(context(lease, 'user-b'))).permission, null,
      'assistant search groups cannot anchor a user permission');

    // A visible sensitive argument is not silently shortened or leaked to
    // the agent packet. Redaction makes grant ineligible by construction.
    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="user-b">Original task</div>' +
      '<div role="alert">hostspan-git requests access ' +
      '<pre>{"api_key":"synthetic-secret-123456789"}</pre>' +
      '<button type="button">Allow once</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>');
    const protectedPermission = await adapter.observe(context(lease, 'user-b'));
    assert.equal(protectedPermission.blocker, 'provider_permission');
    assert.equal(protectedPermission.permission?.detailState, 'redacted');
    assert.equal(protectedPermission.permission?.canGrant, false);
    assert.equal(JSON.stringify(protectedPermission).includes('synthetic-secret-123456789'), false);
    assert.equal(protectedPermission.actions.length, 0);

    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">' +
      'Quoted untrusted text: hostspan-git Allow once</div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>');
    const quoted = await adapter.observe(context(lease, 'user-b'));
    assert.notEqual(quoted.blocker, 'provider_permission',
      'untrusted user text is not a real permission barrier');
    assert.equal(quoted.permission, null);
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
  const unknownTurn = await new ChatGptSemanticAdapter(options).recover({
    context: { ...context(null, userId), submittedUserTurnId: null }, kind: 'final',
  });
  assert.deepEqual(unknownTurn, { kind: 'unavailable', reason: 'exact-submitted-user-turn-required' },
    'a canonical user message ID is not a substitute for its turn ID');
  assert.equal(reads, 0, 'unbound turn cannot trigger an authenticated backend read');
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
  const wrongPrompt = await new ChatGptSemanticAdapter(options).verify({ context: exact, kind: 'ack',
    prompt: 'Different question',
    attempts: [{ conversationId: cid, messageId: userId, parentMessageId: 'root',
      textHash: digest(prompt), observedAt: new Date(0).toISOString() }] });
  assert.deepEqual(wrongPrompt, {
    kind: 'unavailable', reason: 'canonical-ack-prompt-hash-mismatch',
  }, 'captured POST identity cannot prove an ACK for different query content');
  const invalid = await ackReader.verify({ context: exact, kind: 'ack', prompt });
  assert.equal(invalid.kind, 'unavailable', 'no attempt correlation cannot prove acceptance');
  assert.equal(reads, 4);
  const exactAttempt = { conversationId: cid, messageId: userId, parentMessageId: 'root',
    textHash: digest(prompt), observedAt: new Date(0).toISOString() };
  for (const mismatch of [
    { context: { ...exact, submittedUserMessageId: 'foreign-user' }, reason: 'canonical-ack-bound-message-mismatch' },
    { context: { ...exact, submittedUserTurnId: 'foreign-turn' }, reason: 'canonical-ack-bound-turn-mismatch' },
  ]) {
    const incompatible = await new ChatGptSemanticAdapter(options).recover({
      context: mismatch.context, kind: 'ack', prompt, attempts: [exactAttempt],
    });
    assert.deepEqual(incompatible, { kind: 'unavailable', reason: mismatch.reason },
      'an ACK for the captured POST cannot overwrite a conflicting bound identity');
  }
  assert.equal(reads, 6, 'known message conflict needs no GET; turn conflict requires canonical GET');
});
