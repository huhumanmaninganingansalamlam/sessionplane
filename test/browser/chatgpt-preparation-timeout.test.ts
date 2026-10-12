import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ChatGptSubmission } from '../../src/providers/chatgpt/submission.ts';
import { prepareFixture } from '../helpers/preparation-fixture.ts';

test('abandoned preparation preserves the owned page/draft and cannot resume input or submit after a stalled command', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-preparation-abandon-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body:
      '<textarea id="prompt-textarea">preserved draft</textarea><button data-testid="send-button" onclick="document.body.dataset.sent=\'yes\'">Send</button>' }));
    await page.goto('https://chatgpt.com/c/preparation-timeout');
    registry.refreshPage(binding.pageKey);
    registry.reservePage(binding.pageKey, { sessionId: 'owned-session', generation: 3, conversationId: 'preparation-timeout' });
    const session = { requestOk: true, teamId: 'team', roleId: 'role', roleKey: 'primary',
      sessionId: 'owned-session', predecessorSessionId: null, provider: 'chatgpt', generation: 3,
      sessionState: 'submitting', providerState: 'pending', observationTransport: 'fresh', terminal: false,
      waitExpired: false, nextCheckAt: null, conversationId: 'preparation-timeout', pageKey: binding.pageKey,
      submittedUserMessageId: null, submittedUserTurnId: null, responseMessageId: null, answerText: null,
      reason: null, errorCode: null, promptSubmitted: false } satisfies SessionSnapshot;
    const submission = new ChatGptSubmission({ page, pageKey: binding.pageKey, pageRegistry: registry,
      request: { session, generation: 3, prompt: 'replacement prompt', model: null }, acknowledgementTimeoutMs: 500 });
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const press = page.keyboard.press.bind(page.keyboard);
    const keys: string[] = [];
    page.keyboard.press = async (key, options) => {
      keys.push(key);
      if (keys.length === 1) { reached.resolve(); await release.promise; }
      await press(key, options);
    };
    const pending = prepareFixture(submission, page);
    const rejected = assert.rejects(pending, /Preparation was abandoned/);
    await reached.promise;
    submission.abandon();
    release.resolve();
    await rejected;
    assert.equal(page.isClosed(), false);
    assert.equal(submission.preparationStage, 'composer-select-all');
    assert.equal(registry.requireSessionPage(binding.pageKey, {
      sessionId: session.sessionId, generation: 3, conversationId: session.conversationId }), page);
    assert.equal(await page.locator('#prompt-textarea').inputValue(), 'preserved draft');
    assert.equal(keys.length, 1, 'no Backspace or input continuation after the pending command settles');
    await assert.rejects(submission.submitOnce(), /Preparation was abandoned/);
    assert.equal(await page.locator('body').getAttribute('data-sent'), null);

    // A stalled passive auth response must not consume the outer 120s preparation deadline.
    const authReply = Promise.withResolvers<void>();
    await page.route('https://chatgpt.com/api/auth/session', async route => {
      await authReply.promise;
      await route.fulfill({ json: {} }).catch(() => undefined);
    });
    const next = new ChatGptSubmission({ page, pageKey: binding.pageKey, pageRegistry: registry,
      request: { session, generation: 3, prompt: 'replacement prompt', model: null }, acknowledgementTimeoutMs: 500 });
    const fallback = setTimeout(() => authReply.resolve(), 9_000);
    const started = Date.now();
    try {
      await next.prepareForObservation();
      assert.ok(Date.now() - started < 8_000, 'passive auth fetch must end before the outer preparation deadline');
      assert.equal(page.isClosed(), false);
      assert.equal(await page.locator('#prompt-textarea').inputValue(), 'preserved draft');
    } finally { clearTimeout(fallback); authReply.resolve(); }

  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});
