import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { conversationLoadSurface } from '../../src/providers/chatgpt/conversation-load-recovery.ts';

test('exact error-surface Retry is isolated from generation retries, drafts, barriers and stale state', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-load-surface-'));
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: new PageRegistry(), headless: true });
  try {
    await owner.start(); const { page } = await owner.createPage();
    await page.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<main></main>' }));
    await page.goto('https://chatgpt.com/c/fixture-conversation');
    const error = '<div><p>이 ChatGPT 대화를 불러올 수 없습니다</p><div><button onclick="window.clicks=(window.clicks||0)+1">다시 시도</button></div></div>';
    const inspect = (click = false, expiresAt = Date.now() + 5000) => page.evaluate(conversationLoadSurface,
      { origin: 'https://chatgpt.com', conversationId: 'fixture-conversation', click, expiresAt });
    await t.test('observed Korean load error clicks only its below-notice button', async () => {
      await page.setContent('<main>' + error + '</main>');
      assert.equal((await inspect()).kind, 'retry');
      assert.equal((await inspect(true)).clicked, true);
      assert.equal(await page.evaluate(() => (window as unknown as { clicks: number }).clicks), 1);
    });
    for (const [name, extra, expected] of [
      ['draft', '<textarea>retained draft</textarea>', 'manual-draft'],
      ['active generation', '<button aria-label="중지">Stop</button>', 'generation-active'],
      ['challenge', '<div role="dialog">Verify you are human</div>', 'verification-or-permission'],
      ['login', '<div role="dialog">Sign in</div>', 'verification-or-permission'],
      ['overlay', '<div style="position:fixed;inset:0;z-index:999;background:gray"></div>', 'load-retry-button-obscured'],
      ['service limitation', '<p>Too many requests</p>', 'service-limited'],
      ['mixed old answer', '<div data-message-author-role="assistant">Retained answer</div>', 'mixed-or-ambiguous-surface'],
    ]) {
      await t.test(name!, async () => {
        await page.setContent('<main>' + error + extra + '</main>');
        const surface = await inspect(true); assert.equal(surface.clicked, false); assert.equal(surface.reason, expected);
        if (name === 'draft') assert.equal(await page.locator('textarea').inputValue(), 'retained draft');
      });
    }
    await t.test('ordinary user/assistant words or a generation-error Retry never authorize load recovery', async () => {
      for (const role of ['user', 'assistant']) {
        await page.setContent(`<main><div data-message-author-role="${role}">${error}</div><textarea></textarea></main>`);
        assert.equal((await inspect(true)).clicked, false);
      }
      await page.setContent(`<main><div data-chatgpt-search-message-ids="old-turn"><div data-user-message-bubble>${error}</div></div><textarea></textarea></main>`);
      assert.equal((await inspect(true)).clicked, false);
      await page.setContent('<main><p>생각 실패</p><button>다시 시도</button><textarea></textarea></main>');
      assert.equal((await inspect(true)).clicked, false);
    });
    await t.test('missing/disabled/wrong-location buttons and expired leases do not click', async () => {
      for (const body of [error.replace(/<button.*?<\/button>/, ''), error.replace('<button ', '<button disabled '),
        '<button>다시 시도</button><p>이 ChatGPT 대화를 불러올 수 없습니다</p>']) {
        await page.setContent('<main>' + body + '</main>'); assert.equal((await inspect(true)).clicked, false);
      }
      await page.setContent('<main>' + error + '</main>');
      assert.equal((await inspect(true, Date.now() - 1)).reason, 'click-lease-expired');
    });
    await t.test('manual recovery or changed state between read and dispatch wins', async () => {
      await page.setContent('<main>' + error + '</main>'); assert.equal((await inspect()).kind, 'retry');
      await page.setContent('<main><div data-message-author-role="assistant">Retained final</div><textarea>new manual draft</textarea></main>');
      const recovered = await inspect(true); assert.equal(recovered.kind, 'normal'); assert.equal(recovered.clicked, false);
      assert.equal(await page.locator('textarea').inputValue(), 'new manual draft');
      await page.goto('https://chatgpt.com/c/another-conversation'); await page.setContent('<main>' + error + '</main>');
      assert.equal((await inspect(true)).reason, 'binding-url-changed');
    });
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
