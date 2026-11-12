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

function exactPowerFiveStepFixture(): string {
  return `
    <meta charset="utf-8">
    <main>
      <section data-chatgpt-composer>
        <div id="prompt-textarea" role="textbox" contenteditable="true"></div>
        <button id="radix-model-picker" type="button" aria-label="ChatGPT 모델 선택"
          aria-haspopup="menu" aria-expanded="true" data-state="open"
          aria-controls="radix-menu">추론 수준 Medium</button>
        <button data-testid="send-button" type="button">Send</button>
      </section>
      <div id="radix-menu" role="menu" data-state="open"
        aria-labelledby="radix-model-picker"
        style="position:absolute;top:55px;left:15px;width:350px;height:150px;z-index:12;background:white">
        <div data-model-picker-view="advanced">
          <div id="power-view" aria-hidden="true" style="display:none">
            <div role="menuitem" aria-label="모델 선택">Medium</div>
            <span data-power-disabled="false">Medium</span>
            <span role="status" aria-live="polite">Medium, 5개 중 2번째입니다.</span>
            <div role="menuitem" aria-label="파워" data-reasoning-slider="true"
              aria-disabled="true" data-disabled="" style="width:250px;height:70px">
              <div data-model-picker-power-slider>
                <span aria-disabled="false" data-locked="false"
                  style="display:block;position:relative;width:240px;height:20px">
                  <span data-orientation="horizontal"
                    style="display:block;position:relative;width:240px;height:20px">
                    <div>
                      <span data-selected="true" style="position:absolute;left:0px;top:2px;width:16px;height:16px;background:#ddd"></span>
                      <span data-selected="true" style="position:absolute;left:55px;top:2px;width:16px;height:16px;background:#ddd"></span>
                      <span data-selected="false" style="position:absolute;left:110px;top:2px;width:16px;height:16px;background:#ddd"></span>
                      <span data-selected="false" style="position:absolute;left:165px;top:2px;width:16px;height:16px;background:#ddd"></span>
                      <span id="pro-power-tick" data-selected="false"
                        style="position:absolute;left:220px;top:2px;width:16px;height:16px;background:#ddd"></span>
                    </div>
                  </span>
                  <span role="slider" aria-hidden="true" aria-orientation="horizontal"
                    aria-valuemin="0" aria-valuemax="4" aria-valuenow="1"
                    style="position:absolute;top:2px;left:55px;width:16px;height:16px"></span>
                </span>
              </div>
            </div>
          </div>
          <div id="model-view" aria-hidden="false">
            <div role="menuitemradio" aria-checked="true">GPT-6</div>
            <div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div>
          </div>
        </div>
      </div>
    </main>
    <script>
      window.openerClicks = 0;
      window.proPowerClicks = 0;
      window.sendAttempts = 0;
      window.applyProChoice = true;
      document.querySelector('[data-testid="send-button"]').onclick = () => window.sendAttempts++;
      const opener = document.getElementById('radix-model-picker');
      const menu = document.getElementById('radix-menu');
      opener.addEventListener('click', event => {
        if (!event.isTrusted) return;
        window.openerClicks++;
        if (opener.getAttribute('aria-expanded') === 'true') {
          opener.setAttribute('aria-expanded', 'false');
          opener.setAttribute('data-state', 'closed');
          opener.removeAttribute('aria-controls');
          menu.style.display = 'none';
        } else {
          opener.setAttribute('aria-expanded', 'true');
          opener.setAttribute('data-state', 'open');
          opener.setAttribute('aria-controls', 'radix-menu');
          menu.style.display = 'block';
          document.getElementById('power-view').style.display = 'block';
          document.getElementById('power-view').setAttribute('aria-hidden', 'false');
          document.getElementById('model-view').style.display = 'none';
          document.getElementById('model-view').setAttribute('aria-hidden', 'true');
        }
      });
      document.getElementById('pro-power-tick').addEventListener('pointerdown', event => {
        if (!event.isTrusted) return;
        window.proPowerClicks++;
        if (!window.applyProChoice) return;
        opener.textContent = '추론 수준 Pro';
        document.querySelector('[data-power-disabled]').textContent = 'Pro';
        document.querySelector('[role=status]').textContent = 'Pro, 5개 중 5번째입니다.';
        document.querySelector('[role=slider]').setAttribute('aria-valuenow', '4');
        document.querySelectorAll('span[data-selected]').forEach(tick => {
          tick.setAttribute('data-selected', 'true');
        });
      });
    </script>
  `;
}

