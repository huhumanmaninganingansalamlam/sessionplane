import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';
import { observeChatGptDom } from '../../src/providers/chatgpt/dom-observer.ts';

test('adopted exact background observation restores rendering without selecting a tab or changing its request', async t => {
  // Core adoption skips Playwright defaults on retained pages.
  const connect = chromium.connectOverCDP.bind(chromium);
  t.mock.method(chromium, 'connectOverCDP', (endpoint: string, options: object) =>
    connect(endpoint, { ...options, noDefaults: true }));
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-adopted-observation-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: root, pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const human = await owner.createPage();
    await human.page.bringToFront();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
    await page.goto('https://chatgpt.com/c/background-fixture');
    registry.bindPage(binding.pageKey, { sessionId: 'original', generation: 1, conversationId: 'background-fixture' });
    const session: SessionSnapshot = { requestOk: true, teamId: 'team', roleId: 'role', roleKey: 'main',
      sessionId: 'original', predecessorSessionId: null, provider: 'chatgpt', generation: 1,
      sessionState: 'observing', providerState: 'generating', observationTransport: 'fresh',
      terminal: false, waitExpired: false, nextCheckAt: null, conversationId: 'background-fixture',
      pageKey: binding.pageKey, submittedUserMessageId: 'original-user', submittedUserTurnId: 'original-user',
      responseMessageId: null, answerText: null, reason: null, errorCode: null, promptSubmitted: true };
    const original = { ...session };
    const adapter = new ChatGptAdapter({ browserOwner: owner, pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/', acknowledgementTimeoutMs: 500 });
    await page.setContent('<main><div data-message-author-role="user" data-message-id="original-user">Original</div><textarea>Retained draft</textarea></main>');
    assert.equal(await page.evaluate(() => document.visibilityState), 'hidden');
    await page.evaluate(() => {
      requestAnimationFrame(() => {
        const answer = document.createElement('div');
        answer.dataset.messageAuthorRole = 'assistant'; answer.dataset.messageId = 'exact-final';
        answer.dataset.endTurn = 'true'; answer.textContent = 'Original result';
        document.querySelector('main')!.append(answer);
      });
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal((await observeChatGptDom(page, session)).candidate, null, 'Hidden retained page has not rendered the result');
    t.mock.method(page, 'bringToFront', async () => { assert.fail('Observation must not select the tab'); });
    const source = await adapter.openObservation({ session, generation: 1 });
    try {
      await page.waitForFunction(() => document.querySelector('[data-message-id="exact-final"]') !== null,
        undefined, { polling: 50, timeout: 2_000 });
      assert.equal((await source.observe()).candidate?.responseMessageId, 'exact-final');
      assert.equal(await human.page.evaluate(() => document.visibilityState), 'visible', 'Human foreground stays selected');
      assert.equal(await page.locator('textarea').inputValue(), 'Retained draft');
      assert.deepEqual(session, original);
      await assert.rejects(adapter.openObservation({ session: { ...session, sessionId: 'foreign' }, generation: 1 }), /ownership/);
    } finally { await source.close(); }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
