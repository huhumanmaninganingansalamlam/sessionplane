import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import type { OwnedPageIdentity } from '../../src/browser/owned-page-lifecycle.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../../src/providers/chatgpt/backend-recovery.ts';
import { ChatGptSemanticAdapter } from '../../src/providers/chatgpt/semantic-adapter.ts';
import type { SemanticTaskContext } from '../../src/providers/semantic-adapter.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function context(lease: OwnedPageIdentity | null, userMessageId: string | null = null): SemanticTaskContext {
  return {
    projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
    providerConversationId: 'conversation-b',
    submittedUserMessageId: userMessageId, submittedUserTurnId: userMessageId ? 'turn-b' : null,
    pageLease: lease,
  };
}
const NORMAL = '<main><div id="prompt-textarea" contenteditable="true" role="textbox"></div>' +
  '<button type="button" data-testid="send-button" onclick="window.sends++;' +
  'document.querySelector(\'#prompt-textarea\').textContent=\'\';">Send</button>' +
  '<article data-message-author-role="user">Quoted instructions: <button aria-label="Send" ' +
  'onclick="window.foreignClicks++">Send</button></article></main>' +
  '<script>window.sends=0;window.foreignClicks=0;</script>';
const DRIFT = '<main><section data-chatgpt-composer><form id="new-layout">' +
  '<div role="textbox" contenteditable="true" aria-label="Your message"></div>' +
  '<div><span>Updated DOM</span><button type="submit">Post it</button></div></form></section>' +
  '</main><script>window.sends=0;' +
  'document.querySelector("form").addEventListener("submit",e=>{e.preventDefault();window.sends++;' +
  'document.querySelector("[role=textbox]").textContent="";});</script>';

