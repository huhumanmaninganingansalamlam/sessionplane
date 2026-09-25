import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';
import { observeChatGptDom } from '../../src/providers/chatgpt/dom-observer.ts';
import { ExactFinalTracker } from '../../src/providers/chatgpt/exact-final.ts';
import { recoverChatGptAcknowledgement } from '../../src/providers/chatgpt/submission.ts';

const CONVERSATION_ID = 'conversation-observer-123456';

test('current ChatGPT message units recover the exact submitted turn and answer', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-message-units-'));
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: new PageRegistry(),
    headless: true,
  });
  try {
    await owner.start();
    const { page } = await owner.createPage();
    await page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: `
        <div data-chatgpt-search-message-ids="user-exact">
          <div data-user-message-bubble="true">Question</div>
        </div>
        <div data-chatgpt-search-message-ids="answer-exact answer-exact">
          <h4 data-conversation-role="assistant">Answer</h4>
          <div data-chatgpt-selection-message-id="answer-exact"><div class="markdown">Result</div></div>
        </div>
      ` });
    });
    await page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    const acknowledgement = await recoverChatGptAcknowledgement(page, 'Question', CONVERSATION_ID);
    assert.equal(acknowledgement?.submittedUserMessageId, 'user-exact');
    const observation = await observeChatGptDom(page, {
      submittedUserMessageId: acknowledgement?.submittedUserMessageId ?? null,
      submittedUserTurnId: acknowledgement?.submittedUserTurnId ?? null,
    });
    assert.equal(observation.submittedUserFound, true);
    assert.equal(observation.candidate?.responseMessageId, 'answer-exact');
    assert.equal(observation.candidate?.answerText, 'Result');
    await page.setContent(`<main>
      <aside role="alert"><button>Earlier notice</button></aside>
      <div data-message-author-role="user" data-message-id="user-exact">Question</div>
    </main>`);
    const identity = { submittedUserMessageId: 'user-exact', submittedUserTurnId: null };
    assert.equal((await observeChatGptDom(page, identity)).actionableAlert, false);
    await page.locator('main').evaluate((main) => {
      const alert = document.createElement('aside');
      alert.setAttribute('role', 'alert');
      alert.innerHTML = '<span>Provider notice</span><button>Action</button>';
      main.append(alert);
    });
    assert.equal((await observeChatGptDom(page, identity)).actionableAlert, true);
    await page.locator('main').evaluate((main) => {
      const response = document.createElement('div');
      response.setAttribute('data-message-author-role', 'assistant');
      response.setAttribute('data-message-id', 'partial-answer');
      response.textContent = 'Partial response';
      main.insertBefore(response, main.lastElementChild);
    });
    const interrupted = await observeChatGptDom(page, identity);
    assert.equal(interrupted.actionableAlert, true);
    assert.equal(interrupted.candidate?.responseMessageId, 'partial-answer');
    assert.equal((await observeChatGptDom(page, { ...identity, submittedUserMessageId: 'other-turn' })).actionableAlert, false);

  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT WEB redirect follows only the exact submitted user turn', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-redirect-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });
  const webId = 'WEB:11111111-1111-4111-8111-111111111111';
  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: route.request().url().includes('other-conversation')
          ? observerFixture()
              .replaceAll('user-message-1', 'different-user')
              .replaceAll('user-turn-1', 'different-turn')
          : observerFixture(),
      });
    });
    await created.page.goto(`https://chatgpt.com/c/${webId}`);
    registry.bindPage(created.binding.pageKey, {
      sessionId: 'session-observer',
      generation: 1,
      conversationId: webId,
    });
    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500,
    });
    const source = await adapter.openObservation({
      session: { ...sessionSnapshot(created.binding.pageKey), conversationId: webId },
      generation: 1,
    });
    try {
      await created.page.goto('https://chatgpt.com/c/other-conversation');
      const wrong = await source.observe();
      assert.equal(wrong.observationTransport, 'stale');

      await created.page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
      const exact = await source.observe();
      assert.equal(exact.observationTransport, 'fresh');
      assert.equal(exact.submittedUserFound, true);
      assert.equal(exact.conversationId, CONVERSATION_ID);
    } finally {
      source.close();
    }

    await created.page.close();
    const restored = await owner.createPage();
    await restored.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: observerFixture() });
    });
    registry.reservePage(restored.binding.pageKey, {
      sessionId: 'session-observer',
      generation: 1,
      conversationId: null,
    });
    await restored.page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    const recovered = await adapter.recoverAcknowledgement({
      session: { ...sessionSnapshot(restored.binding.pageKey), conversationId: webId },
      generation: 1,
      prompt: 'Question',
    });
    assert.equal(recovered?.conversationId, CONVERSATION_ID);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('background ChatGPT Page yields exact DOM, dialog, and network evidence without focus switching', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-observer-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const target = await owner.createPage();
    await target.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: observerFixture(),
      });
    });
    await target.page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    registry.bindPage(target.binding.pageKey, {
      sessionId: 'session-observer',
      generation: 1,
      conversationId: CONVERSATION_ID,
    });

    const foreground = await owner.createPage();
    await foreground.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>foreground</main>' });
    });
    await foreground.page.goto('https://chatgpt.com/');

    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500,
    });
    const source = await adapter.openObservation({
      session: sessionSnapshot(target.binding.pageKey),
      generation: 1,
    });

    try {
      const streaming = await source.observe();
      assert.equal(streaming.submittedUserFound, true);
      assert.equal(streaming.laterUserFound, false);
      assert.equal(streaming.candidate?.responseMessageId, 'assistant-message-1');
      assert.equal(streaming.candidate?.streamingMarker, true);
      assert.equal(streaming.activity, 'strong');
      assert.equal(streaming.dialogKind, null);

      const wakeForFinal = source.waitForWake(1_000);
      await target.page.evaluate(() => {
        const assistant = document.querySelector<HTMLElement>('#assistant-message');
        if (assistant === null) throw new Error('assistant fixture missing');
        assistant.setAttribute('data-message-status', 'finished_successfully');
        assistant.setAttribute('data-is-streaming', 'false');
        const content = assistant.querySelector<HTMLElement>('.markdown');
        if (content === null) throw new Error('assistant content fixture missing');
        content.textContent = 'The answer discusses rate limit wording as ordinary content.';
      });
      assert.equal(await wakeForFinal, 'dom');

      const finished = await source.observe();
      assert.equal(finished.dialogKind, null);
      assert.equal(finished.activity, 'weak', 'the leftover stop control is not exact strong activity');
      const final = new ExactFinalTracker(1_000).evaluate(finished, Date.now());
      assert.equal(final.kind, 'complete');
      assert.equal(final.answerText, 'The answer discusses rate limit wording as ordinary content.');

      const wakeForDialog = source.waitForWake(1_000);
      await target.page.evaluate(() => {
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.textContent = "You've reached your usage limit. Try again later.";
        document.body.appendChild(dialog);
      });
      assert.equal(await wakeForDialog, 'dom');
      const blocked = await source.observe();
      assert.equal(blocked.dialogKind, 'rate_limit');

      await target.page.evaluate(() => {
        document.querySelector('[role="dialog"]')?.remove();
        document.querySelector('#assistant-message')?.remove();
        document.querySelector('[data-testid="stop-button"]')?.remove();
      });
      await source.observe();
      const networkWake = source.waitForWake(1_000);
      await target.page.evaluate(async () => {
        await fetch('/backend-api/conversation/test');
      });
      assert.equal(await networkWake, 'network');
      const networkOnly = await source.observe();
      assert.equal(networkOnly.networkActivity, true);
      assert.equal(networkOnly.candidate, null);

      await target.page.evaluate(() => {
        const user = document.createElement('article');
        user.setAttribute('data-message-author-role', 'user');
        user.setAttribute('data-message-id', 'later-user-message');
        user.setAttribute('data-turn-id', 'later-user-turn');
        user.textContent = 'A later user turn';
        document.body.appendChild(user);
      });
      const laterUser = await source.observe();
      assert.equal(laterUser.laterUserFound, true);

      await target.page.setContent('<main><h1>Conversation cannot be displayed</h1></main>');
      await target.page.route('**/backend-api/conversations/**', (route) =>
        route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }));
      await target.page.evaluate(async () => { await fetch('/backend-api/conversations/unrelated'); });
      assert.equal((await source.observe()).errorCode, undefined);
      await target.page.evaluate(async (id) => { await (await fetch('/backend-api/conversations/' + id)).text(); }, CONVERSATION_ID);
      const unreadable = await source.observe();
      assert.equal(unreadable.errorCode, 'provider.conversation-unavailable');
      assert.equal(unreadable.observationTransport, 'unavailable');
      assert.equal(new ExactFinalTracker(1_000).evaluate(unreadable, Date.now()).kind, 'unverified');
      await target.page.setContent(observerFixture());
      const restored = await source.observe();
      assert.equal(restored.errorCode, undefined);
      assert.equal(restored.submittedUserFound, true);

      assert.equal(foreground.page.url(), 'https://chatgpt.com/');
      assert.equal(target.page.url(), `https://chatgpt.com/c/${CONVERSATION_ID}`);
    } finally {
      source.close();
    }
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT DOM ignores request placeholders until a real assistant message exists', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-placeholder-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.setContent(`
      <article data-message-author-role="user" data-message-id="user-message-1" data-turn-id="user-turn-1">
        <div class="markdown">Question</div>
      </article>
      <article
        id="assistant-placeholder"
        data-message-author-role="assistant"
        data-message-id="request-placeholder-request-conversation-0"
      >
        <div class="markdown">생각 중...</div>
      </article>
    `);

    const placeholder = await observeChatGptDom(created.page, {
      submittedUserMessageId: 'user-message-1',
      submittedUserTurnId: 'user-turn-1',
    });
    assert.equal(placeholder.submittedUserFound, true);
    assert.equal(placeholder.candidate, null);

    await created.page.evaluate(() => {
      const assistant = document.querySelector<HTMLElement>('#assistant-placeholder');
      if (assistant === null) throw new Error('assistant placeholder missing');
      assistant.setAttribute('data-message-id', 'assistant-final-1');
      const content = assistant.querySelector<HTMLElement>('.markdown');
      if (content === null) throw new Error('assistant content missing');
      content.textContent = 'Final answer';
    });
    const final = await observeChatGptDom(created.page, {
      submittedUserMessageId: 'user-message-1',
      submittedUserTurnId: 'user-turn-1',
    });
    assert.equal(final.candidate?.responseMessageId, 'assistant-final-1');
    assert.equal(final.candidate?.answerText, 'Final answer');
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function sessionSnapshot(pageKey: string): SessionSnapshot {
  return {
    requestOk: true,
    teamId: '11111111-1111-4111-8111-111111111111',
    roleId: '22222222-2222-4222-8222-222222222222',
    roleKey: 'main',
    sessionId: 'session-observer',
    predecessorSessionId: null,
    provider: 'chatgpt',
    generation: 1,
    sessionState: 'submitted',
    providerState: 'generating',
    observationTransport: 'fresh',
    terminal: false,
    waitExpired: false,
    nextCheckAt: null,
    conversationId: CONVERSATION_ID,
    pageKey,
    submittedUserMessageId: 'user-message-1',
    submittedUserTurnId: 'user-turn-1',
    responseMessageId: null,
    answerText: null,
    reason: null,
    errorCode: null,
    promptSubmitted: true,
  };
}

function observerFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <article data-message-author-role="user" data-message-id="user-message-1" data-turn-id="user-turn-1">
          <div class="markdown">Question</div>
        </article>
        <article
          id="assistant-message"
          data-message-author-role="assistant"
          data-message-id="assistant-message-1"
          data-turn-id="assistant-turn-1"
          data-message-status="in_progress"
          data-is-streaming="true"
        >
          <div class="markdown">Partial answer</div>
        </article>
        <button data-testid="stop-button" type="button">Stop</button>
      </body>
    </html>`;
}