test('Pro effort on observed five-step pointer control needs exact decision, one trusted click, and closed literal Pro proof', {
  timeout: 50_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sessionplane-pro-power-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(dir, 'disposable-chromium-profile'),
    pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: exactPowerFiveStepFixture(),
    }));
    await page.goto('https://chatgpt.com/');
    const identity = {
      projectId: 'only-power-project', slotId: 'main', slotRevision: 1,
      taskId: 'one-original-root', pageKey: binding.pageKey,
      targetId: registry.getBinding(binding.pageKey).targetId!,
      bindingEpoch: registry.getBinding(binding.pageKey).bindingEpoch,
    };
    const task = {
      ...identity, providerConversationId: null,
      submittedUserMessageId: null, submittedUserTurnId: null,
      pageLease: identity, requiredModel: 'Pro',
    };
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: value => value === identity,
      resolvePage: () => page,
      isAuthorizedDecision: input => input.decisionId === 'journaled-pro-decision',
    });
    const action = (observation: Awaited<ReturnType<typeof adapter.observe>>,
      purpose: string) => {
      const found = observation.actions.filter(candidate => candidate.purpose === purpose);
      assert.equal(found.length, 1, 'one exact configuration-only decision: ' + purpose);
      assert.equal(found[0]!.risk, 'configuration_only');
      assert.equal(found[0]!.input.kind, 'none');
      return found[0]!;
    };
    const act = async (observation: Awaited<ReturnType<typeof adapter.observe>>,
      purpose: string) => {
      const choice = action(observation, purpose);
      return await adapter.act({
        context: task, snapshotId: observation.snapshotId,
        actionRef: choice.actionRef, evidenceHash: choice.evidenceHash,
        authorizedDecisionId: 'journaled-pro-decision',
      });
    };
    // Live root is stranded in the model-radio view, which is not a Pro choice.
    const inModelView = await adapter.observe(task);
    assert.equal(inModelView.verifiedModel, 'GPT-6');
    assert.equal(inModelView.actions.some(a => a.purpose === 'choose_model'), false);
    const close = action(inModelView, 'close_model_chooser');
    assert.equal((await adapter.act({ context: task, snapshotId: inModelView.snapshotId,
      actionRef: close.actionRef, evidenceHash: close.evidenceHash })).kind,
    'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).openerClicks), 0);
    assert.deepEqual(await act(inModelView, 'close_model_chooser'),
      { kind: 'performed', effect: 'model_menu_closed' });

    const closed = await adapter.observe(task);
    assert.deepEqual(await act(closed, 'open_model_chooser'),
      { kind: 'performed', effect: 'model_menu_opened' });
    const power = await inspectSemanticChatGptModelMenu(page);
    assert.equal(power?.status, 'nested');
    assert.equal(power?.reasoningControlState, 'enabled',
      'aria-disabled Power keyboard row is not pointer slider disabled');
    assert.equal(power?.fiveLevelPowerScaleVerified, true);
    assert.equal(power?.verifiedReasoningLevel, 'Medium');

    // Explicit pointer disabled/locked evidence blocks selection.
    await page.locator('[data-model-picker-power-slider] > span').evaluate(element =>
      element.setAttribute('data-locked', 'true'));
    let blocked = await adapter.observe(task);
    assert.equal(blocked.actions.some(a => a.purpose === 'choose_reasoning_effort'), false);
    assert.deepEqual(blocked.capabilityIssues, [
      { capability: 'model_choice', reason: 'reasoning-effort-control-disabled' },
    ]);
    await page.locator('[data-model-picker-power-slider] > span').evaluate(element =>
      element.setAttribute('data-locked', 'false'));
    // An unmatched status announcement also forbids guessing a Pro target.
    await page.locator('[role=status]').evaluate(element => {
      element.textContent = 'Medium, 5개 중 3번째입니다.';
    });
    blocked = await adapter.observe(task);
    assert.equal(blocked.actions.some(a => a.purpose === 'choose_reasoning_effort'), false);
    assert.equal(blocked.reason, 'reasoning-effort-pro-target-unverified');
    await page.locator('[role=status]').evaluate(element => {
      element.textContent = 'Medium, 5개 중 2번째입니다.';
    });
    await page.locator('#pro-power-tick').evaluate(element => {
      (element as HTMLElement).style.left = '20px';
    });
    blocked = await adapter.observe(task);
    assert.equal(blocked.actions.some(a => a.purpose === 'choose_reasoning_effort'), false,
      'a DOM-order tick that is not geometrically last is not an exact Pro target');
    await page.locator('#pro-power-tick').evaluate(element => {
      (element as HTMLElement).style.left = '220px';
    });

    const ready = await adapter.observe(task);
    const select = action(ready, 'choose_reasoning_effort');
    assert.equal((await adapter.act({ context: task, snapshotId: ready.snapshotId,
      actionRef: select.actionRef, evidenceHash: select.evidenceHash })).kind,
      'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).proPowerClicks), 0);
    assert.deepEqual(await act(ready, 'choose_reasoning_effort'),
      { kind: 'performed', effect: 'reasoning_effort_selected' });
    assert.equal(await page.evaluate(() => (window as any).proPowerClicks), 1);
    assert.equal(await page.evaluate(() => (window as any).sendAttempts), 0);
    assert.equal((await inspectSemanticChatGptModelMenu(page))?.verifiedReasoningLevel, 'Pro');
    const stillOpen = await adapter.observe(task);
    assert.equal(stillOpen.verifiedReasoningLevel, null,
      'an open picker never authorizes the original prompt');
    assert.equal(stillOpen.actions.some(a => a.purpose === 'compose' || a.purpose === 'submit'), false);
    assert.deepEqual(await act(stillOpen, 'close_model_chooser'),
      { kind: 'performed', effect: 'model_menu_closed' });
    const final = await adapter.observe(task);
    assert.equal(final.verifiedModel, null);
    assert.equal(final.verifiedReasoningLevel, 'Pro');
    assert.equal(final.actions.filter(a => a.purpose === 'compose').length, 1);
    assert.equal(final.actions.some(a => a.purpose === 'submit'), false);
    assert.equal(await page.evaluate(() => (window as any).sendAttempts), 0);
    assert.equal(await page.evaluate(() => (window as any).proPowerClicks), 1);
  } finally {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one trusted Power click without literal Pro confirmation stays uncertain and is never replayed', {
  timeout: 35_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sessionplane-pro-unverified-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(dir, 'disposable-chromium-profile'),
    pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: exactPowerFiveStepFixture(),
    }));
    await page.goto('https://chatgpt.com/');
    const identity = {
      projectId: 'power-test-project', slotId: 'main', slotRevision: 1,
      taskId: 'power-once-root', pageKey: binding.pageKey,
      targetId: registry.getBinding(binding.pageKey).targetId!,
      bindingEpoch: registry.getBinding(binding.pageKey).bindingEpoch,
    };
    const task = {
      ...identity, providerConversationId: null, submittedUserMessageId: null,
      submittedUserTurnId: null, pageLease: identity, requiredModel: 'Pro',
    };
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: value => value === identity, resolvePage: () => page,
      isAuthorizedDecision: input => input.decisionId === 'power-only-once',
    });
    const first = await adapter.observe(task);
    const close = first.actions.find(a => a.purpose === 'close_model_chooser')!;
    assert.ok(close);
    assert.deepEqual(await adapter.act({
      context: task, snapshotId: first.snapshotId,
      actionRef: close.actionRef, evidenceHash: close.evidenceHash,
      authorizedDecisionId: 'power-only-once',
    }), { kind: 'performed', effect: 'model_menu_closed' });
    const second = await adapter.observe(task);
    const open = second.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(open);
    assert.deepEqual(await adapter.act({
      context: task, snapshotId: second.snapshotId,
      actionRef: open.actionRef, evidenceHash: open.evidenceHash,
      authorizedDecisionId: 'power-only-once',
    }), { kind: 'performed', effect: 'model_menu_opened' });
    await page.evaluate(() => { (window as any).applyProChoice = false; });
    const ready = await adapter.observe(task);
    const choice = ready.actions.find(a => a.purpose === 'choose_reasoning_effort')!;
    assert.ok(choice);
    const request = { context: task, snapshotId: ready.snapshotId,
      actionRef: choice.actionRef, evidenceHash: choice.evidenceHash,
      authorizedDecisionId: 'power-only-once' };
    const result = await adapter.act(request);
    assert.equal(result.kind, 'uncertain');
    assert.equal(await page.evaluate(() => (window as any).proPowerClicks), 1);
    assert.equal((await adapter.act(request)).kind, 'stale',
      'one uncertain external pointer action must never be replayed');
    const after = await adapter.observe(task);
    assert.equal(after.verifiedReasoningLevel, null);
    assert.equal(after.actions.some(a => a.purpose === 'compose' || a.purpose === 'submit'), false);
    assert.equal(await page.evaluate(() => (window as any).sendAttempts), 0);
  } finally {
    await owner.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