test('ChatGPT semantic observe/act uses exact draft and one-shot send across structural/testid drift', {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-b-semantic-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'), pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const created = await owner.createPage();
    const page = created.page;
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: NORMAL,
    }));
    await page.goto('https://chatgpt.com/c/conversation-b');
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'fixture-b', generation: 1, conversationId: 'conversation-b',
    });
    const binding = registry.getBinding(created.binding.pageKey);
    const lease: OwnedPageIdentity = {
      projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
      pageKey: binding.pageKey, targetId: binding.targetId!, bindingEpoch: binding.bindingEpoch,
    };
    let allowedLease: OwnedPageIdentity | null = lease;
    const durablePostObservations: string[] = [];
    const adapter = new ChatGptSemanticAdapter({
      onDispatchObserved: value => durablePostObservations.push(value.attemptId + ':' + value.evidence.messageId),
      isExactLease: value => allowedLease === value &&
        registry.getBinding(value.pageKey).bindingEpoch === value.bindingEpoch &&
        registry.getBinding(value.pageKey).targetId === value.targetId,
      resolvePage: value => registry.pageForObservation(value.pageKey, value.bindingEpoch),
      isAuthorizedAttempt: input => input.attemptId.startsWith('journaled-attempt-'),
      isAuthorizedDecision: input => input.decisionId === 'decision-model',
    });
    const task = context(lease);
    let foregroundCalls = 0;
    Object.defineProperty(page, 'bringToFront', {
      configurable: true, value: async () => { foregroundCalls++; throw new Error('Human focus forbidden'); },
    });
    for (const [label, html] of [
      ['known testids', NORMAL], ['renamed testid and wrapped editor / semantic form submit', DRIFT],
    ] as const) {
      await page.setContent(html);
      const first = await adapter.observe(task);
      assert.equal(first.surface, 'chat', label);
      assert.equal(first.blocker, 'none', label);
      assert.ok(first.evidenceBytes < 12 * 1024);
      assert.equal(JSON.stringify(first).includes('onclick'), false, 'raw page HTML must not escape');
      assert.equal(first.actions.some(a => a.purpose === 'submit'), false);
      const compose = first.actions.find(a => a.purpose === 'compose')!;
      assert.ok(compose && compose.input.kind === 'text');
      const phrase = 'Exact ' + label;
      const filled = await adapter.act({
        context: task, snapshotId: first.snapshotId, actionRef: compose.actionRef,
        evidenceHash: compose.evidenceHash, input: phrase,
      });
      assert.deepEqual(filled, { kind: 'performed', effect: 'draft_updated' }, label);
      assert.equal((await adapter.act({
        context: task, snapshotId: first.snapshotId, actionRef: compose.actionRef,
        evidenceHash: compose.evidenceHash, input: 'duplicate',
      })).kind, 'stale', 'a used ref cannot replay');
      const second = await adapter.observe(task);
      const submit = second.actions.find(a => a.purpose === 'submit')!;
      assert.ok(submit, 'semantic send control survives DOM structural drift');
      assert.equal((await adapter.act({
        context: task, snapshotId: second.snapshotId, actionRef: submit.actionRef,
        evidenceHash: submit.evidenceHash,
      })).kind, 'authorization_required');
      assert.equal(await page.evaluate(() => (window as any).sends), 0);
      const dispatched = await adapter.act({
        context: task, snapshotId: second.snapshotId, actionRef: submit.actionRef,
        evidenceHash: submit.evidenceHash, authorizedAttemptId: 'journaled-attempt-' + label,
        expectedContentSha256: digest(phrase),
      });
      assert.deepEqual(dispatched, { kind: 'dispatched_unverified', effect: 'send',
        attempts: [] }, 'a click without an observed POST is not canonical ACK evidence');
      assert.equal(await page.evaluate(() => (window as any).sends), 1);
      assert.equal((await adapter.act({
        context: task, snapshotId: second.snapshotId, actionRef: submit.actionRef,
        evidenceHash: submit.evidenceHash, authorizedAttemptId: 'another-id',
        expectedContentSha256: digest(phrase),
      })).kind, 'stale');
      assert.equal(await page.evaluate(() => (window as any).sends), 1,
        'even a new request ID cannot replay the same actionRef');
      assert.equal(foregroundCalls, 0);
      if (label === 'known testids')
        assert.equal(await page.evaluate(() => (window as any).foreignClicks), 0,
          'message-body buttons are not executable chat send controls');
    }

    // Never overwrite a retained human draft just because the editor is
    // technically editable. Its submitted hash must instead match a journal.
    await page.setContent('<main><div id="prompt-textarea" role="textbox" ' +
      'contenteditable="true">Retained human draft</div>' +
      '<button data-testid="send-button">Send</button></main>');
    const retained = await adapter.observe(task);
    assert.equal(retained.actions.some(a => a.purpose === 'compose'), false);
    assert.equal(await page.locator('#prompt-textarea').innerText(), 'Retained human draft');

    // Capture a real request emitted from this exact Page. A cleared composer
    // or clicked button alone never supplies canonical ACK identity.
    await page.setContent('<main><div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
      '<button data-testid="send-button" type="button">Send</button></main>' +
      '<script>window.sends=0;document.querySelector("button").onclick=()=>{' +
      'const editor=document.querySelector("#prompt-textarea");const text=editor.innerText;window.sends++;' +
      'fetch("/backend-api/f/conversation",{method:"POST",headers:{"Content-Type":"application/json"},' +
      'body:JSON.stringify({action:"next",conversation_id:"conversation-b",parent_message_id:"parent-b",' +
      'messages:[{id:"user-b",author:{role:"user"},content:{content_type:"text",parts:[text]}}]})});' +
      'editor.textContent="";};</script>');
    const networkDraft = 'Exact submitted POST provenance';
    const prior = await adapter.observe(task);
    const draft = prior.actions.find(a => a.purpose === 'compose')!;
    assert.equal((await adapter.act({ context: task, snapshotId: prior.snapshotId,
      actionRef: draft.actionRef, evidenceHash: draft.evidenceHash,
      input: networkDraft })).kind, 'performed');
    const ready = await adapter.observe(task);
    const send = ready.actions.find(a => a.purpose === 'submit')!;
    const networkResult = await adapter.act({ context: task, snapshotId: ready.snapshotId,
      actionRef: send.actionRef, evidenceHash: send.evidenceHash,
      authorizedAttemptId: 'journaled-attempt-network', expectedContentSha256: digest(networkDraft) });
    assert.equal(networkResult.kind, 'dispatched_unverified');
    if (networkResult.kind !== 'dispatched_unverified') throw new Error('Send was not dispatched');
    assert.deepEqual(networkResult.attempts.map(a =>
      [a.conversationId, a.messageId, a.parentMessageId, a.textHash]),
      [['conversation-b', 'user-b', 'parent-b', digest(networkDraft)]],
      'only the exact outgoing POST can carry dispatch provenance');
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    assert.deepEqual(durablePostObservations, ['journaled-attempt-network:user-b'],
      'the exact outgoing POST invokes its durable journal hook before returning');

    // Model choice is a separate, explicit two-step configuration decision.
    // Observe itself must not open the popup or change the current selection.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<button id="model-trigger" aria-label="Model" aria-haspopup="menu" ' +
      'aria-controls="model-menu" aria-expanded="false" type="button">Current</button>' +
      '<div role="menu" id="model-menu" hidden>' +
      '<button role="menuitemradio" aria-checked="true">Default</button>' +
      '<button role="menuitemradio" aria-checked="false">Pro</button></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.modelOpens=0;window.modelChanges=0;' +
      'document.querySelector("#model-trigger").onclick=()=>{window.modelOpens++;' +
      'document.querySelector("#model-trigger").setAttribute("aria-expanded","true");' +
      'document.querySelector("#model-menu").hidden=false;};' +
      'document.querySelectorAll("[role=menuitemradio]").forEach(button=>button.onclick=()=>{' +
      'window.modelChanges++;document.querySelectorAll("[role=menuitemradio]")' +
      '.forEach(other=>other.setAttribute("aria-checked",String(other===button)));});' +
      '</script>');
    const beforeModel = await adapter.observe(task);
    assert.equal(beforeModel.actions.some(a => a.purpose === 'choose_model'), false);
    const openModel = beforeModel.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openModel);
    assert.equal(await page.evaluate(() => (window as any).modelOpens), 0,
      'observation must not mutate the provider model chooser');
    assert.equal((await adapter.act({ context: task, snapshotId: beforeModel.snapshotId,
      actionRef: openModel.actionRef, evidenceHash: openModel.evidenceHash })).kind,
    'authorization_required');
    assert.deepEqual(await adapter.act({ context: task, snapshotId: beforeModel.snapshotId,
      actionRef: openModel.actionRef, evidenceHash: openModel.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    assert.equal(await page.evaluate(() => (window as any).modelOpens), 1);
    const optionsModel = await adapter.observe(task);
    const choiceModel = optionsModel.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(choiceModel && choiceModel.input.kind === 'option');
    if (choiceModel.input.kind !== 'option') throw new Error('Expected model option schema');
    assert.deepEqual(choiceModel.input.options.map(o => o.value), ['Default', 'Pro']);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: optionsModel.snapshotId,
      actionRef: choiceModel.actionRef, evidenceHash: choiceModel.evidenceHash,
      input: 'Pro', authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_selected' });
    assert.equal(await page.evaluate(() => (window as any).modelChanges), 1);
    assert.equal((await adapter.act({ context: task, snapshotId: optionsModel.snapshotId,
      actionRef: choiceModel.actionRef, evidenceHash: choiceModel.evidenceHash,
      input: 'Pro', authorizedDecisionId: 'decision-model' })).kind, 'stale');

    // The documented Pro Standard/Extended picker may sit under Pro.
    // Both disclosure levels require a new journal-authorized action and a
    // fresh linked-menu observation; no menu opens during observe.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<button id="model-trigger" aria-label="Model" aria-haspopup="menu" ' +
      'aria-controls="model-menu" aria-expanded="false" type="button">Current</button>' +
      '<div role="menu" id="model-menu" hidden>' +
      '<button role="menuitemradio" aria-checked="true">Instant</button>' +
      '<button id="pro-trigger" role="menuitem" aria-haspopup="menu" ' +
      'aria-controls="pro-effort" aria-expanded="false">Pro</button></div>' +
      '<div role="menu" id="pro-effort" hidden>' +
      '<button role="menuitemradio" aria-checked="true">Standard</button>' +
      '<button role="menuitemradio" aria-checked="false">Extended</button></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.proRootOpens=0;window.proSubmenuOpens=0;window.proEffortChanges=0;' +
      'document.querySelector("#model-trigger").onclick=()=>{' +
      'window.proRootOpens++;document.querySelector("#model-trigger")' +
      '.setAttribute("aria-expanded","true");' +
      'document.querySelector("#model-menu").hidden=false;};' +
      'document.querySelector("#pro-trigger").onclick=()=>{' +
      'window.proSubmenuOpens++;document.querySelector("#pro-trigger")' +
      '.setAttribute("aria-expanded","true");' +
      'document.querySelector("#pro-effort").hidden=false;};' +
      'document.querySelectorAll("#pro-effort [role=menuitemradio]")' +
      '.forEach(button=>button.onclick=()=>{window.proEffortChanges++;' +
      'document.querySelectorAll("#pro-effort [role=menuitemradio]")' +
      '.forEach(other=>other.setAttribute("aria-checked",String(other===button)));});' +
      '</script>');
    const proClosed = await adapter.observe(task);
    const openProRoot = proClosed.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openProRoot);
    assert.equal(await page.evaluate(() => (window as any).proRootOpens), 0);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: proClosed.snapshotId,
      actionRef: openProRoot.actionRef, evidenceHash: openProRoot.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    const proNested = await adapter.observe(task);
    assert.equal(proNested.actions.some(a => a.purpose === 'choose_model'), false,
      'a Pro parent entry is not a verified reasoning level');
    const openProEffort = proNested.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openProEffort);
    assert.equal(await page.evaluate(() => (window as any).proSubmenuOpens), 0);
    assert.equal((await adapter.act({ context: task, snapshotId: proNested.snapshotId,
      actionRef: openProEffort.actionRef, evidenceHash: openProEffort.evidenceHash })).kind,
    'authorization_required');
    assert.deepEqual(await adapter.act({ context: task, snapshotId: proNested.snapshotId,
      actionRef: openProEffort.actionRef, evidenceHash: openProEffort.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    assert.equal(await page.evaluate(() => (window as any).proSubmenuOpens), 1);
    const proEffort = await adapter.observe(task);
    const selectEffort = proEffort.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(selectEffort && selectEffort.input.kind === 'option');
    if (selectEffort.input.kind !== 'option') throw new Error('Missing Pro level schema');
    assert.deepEqual(selectEffort.input.options.map(o => o.value),
      ['Pro Standard', 'Pro Extended']);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: proEffort.snapshotId,
      actionRef: selectEffort.actionRef, evidenceHash: selectEffort.evidenceHash,
      input: 'Pro Extended', authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_selected' });
    assert.equal(await page.evaluate(() => (window as any).proEffortChanges), 1);
    assert.equal((await adapter.act({ context: task, snapshotId: proEffort.snapshotId,
      actionRef: selectEffort.actionRef, evidenceHash: selectEffort.evidenceHash,
      input: 'Pro Extended', authorizedDecisionId: 'decision-model' })).kind, 'stale');
    // A portal may lazily mount the menu only after disclosure. Use the
    // declared exact aria-controls ID, then verify the mounted menu afresh.
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('#model-menu')!;
      const sub = document.querySelector<HTMLElement>('#pro-effort')!;
      const opener = document.querySelector<HTMLButtonElement>('#model-trigger')!;
      const trigger = document.querySelector<HTMLButtonElement>('#pro-trigger')!;
      const main = document.querySelector<HTMLElement>('main')!;
      root.hidden = true;
      sub.hidden = true;
      opener.setAttribute('aria-expanded', 'false');
      trigger.setAttribute('aria-expanded', 'false');
      root.remove();
      sub.remove();
      opener.onclick = () => {
        opener.setAttribute('aria-expanded', 'true');
        root.hidden = false;
        main.append(root);
      };
      trigger.onclick = () => {
        trigger.setAttribute('aria-expanded', 'true');
        sub.hidden = false;
        main.append(sub);
      };
    });
    const lazyModel = await adapter.observe(task);
    const lazyOpen = lazyModel.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(lazyOpen);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: lazyModel.snapshotId,
      actionRef: lazyOpen.actionRef, evidenceHash: lazyOpen.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    const lazyParent = await adapter.observe(task);
    assert.equal(lazyParent.actions.some(a => a.purpose === 'choose_model'), false);
    const lazyDisclosure = lazyParent.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(lazyDisclosure);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: lazyParent.snapshotId,
      actionRef: lazyDisclosure.actionRef, evidenceHash: lazyDisclosure.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    const lazyEffort = await adapter.observe(task);
    const lazyChoice = lazyEffort.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(lazyChoice && lazyChoice.input.kind === 'option');

    // Missing submenu linkage is not a license to guess a Pro control.
    await page.evaluate(() => document.querySelector('#pro-trigger')!
      .removeAttribute('aria-controls'));
    const brokenPro = await adapter.observe(task);
    assert.equal(brokenPro.actions.some(a => a.purpose === 'choose_model' ||
      a.purpose === 'open_model_chooser'), false);

    // Observed ChatGPT composer picker: the root portal is lazy and gains
    // aria-controls only after opening. The effort slider and model radios
    // coexist in the DOM, but only one view is visible at a time.
    await page.setContent(`
      <main>
        <div id="prompt-textarea" contenteditable="true"></div>
        <button id="radix-opener" aria-label="ChatGPT 모델 선택"
          aria-haspopup="menu" aria-expanded="false" data-state="closed">추론 수준 Medium</button>
        <button data-testid="send-button">Send</button>
      </main>
      <script>
        window.radixRootOpens = 0;
        window.radixModelDisclosures = 0;
        window.radixSliderChanges = 0;
        window.radixModelChanges = 0;
        const opener = document.getElementById('radix-opener');
        opener.onclick = () => {
          window.radixRootOpens++;
          opener.setAttribute('aria-expanded', 'true');
          opener.setAttribute('data-state', 'open');
          opener.setAttribute('aria-controls', 'radix-menu');
          const menu = document.createElement('div');
          menu.id = 'radix-menu';
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-labelledby', 'radix-opener');
          menu.setAttribute('data-state', 'open');
          menu.innerHTML = '<div role="group">' +
            '<div id="radix-effort-view">' +
              '<div role="menuitem" aria-label="모델 선택" id="radix-choose">Medium</div>' +
              '<div role="menuitem" aria-label="파워">' +
                '<span role="slider" aria-valuenow="2" aria-valuemin="1" aria-valuemax="5" ' +
                'style="display:inline-block;width:28px;height:28px"></span>' +
              '</div></div>' +
            '<div id="radix-model-view" style="display:none">' +
              '<div role="menuitemradio" aria-checked="true">GPT-6</div>' +
              '<div role="menuitemradio" aria-checked="false">GPT-5.6 Sol</div>' +
            '</div></div>';
          document.querySelector('main').append(menu);
          document.querySelector('[role=slider]').onclick = () => window.radixSliderChanges++;
          document.getElementById('radix-choose').onclick = () => {
            window.radixModelDisclosures++;
            document.getElementById('radix-effort-view').style.display = 'none';
            document.getElementById('radix-model-view').style.display = 'block';
          };
          document.querySelectorAll('#radix-model-view [role=menuitemradio]')
            .forEach(radio => radio.onclick = () => {
              window.radixModelChanges++;
              document.querySelectorAll('#radix-model-view [role=menuitemradio]')
                .forEach(other => other.setAttribute('aria-checked', String(other === radio)));
            });
        };
      </script>
    `);
    const radixClosed = await adapter.observe(task);
    assert.equal(radixClosed.actions.some(a => a.purpose === 'choose_model'), false);
    const openRadix = radixClosed.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openRadix, 'unmounted composer picker is a read-only disclosed candidate');
    assert.equal((await adapter.act({ context: task, snapshotId: radixClosed.snapshotId,
      actionRef: openRadix.actionRef, evidenceHash: openRadix.evidenceHash })).kind,
    'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).radixRootOpens), 0);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: radixClosed.snapshotId,
      actionRef: openRadix.actionRef, evidenceHash: openRadix.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    const radixEffort = await adapter.observe(task);
    assert.equal(radixEffort.actions.some(a => a.purpose === 'choose_model'), false,
      'the visible slider is not a model option');
    const discloseRadix = radixEffort.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(discloseRadix, 'model list disclosure must be a separate authorized action');
    assert.equal((await adapter.act({ context: task, snapshotId: radixEffort.snapshotId,
      actionRef: discloseRadix.actionRef, evidenceHash: discloseRadix.evidenceHash })).kind,
    'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).radixModelDisclosures), 0);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: radixEffort.snapshotId,
      actionRef: discloseRadix.actionRef, evidenceHash: discloseRadix.evidenceHash,
      authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_menu_opened' });
    const radixModels = await adapter.observe(task);
    const radixChoice = radixModels.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(radixChoice && radixChoice.input.kind === 'option');
    if (radixChoice.input.kind !== 'option') throw new Error('Missing visible Radix model options');
    assert.deepEqual(radixChoice.input.options.map(o => o.value), ['GPT-6', 'GPT-5.6 Sol']);
    assert.equal(await page.evaluate(() => (window as any).radixSliderChanges), 0,
      'no model enumeration may change reasoning effort');
    assert.equal((await adapter.act({ context: task, snapshotId: radixModels.snapshotId,
      actionRef: radixChoice.actionRef, evidenceHash: radixChoice.evidenceHash,
      input: 'GPT-5.6 Sol' })).kind, 'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).radixModelChanges), 0);
    assert.deepEqual(await adapter.act({ context: task, snapshotId: radixModels.snapshotId,
      actionRef: radixChoice.actionRef, evidenceHash: radixChoice.evidenceHash,
      input: 'GPT-5.6 Sol', authorizedDecisionId: 'decision-model' }),
    { kind: 'performed', effect: 'model_selected' });
    assert.equal(await page.evaluate(() => (window as any).radixModelChanges), 1);
    assert.equal(await page.evaluate(() => (window as any).radixSliderChanges), 0);
    await page.evaluate(() => document.querySelector('#radix-menu')!
      .removeAttribute('aria-labelledby'));
    const unlinkedRadix = await adapter.observe(task);
    assert.equal(unlinkedRadix.actions.some(a => a.purpose === 'choose_model' ||
      a.purpose === 'open_model_chooser'), false,
      'a same-page but unlinked popover is not a trusted model chooser');

    // Reuse the exact last-turn stream-retry guard. An approved retry click
    // still cannot prove that generation resumed or a final answer exists.
    const retryTask = context(lease, 'user-b');
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div role="alert">Error in message stream <button id="retry">Retry</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.retries=0;document.querySelector("#retry").onclick=()=>{' +
      'window.retries++;document.querySelector("[role=alert]").remove();};</script>');
    const retryObserved = await adapter.observe(retryTask);
    assert.equal(retryObserved.blocker, 'provider_retry');
    const retryAction = retryObserved.actions.find(a => a.purpose === 'retry')!;
    assert.ok(retryAction && retryAction.risk === 'retry_once');
    assert.equal((await adapter.act({ context: retryTask,
      snapshotId: retryObserved.snapshotId, actionRef: retryAction.actionRef,
      evidenceHash: retryAction.evidenceHash })).kind, 'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).retries), 0);
    const clickedRetry = await adapter.act({ context: retryTask,
      snapshotId: retryObserved.snapshotId, actionRef: retryAction.actionRef,
      evidenceHash: retryAction.evidenceHash, authorizedAttemptId: 'journaled-attempt-retry' });
    assert.deepEqual(clickedRetry, { kind: 'uncertain',
      reason: 'retry-clicked-provider-progress-unverified' });
    assert.equal(await page.evaluate(() => (window as any).retries), 1);
    assert.equal((await adapter.act({ context: retryTask,
      snapshotId: retryObserved.snapshotId, actionRef: retryAction.actionRef,
      evidenceHash: retryAction.evidenceHash, authorizedAttemptId: 'journaled-attempt-retry' })).kind,
    'stale', 'exact Retry cannot be replayed after uncertain click');

    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div role="alert">Error in message stream <button id="retry">Retry</button></div>' +
      '<div id="prompt-textarea" contenteditable="true">Human draft</div>' +
      '<button data-testid="send-button">Send</button></main>');
    const guardedRetry = await adapter.observe(retryTask);
    assert.equal(guardedRetry.blocker, 'unsupported');
    assert.match(guardedRetry.reason ?? '', /stream-retry-preserve-draft/);
    assert.equal(guardedRetry.actions.some(a => a.purpose === 'retry'), false);

    // A currently streaming exact assistant response suppresses any send
    // candidate, even if a retained editable draft and Send button exist.
    await page.setContent('<main>' +
      '<div data-message-author-role="user" data-message-id="user-b">Task</div>' +
      '<div data-message-author-role="assistant" data-message-id="answer-b" ' +
      'data-is-streaming="true">Partial output</div>' +
      '<div id="prompt-textarea" contenteditable="true">Human draft</div>' +
      '<button data-testid="send-button">Send</button></main>');
    const streaming = await adapter.observe(context(lease, 'user-b'));
    assert.equal(streaming.progress, 'streaming');
    assert.equal(streaming.blocker, 'unsupported');
    assert.equal(streaming.reason, 'generation-active-preserve-current-turn');
    assert.equal(streaming.actions.length, 0);

    await page.setContent('<main><div data-chatgpt-composer>' +
      '<div role="textbox" contenteditable="true"></div>' +
      '<textarea></textarea><button aria-label="Send message">Send</button>' +
      '</div></main>');
    const ambiguous = await adapter.observe(task);
    assert.equal(ambiguous.blocker, 'unsupported');
    assert.match(ambiguous.reason ?? '', /composer-ambiguous/);
    assert.equal(ambiguous.actions.length, 0);

    // Visible provider error and identity-check dialogs are read-only blockers.
    // Neither an available Send button nor a writable composer overrides them.
    for (const [dialogText, blocker] of [
      ['Rate limit reached', 'rate_limit'],
      ['Verify you are human', 'human_verification'],
    ] as const) {
      await page.setContent('<main><div role="alertdialog">' + dialogText + '</div>' +
        '<div id="prompt-textarea" contenteditable="true"></div>' +
        '<button data-testid="send-button">Send</button></main>');
      const blocked = await adapter.observe(task);
      assert.equal(blocked.blocker, blocker);
      assert.equal(blocked.actions.length, 0, 'provider dialog cannot authorize a send');
    }

    await page.setContent(NORMAL);
    const stale = await adapter.observe(task);
    const compose = stale.actions.find(a => a.purpose === 'compose')!;
    await page.evaluate(() => document.querySelector('#prompt-textarea')!.setAttribute(
      'aria-label', 'Updated label after observation'));
    const staleResult = await adapter.act({
      context: task, snapshotId: stale.snapshotId,
      actionRef: compose.actionRef, evidenceHash: compose.evidenceHash, input: 'must not fill',
    });
    assert.equal(staleResult.kind, 'stale', 'changed evidence before dispatch is a fresh decision, not uncertain mutation');
    assert.equal(await page.locator('#prompt-textarea').innerText(), '');

    await page.setContent('<main><div role="radiogroup">' +
      '<button role="radio" aria-checked="false">Chat</button>' +
      '<button role="radio" aria-checked="true">Work</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button aria-label="Send">Send</button></main>');
    const work = await adapter.observe(task);
    assert.equal(work.surface, 'work');
    assert.equal(work.blocker, 'unsupported');
    assert.equal(work.actions.length, 0);

    // Defense in depth: even if an external ownership implementation
    // mistakenly retains a lease after navigation, the semantic adapter
    // never treats a foreign ChatGPT conversation as the bound Main.
    await page.goto('https://chatgpt.com/c/foreign-conversation');
    const permissiveFixtureLease = new ChatGptSemanticAdapter({
      isExactLease: () => true, resolvePage: () => page,
    });
    const foreign = await permissiveFixtureLease.observe(task);
    assert.equal(foreign.blocker, 'unsupported');
    assert.equal(foreign.reason, 'conversation-url-mismatch');
    assert.equal(foreign.actions.length, 0);
    const unbound = await permissiveFixtureLease.observe({
      ...task, providerConversationId: null,
    });
    assert.equal(unbound.blocker, 'unsupported');
    assert.equal(unbound.reason, 'conversation-binding-required');
    assert.equal(unbound.actions.length, 0);

    allowedLease = null;
    await assert.rejects(adapter.observe(task), /Stale exact Task/);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT provider question offers enabled typed choices and runs once after exact evidence check', {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-b-question-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'), pageRegistry: registry, headless: true,
  });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<main><div id="prompt-textarea" contenteditable="true"></div>' +
        '<div data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
        '<h3>Choose an implementation</h3><div role="radiogroup">' +
        '<button type="button" role="radio" aria-label="Keep existing" ' +
        'onclick="window.choice=\'existing\';this.closest(\'[data-codex-composer-request-navigation]\').remove()">Existing</button>' +
        '<button type="button" role="radio" aria-label="Replace" disabled>Replace</button>' +
        '</div></div></main><script>window.choice=null;</script>',
    }));
    await page.goto('https://chatgpt.com/c/conversation-b');
    const current = registry.getBinding(binding.pageKey);
    const lease: OwnedPageIdentity = {
      projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
      pageKey: current.pageKey, targetId: current.targetId!, bindingEpoch: current.bindingEpoch,
    };
    const adapter = new ChatGptSemanticAdapter({
      isExactLease: candidate => candidate === lease,
      resolvePage: () => page,
      isAuthorizedAttempt: input => input.attemptId.startsWith('decision-'),
    });
    const task = context(lease);
    const observed = await adapter.observe(task);
    assert.equal(observed.blocker, 'provider_question');
    assert.match(observed.questionText ?? '', /Choose an implementation/);
    assert.equal(observed.actions.length, 1);
    const action = observed.actions[0]!;
    assert.equal(action.purpose, 'answer_question');
    assert.equal(action.input.kind, 'option');
    if (action.input.kind !== 'option') throw new Error('Expected option schema');
    assert.deepEqual(action.input.options.map(o => [o.value, o.enabled]),
      [['Keep existing', true], ['Replace', false]]);
    const denied = await adapter.act({ context: task, snapshotId: observed.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      input: 'Keep existing' });
    assert.equal(denied.kind, 'authorization_required');
    const applied = await adapter.act({ context: task, snapshotId: observed.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      input: 'Keep existing', authorizedAttemptId: 'decision-once' });
    assert.deepEqual(applied, { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).choice), 'existing');
    assert.equal((await adapter.act({ context: task, snapshotId: observed.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      input: 'Keep existing', authorizedAttemptId: 'decision-twice' })).kind, 'stale');

    // A bounded free-text question is a distinct typed input; only a scoped
    // provider panel may submit it, never an arbitrary form or chat editor.
    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3>Which repository should we inspect?</h3><form><textarea aria-label="Repository"></textarea>' +
      '<button type="submit">Submit</button></form></section></main>' +
      '<script>window.freeAnswer=null;document.querySelector("form").onsubmit=e=>{' +
      'e.preventDefault();window.freeAnswer=document.querySelector("textarea").value;' +
      'document.querySelector("section").remove();};</script>');
    const free = await adapter.observe(task);
    assert.equal(free.blocker, 'provider_question');
    assert.match(free.questionText ?? '', /Which repository/);
    const option = free.actions.find(a => a.purpose === 'answer_question')!;
    assert.deepEqual(option.input, { kind: 'text', maxLength: 2_000 });
    const answered = await adapter.act({ context: task, snapshotId: free.snapshotId,
      actionRef: option.actionRef, evidenceHash: option.evidenceHash,
      input: 'sessionplane', authorizedAttemptId: 'decision-free-text' });
    assert.deepEqual(answered, { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).freeAnswer), 'sessionplane');
    assert.equal((await adapter.act({ context: task, snapshotId: free.snapshotId,
      actionRef: option.actionRef, evidenceHash: option.evidenceHash,
      input: 'other', authorizedAttemptId: 'decision-free-text' })).kind, 'stale');

    await page.setContent('<main><div id="prompt-textarea" contenteditable="true"></div>' +
      '<section data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">' +
      '<h3>Preserve this partial answer</h3><form><textarea>Human typed</textarea>' +
      '<button type="submit">Submit</button></form></section></main>');
    const held = await adapter.observe(task);
    assert.equal(held.blocker, 'provider_question');
    assert.equal(held.actions.length, 0, 'preexisting provider-question draft cannot be overwritten');

    // Visible exact-work HostSpan permission is an agent review barrier,
    // never an authorization created by page text or an auto-Allow click.
    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">Original task</div>' +
      '<div role="alert">hostspan-git requests access to repository read ' +
      '<button type="button" onclick="window.grants++">Allow once</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>' +
      '<script>window.grants=0;</script>');
    const permission = await adapter.observe(context(lease, 'user-b'));
    assert.equal(permission.blocker, 'provider_permission');
    assert.equal(permission.actions.length, 0, 'permission effects/arguments need explicit review');
    assert.equal(permission.permission?.appName, 'hostspan-git');
    assert.equal(permission.permission?.toolName, null, 'do not guess a tool from prose');
    assert.equal(permission.permission?.detailState, 'not_visible');
    assert.equal(permission.permission?.canGrant, false);
    assert.equal(await page.evaluate(() => (window as any).grants), 0);

    // A visible sensitive argument is not silently shortened or leaked to
    // the agent packet. Redaction makes grant ineligible by construction.
    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="user-b">Original task</div>' +
      '<div role="alert">hostspan-git requests access ' +
      '<pre>{"api_key":"synthetic-secret-123456789"}</pre>' +
      '<button type="button">Allow once</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>');
    const protectedPermission = await adapter.observe(context(lease, 'user-b'));
    assert.equal(protectedPermission.blocker, 'provider_permission');
    assert.equal(protectedPermission.permission?.detailState, 'redacted');
    assert.equal(protectedPermission.permission?.canGrant, false);
    assert.equal(JSON.stringify(protectedPermission).includes('synthetic-secret-123456789'), false);
    assert.equal(protectedPermission.actions.length, 0);

    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="user-b" data-turn-id="turn-b">' +
      'Quoted untrusted text: hostspan-git Allow once</div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main>');
    const quoted = await adapter.observe(context(lease, 'user-b'));
    assert.notEqual(quoted.blocker, 'provider_permission',
      'untrusted user text is not a real permission barrier');
    assert.equal(quoted.permission, null);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical ACK and FINAL recovery works read-only without a page or foreground activation', async () => {
  const cid = 'conversation-b', prompt = 'Exact question', userId = 'user-b', userTurn = 'turn-b';
  const user = { id: userId, turn_id: userTurn, author: { role: 'user' }, content: { parts: [prompt] } };
  const answer = { id: 'assistant-b', author: { role: 'assistant' }, channel: 'final',
    status: 'finished_successfully', end_turn: true, content: { parts: ['Exact answer'] }, metadata: {} };
  const payload = { id: cid, current_node: 'assistant-node', mapping: {
    root: { id: 'root', parent: null, children: [], message: null },
    'user-node': { id: 'user-node', parent: 'root', children: [], message: user },
    'assistant-node': { id: 'assistant-node', parent: 'user-node', children: [], message: answer },
  } };
  let reads = 0;
  const client: BackendJsonClient = { async get(url) {
    reads++;
    return { status: 200, headers: {},
      body: url.endsWith('/api/auth/session') ? { accessToken: 'fixture-memory-token' } : payload };
  } };
  const options = {
    isExactLease: (_: OwnedPageIdentity) => false,
    resolvePage: () => { throw new Error('No browser page exists'); },
    backendClient: client,
    backendOrigin: 'https://chatgpt.com',
  };
  const readOnly = new ChatGptSemanticAdapter(options);
  const exact = { ...context(null, userId), submittedUserTurnId: userTurn };
  const result = await readOnly.recover({ context: exact, kind: 'final' });
  assert.deepEqual(result, { kind: 'exact_final', externalTurnId: userTurn,
    answerText: 'Exact answer' });
  assert.equal(reads, 2, 'authenticated read-only GETs only');
  const ackReader = new ChatGptSemanticAdapter({ ...options,
    backendRecovery: new ChatGptBackendRecovery({ requestTimeoutMs: 500,
      tokenCacheTtlMs: 10_000 }) });
  const ack = await ackReader.verify({ context: exact, kind: 'ack', prompt,
    attempts: [{ conversationId: cid, messageId: userId, parentMessageId: 'root',
      textHash: digest(prompt), observedAt: new Date(0).toISOString() }] });
  assert.deepEqual(ack, { kind: 'verified_ack', externalTurnId: userTurn, messageId: userId });
  const invalid = await ackReader.verify({ context: exact, kind: 'ack', prompt });
  assert.equal(invalid.kind, 'unavailable', 'no attempt correlation cannot prove acceptance');
  assert.equal(reads, 4);
});
