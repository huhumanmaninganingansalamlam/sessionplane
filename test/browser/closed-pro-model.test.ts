import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { ChatGptSemanticAdapter } from '../../src/providers/chatgpt/semantic-adapter.ts';
import { inspectSemanticChatGptModelMenu } from '../../src/providers/chatgpt/semantic-model-menu.ts';

function fixtureDocument(display: string, options: {
  readonly openerLabel?: string;
  readonly expanded?: string;
  readonly state?: string;
  readonly extra?: string;
} = {}): string {
  return '<meta charset="utf-8"><main><section data-chatgpt-composer>' +
    '<div id="prompt-textarea" contenteditable="true" role="textbox"></div>' +
    '<button type="button" id="radix-model-picker" aria-haspopup="menu" ' +
    'aria-label="' + (options.openerLabel ?? 'ChatGPT 모델 선택') + '" ' +
    'aria-expanded="' + (options.expanded ?? 'false') + '" ' +
    'data-state="' + (options.state ?? 'closed') + '">' +
    '<span>' + display + '</span><svg aria-hidden="true"></svg></button>' +
    '<button type="button" data-testid="send-button">Send</button>' +
    (options.extra ?? '') + '</section></main>';
}

test('exact Pro badge on a closed authenticated composer picker survives compose and permits a planned root submit action', {
  timeout: 50_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sessionplane-closed-pro-badge-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(dir, 'disposable-chromium-profile'),
    pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      status: 200, contentType: 'text/html',
      body: fixtureDocument('추론 수준<br>Pro'),
    }));
    await page.goto('https://chatgpt.com/');
    const identity = {
      projectId: 'own-project', slotId: 'main', slotRevision: 1,
      taskId: 'own-initial', pageKey: binding.pageKey,
      targetId: registry.getBinding(binding.pageKey).targetId!,
      bindingEpoch: registry.getBinding(binding.pageKey).bindingEpoch,
    };
    const context = {
      ...identity, providerConversationId: null,
      submittedUserMessageId: null, submittedUserTurnId: null,
      pageLease: identity, requiredModel: 'Pro',
    };
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: actual => actual === identity,
      resolvePage: () => page,
    });

    const firstMenu = await inspectSemanticChatGptModelMenu(page);
    assert.equal(firstMenu?.status, 'closed');
    assert.equal(firstMenu?.strategy, 'composer-radix');
    assert.equal(firstMenu?.verifiedReasoningLevel, 'Pro');

    const first = await adapter.observe(context);
    assert.equal(first.surface, 'chat');
    assert.equal(first.verifiedModel, null, 'Pro effort is not a model radio');
    assert.equal(first.verifiedReasoningLevel, 'Pro');
    assert.ok(first.actions.some(action => action.purpose === 'compose'),
      'A closed but exact Pro badge must not block the root composer');
    assert.equal(first.actions.some(action => action.purpose === 'submit'), false,
      'A blank editor must never be submitted');

    await page.locator('#prompt-textarea').fill('Exact one-time root question');
    const second = await adapter.observe(context);
    assert.equal(second.verifiedModel, null);
    assert.equal(second.verifiedReasoningLevel, 'Pro',
      'The exact chosen reasoning level remains verified when the menu is closed');
    assert.ok(second.actions.some(action => action.purpose === 'submit'),
      'Exactly one prepared initial root may expose a submit choice');
    assert.equal(second.actions.filter(action => action.purpose === 'submit').length, 1);
    assert.equal(await page.locator('#prompt-textarea').innerText(),
      'Exact one-time root question');
  } finally {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pro in unrelated elements, ambiguous picker state and other visible models cannot authorize root send', {
  timeout: 55_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sessionplane-invalid-closed-pro-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(dir, 'disposable-chromium-profile'),
    pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      status: 200, contentType: 'text/html',
      body: fixtureDocument('추론 수준<br>Instant'),
    }));
    await page.goto('https://chatgpt.com/');
    const identity = {
      projectId: 'own-project', slotId: 'main', slotRevision: 1,
      taskId: 'own-initial', pageKey: binding.pageKey,
      targetId: registry.getBinding(binding.pageKey).targetId!,
      bindingEpoch: registry.getBinding(binding.pageKey).bindingEpoch,
    };
    const context = {
      ...identity, providerConversationId: null,
      submittedUserMessageId: null, submittedUserTurnId: null,
      pageLease: identity, requiredModel: 'Pro',
    };
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: actual => actual === identity,
      resolvePage: () => page,
    });
    const cases = [
      fixtureDocument('추론 수준<br>Instant',
        { extra: '<article>Pro</article>' }),
      fixtureDocument('추론 수준<br>Medium'),
      fixtureDocument('추론 수준<br>Pro Extra'),
      fixtureDocument('추론 수준<br>Pro',
        { openerLabel: 'Model selector elsewhere' }),
      fixtureDocument('추론 수준<br>Pro',
        { expanded: 'true', state: 'closed' }),
      fixtureDocument('추론 수준<br>Pro',
        { expanded: 'false', state: 'open' }),
    ];
    for (const document of cases) {
      await page.setContent(document);
      await page.locator('#prompt-textarea').fill('Cannot submit if Pro is not exact');
      const menu = await inspectSemanticChatGptModelMenu(page);
      assert.notEqual(menu?.verifiedReasoningLevel ?? null, 'Pro');
      const result = await adapter.observe(context);
      assert.equal(result.verifiedModel, null);
      assert.notEqual(result.verifiedReasoningLevel, 'Pro');
      assert.equal(result.actions.some(action => action.purpose === 'submit'), false,
        'Unrelated or ambiguous Pro text cannot authorize the initial POST');
    }
  } finally {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
