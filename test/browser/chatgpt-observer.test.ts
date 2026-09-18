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

const CONVERSATION_ID = 'conversation-observer-123456';

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
