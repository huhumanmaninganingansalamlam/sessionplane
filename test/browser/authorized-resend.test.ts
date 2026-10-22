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
    await page.locator('main').evaluate(element => element.insertAdjacentHTML('afterbegin',
      '<article data-chatgpt-search-message-ids="old-code"><div role="textbox" contenteditable="true" aria-label="코드 편집">Earlier response code</div></article>'));
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
    // Burncore150: ProseMirror paragraphs add layout newlines to innerText,
    // while the exact authored block text already passed preparation.
    await page.setContent('<main><div role="textbox" contenteditable="true"><p>Original follow-up</p><p><br></p><p>Second line</p></div></main>');
    const multilinePrompt = 'Original follow-up\n\nSecond line';
    const preparedHtml = await page.content();
    assert.notEqual(await page.locator('[role="textbox"]').innerText(), multilinePrompt);
    await ui.verifyAuthorizedResend(current, original, multilinePrompt, true);
    assert.equal(await page.content(), preparedHtml);
    const unknown = { ...current, submissionState: 'submission_unknown' as const };
    await ui.verifyAuthorizedResend(unknown, unknown, multilinePrompt, false);
    assert.equal(await page.content(), preparedHtml, 'An authorized original UNKNOWN draft is inspected without rewriting');
    await assert.rejects(ui.verifyAuthorizedResend(unknown, unknown, multilinePrompt + ' edited', false));
    await assert.rejects(ui.verifyAuthorizedResend(current, original, multilinePrompt + ' edited', true),
      (error: unknown) => {
        const details = (error as { details: { blockingReasons: string[] } }).details;
        assert.deepEqual(details.blockingReasons, ['separate-draft']);
        return true;
      });
    await page.setContent('<main><div data-message-author-role="user" data-message-id="older-continue">계속</div><textarea id="prompt-textarea">계속</textarea></main>');
    const followupHtml = await page.content();
    const transcriptHash = await ui.verifyAuthorizedResend(unknown, unknown, '계속', false, true);
    assert.equal(await page.content(), followupHtml, 'A new explicit follow-up neither borrows an older ACK nor clears its exact draft');
    await assert.rejects(ui.verifyAuthorizedResend(unknown, unknown, '계속', false), /matching-user-message/);
    await page.locator('main').evaluate(e => e.insertAdjacentHTML('afterbegin',
      '<aside role="alert">Refresh and check whether the message was processed before sending again</aside>'));
    await ui.verifyAuthorizedResend(unknown, unknown, '계속', false, true);
    await ui.verifyAuthorizedResend(unknown, unknown, '계속', true, true, transcriptHash);
    await page.locator('main').evaluate(e => e.insertAdjacentHTML('afterbegin',
      '<div data-message-author-role="user" data-message-id="human-new-continue">계속</div>'));
    await assert.rejects(ui.verifyAuthorizedResend(unknown, unknown, '계속', true, true, transcriptHash), /transcript changed/);
    for (const html of [
      '<div role="dialog">Sign in to continue</div><textarea id="prompt-textarea">계속</textarea>',
      '<div role="alert">HostSpan Process Start<button>한 번만 허용</button></div><textarea id="prompt-textarea">계속</textarea>',
      '<button data-testid="stop-button">Stop</button><textarea id="prompt-textarea">계속</textarea>',
      '<textarea id="prompt-textarea">A different user draft</textarea>',
    ]) {
      await page.setContent(`<main>${html}</main>`);
      const preserved = await page.content();
      await assert.rejects(ui.verifyAuthorizedResend(unknown, unknown, '계속', false, true));
      assert.equal(await page.content(), preserved, 'Explicit user input cannot bypass a provider refusal, activity or another draft');
    }
    await assert.rejects(ui.verifyAuthorizedResend({ ...current, sessionId: 'other-owner' }, original, 'Original follow-up', true));
    assert.equal(requests, 1, 'Only the isolated initial route: no refresh, authentication probe, submit or navigation');
    assert.equal(registry.getBinding(binding.pageKey).sessionId, 'exact-session');
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
