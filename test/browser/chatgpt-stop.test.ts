import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';

const CONVERSATION_ID = 'conversation-stop-123456';

test('ChatGPT stop validates the exact owned Page and clicks the stop control once', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-stop-'));
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
        body: `<!doctype html><html><body>
          <button data-testid="stop-button" type="button">Stop</button>
          <script>
            window.stopCount = 0;
            document.querySelector('[data-testid="stop-button"]').addEventListener('click', () => {
              window.stopCount += 1;
            });
          </script>
        </body></html>`,
      });
    });
    await target.page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    registry.bindPage(target.binding.pageKey, {
      sessionId: 'session-stop',
      generation: 1,
      conversationId: CONVERSATION_ID,
    });

    const other = await owner.createPage();
    await other.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>other</main>' });
    });
    await other.page.goto('https://chatgpt.com/');

    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500,
    });
    const operation = await adapter.openStop({
      session: snapshot(target.binding.pageKey),
      generation: 1,
    });
    assert.equal(await operation.prepare(), true);
    await operation.stopOnce();
    assert.equal(
      await target.page.evaluate(() => (window as Window & { stopCount: number }).stopCount),
      1,
    );
    assert.equal(other.page.url(), 'https://chatgpt.com/');

    await target.page.goto('https://chatgpt.com/c/another-stop-conversation');
    await assert.rejects(operation.stopOnce(), /ownership does not match/);
    assert.equal(other.page.url(), 'https://chatgpt.com/');
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT stop reports no mutation when the exact control is absent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-stop-absent-'));
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
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>quiet</main>' });
    });
    await target.page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    registry.bindPage(target.binding.pageKey, {
      sessionId: 'session-stop',
      generation: 1,
      conversationId: CONVERSATION_ID,
    });
    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500,
    });
    const operation = await adapter.openStop({
      session: snapshot(target.binding.pageKey),
      generation: 1,
    });
    assert.equal(await operation.prepare(), false);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshot(pageKey: string): SessionSnapshot {
  return {
    requestOk: true,
    teamId: '11111111-1111-4111-8111-111111111111',
    roleId: '22222222-2222-4222-8222-222222222222',
    roleKey: 'main',
    sessionId: 'session-stop',
    predecessorSessionId: null,
    provider: 'chatgpt',
    generation: 1,
    sessionState: 'observing',
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
