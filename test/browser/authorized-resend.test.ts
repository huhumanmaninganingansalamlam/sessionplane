import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { SessionUiService } from '../../src/core/session-ui-service.ts';
import type { SubmissionService } from '../../src/core/submission-service.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';

test('approved resend display guard preserves drafts/selection and stops original evidence or activity without browser mutation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-resend-display-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    let requests = 0;
    await page.route('https://chatgpt.com/**', route => { requests++; return route.fulfill({ status: 200,
      contentType: 'text/html', body: '<main><div data-message-author-role="user" data-message-id="old-user">Earlier turn</div><textarea id="prompt-textarea"></textarea></main>' }); });
    await page.goto('https://chatgpt.com/c/resend-owned-conversation');
    registry.bindPage(binding.pageKey, { sessionId: 'exact-session', generation: 1, conversationId: 'resend-owned-conversation' });
    const current = { sessionId: 'exact-session', generation: 2, pageKey: binding.pageKey,
      conversationId: 'resend-owned-conversation', submittedUserMessageId: null, submittedUserTurnId: null } as SessionSnapshot;
    const original = { ...current, generation: 1, submittedUserMessageId: 'original-user', submittedUserTurnId: 'original-user' };
    const ui = new SessionUiService({ submissions: {} as SubmissionService, registry, chatgptUrl: 'https://chatgpt.com/' });
    await page.locator('textarea').fill('Original follow-up');
    await assert.rejects(ui.verifyAuthorizedResend(original, original, 'Original follow-up', false));
    await page.locator('textarea').fill('');
    ui.reserveResendPage(original, current);
    assert.equal(registry.getBinding(binding.pageKey).generation, 2);
    const baseline = await page.content();
    await ui.verifyAuthorizedResend(current, original, 'Original follow-up', false);
    assert.equal(await page.content(), baseline);
    for (const scenario of [
      { html: '<div data-message-author-role="user" data-message-id="original-user">Original follow-up</div>', draft: '' },
      { html: '<div data-message-author-role="user" data-message-id="original-user">Original follow-up</div><div data-message-author-role="assistant" data-message-id="late-final">Original final</div>', draft: '' },
      { html: '<div data-message-author-role="user" data-message-id="another-user">Original follow-up</div>', draft: '' },
      { html: '<button data-testid="stop-button">Stop</button>', draft: '' },
      { html: '<aside role="alert">Login required</aside>', draft: '' },
      { html: '', draft: 'User private draft' },
    ]) {
      await page.setContent(`<main>${scenario.html}<textarea id="prompt-textarea"></textarea></main>`);
      await page.locator('textarea').fill(scenario.draft);
      const before = await page.content();
      await assert.rejects(ui.verifyAuthorizedResend(current, original, 'Original follow-up', true));
      assert.equal(await page.content(), before);
      assert.equal(await page.locator('textarea').inputValue(), scenario.draft);
    }
    await page.setContent('<main><p id="selected">User selection</p><textarea id="prompt-textarea"></textarea></main>');
    await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector('#selected')!);
      window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range); });
    await assert.rejects(ui.verifyAuthorizedResend(current, original, 'Original follow-up', false));
    assert.equal(await page.evaluate(() => window.getSelection()!.toString()), 'User selection');
    await page.evaluate(() => window.getSelection()!.removeAllRanges());
    await page.locator('textarea').fill('Original follow-up');
    await ui.verifyAuthorizedResend(current, original, 'Original follow-up', false);
    await ui.verifyAuthorizedResend(current, original, 'Original follow-up', true);
    await assert.rejects(ui.verifyAuthorizedResend({ ...current, sessionId: 'other-owner' }, original, 'Original follow-up', true));
    assert.equal(requests, 1, 'Only the isolated initial route: no refresh, authentication probe, submit or navigation');
    assert.equal(registry.getBinding(binding.pageKey).sessionId, 'exact-session');
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
