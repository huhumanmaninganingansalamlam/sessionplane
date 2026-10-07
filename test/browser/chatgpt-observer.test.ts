import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';
import { observeChatGptAlerts, observeChatGptDom } from '../../src/providers/chatgpt/dom-observer.ts';
import { ExactFinalTracker } from '../../src/providers/chatgpt/exact-final.ts';
import { recoverChatGptAcknowledgement } from '../../src/providers/chatgpt/submission.ts';

const CONVERSATION_ID = 'conversation-observer-123456';

test('completed exact artifact discovery restores a virtualized answer through the existing latest-position button', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-virtualized-artifact-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    let networkRequests = 0;
    await page.route('https://chatgpt.com/**', route => {
      networkRequests++;
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<main></main>' });
    });
    await page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    registry.bindPage(binding.pageKey, { sessionId: 'session-observer', generation: 1, conversationId: CONVERSATION_ID });
    await page.setContent(`<main><div id="turns"><article data-message-author-role="user" data-message-id="old">Old turn</article></div>
      <textarea></textarea><button aria-label="맨 아래로 스크롤">↓</button></main>`);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.querySelector('button')!.onclick = () => {
        const button = document.querySelector('button')!;
        button.dataset.clicks = String(Number(button.dataset.clicks ?? 0) + 1);
        document.querySelector('#turns')!.innerHTML = `<article data-message-author-role="user" data-message-id="user-message-1">Original question</article>
          <article data-message-author-role="assistant" data-message-id="original-final"><div class="markdown">Original final</div>
            <a download="original.md" href="data:text/plain,EXACT-FIXTURE-BYTES">Original file</a></article>`;
      };
    });
    const session = { ...sessionSnapshot(binding.pageKey), terminal: true, sessionState: 'complete' as const,
      providerState: 'complete' as const, responseMessageId: 'original-final' };
    const original = { ...session };
    const adapter = new ChatGptAdapter({ browserOwner: owner, pageRegistry: registry, loginUrl: 'https://chatgpt.com/', acknowledgementTimeoutMs: 500 });
    const request = { session, generation: 1, bindingGeneration: 1 };
    const [file] = await adapter.discoverArtifacts(request);
    assert.equal(file?.name, 'original.md');
    assert.equal(Buffer.from((await adapter.downloadArtifact(request, file!)).bytes).toString(), 'EXACT-FIXTURE-BYTES');
    await adapter.discoverArtifacts(request);
    assert.equal(await page.locator('button').getAttribute('data-clicks'), '1');
    assert.equal(networkRequests, 1, 'Only the isolated initial navigation reaches a route');
    assert.equal(await page.locator('textarea').inputValue(), '');
    assert.deepEqual(session, original);
    assert.equal(registry.getBinding(binding.pageKey).sessionId, original.sessionId);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('virtualized submitted anchor/final is restored once through same-chat display UI, preserving human holds and identity', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-virtualized-final-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  let held = true;
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    let networkRequests = 0;
    await page.route('https://chatgpt.com/**', route => {
      networkRequests++;
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<main></main>' });
    });
    await page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    registry.bindPage(binding.pageKey, { sessionId: 'session-observer', generation: 1, conversationId: CONVERSATION_ID });
    const session = { ...sessionSnapshot(binding.pageKey), nextCheckAt: '2099-01-01T00:00:00.000Z' };
    const original = { ...session };
    const adapter = new ChatGptAdapter({ browserOwner: owner, pageRegistry: registry, loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500, canRestoreLatestPosition: () => !held });
    const source = await adapter.openObservation({ session, generation: 1 });
    await page.setContent(`<main><div id="turns"><article data-message-author-role="user" data-message-id="old">Old generation</article></div>
      <textarea></textarea><button aria-label="맨 아래로 스크롤">↓</button><span role="status">Response complete</span></main>`);
    await page.evaluate(() => {
      // Headless fixtures do not model a user's foreground tab.
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.querySelector('button')!.onclick = () => {
        document.querySelector('button')!.dataset.clicks = String(Number(document.querySelector('button')!.dataset.clicks ?? 0) + 1);
        document.querySelector('#turns')!.innerHTML = `<article data-message-author-role="user" data-message-id="user-message-1">Exact submitted turn</article>
          <article data-message-author-role="assistant" data-message-id="original-final"><div class="markdown">Original generation final</div></article>`;
      };
    });
    try {
      assert.equal((await source.observe()).candidate, null, 'Human hold does not infer a final from generic completion');
      held = false;
      await page.locator('textarea').fill('Retained manual draft');
      assert.equal((await source.observe()).submittedUserFound, false, 'Draft is never disturbed');
      await page.locator('textarea').fill('');
      await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }));
      assert.equal((await source.observe()).submittedUserFound, false, 'Visible user tab is preserved');
      await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }));
      const observed = await source.observe();
      assert.equal(observed.submittedUserFound, true);
      assert.equal(observed.candidate?.responseMessageId, 'original-final');
      assert.equal(observed.candidate?.answerText, 'Original generation final');
      const tracker = new ExactFinalTracker(1);
      tracker.evaluate(observed, Date.now());
      assert.equal(tracker.evaluate(await source.observe(), Date.now() + 1).kind, 'complete');
      assert.equal(await page.locator('button').getAttribute('data-clicks'), '1');
      assert.equal(networkRequests, 1, 'Display recovery does not use a synthetic backend probe during cooldown');
      assert.deepEqual(session, original, 'No request/anchor/draft/submission state rewriting');
      const stale = await adapter.openObservation({ session, generation: 1 });
      registry.unbindPage(binding.pageKey);
      registry.bindPage(binding.pageKey, { sessionId: 'session-observer', generation: 2, conversationId: CONVERSATION_ID });
      assert.equal((await stale.observe()).observationTransport, 'stale');
      assert.equal(await page.locator('button').getAttribute('data-clicks'), '1', 'Changed generation cannot recover display or attribute answer');
      stale.close();
    } finally { source.close(); }
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('thinking-failed activity headers report an exact nonterminal provider error, never an answer', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-thinking-failed-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  const user = (id: string, text = 'Question') => `<div data-chatgpt-search-message-ids="${id}"><div data-user-message-bubble>${text}</div></div>`;
  const header = (text: string) => `<div class="group/activity-header">
    <button aria-labelledby="failure-label" aria-expanded="false"></button>
    <span id="failure-label"><span class="text-text/60">${text}</span></span>
  </div>`;
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<main></main>' }));
    await page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    registry.bindPage(binding.pageKey, { sessionId: 'session-observer', generation: 1, conversationId: CONVERSATION_ID });
    const session = sessionSnapshot(binding.pageKey);
    const adapter = new ChatGptAdapter({ browserOwner: owner, pageRegistry: registry, loginUrl: 'https://chatgpt.com/' });
    const source = await adapter.openObservation({ session, generation: 1 });
    const identity = { submittedUserMessageId: 'user-message-1', submittedUserTurnId: null };
    try {
      for (const label of ['생각 실패', 'Thinking failed']) {
        await page.setContent(`<main>${user('user-message-1')}${header(label)}<span role="status">Response complete</span><textarea></textarea></main>`);
        const dom = await observeChatGptDom(page, identity);
        assert.equal(dom.submittedUserFound, true);
        assert.equal(dom.candidate, null);
        assert.deepEqual(dom.providerAlerts, [label]);
        assert.deepEqual(await observeChatGptAlerts(page, identity, true), [label]);
        const observed = await source.observe();
        assert.equal(observed.errorCode, 'provider.actionable-alert');
        assert.equal(observed.reason, 'provider-actionable-alert');
        assert.equal(observed.submittedUserFound, true);
        assert.equal(observed.candidate, null);
        assert.equal(new ExactFinalTracker(1_000).evaluate(observed, Date.now()).kind, 'unverified');
        assert.equal(session.promptSubmitted, true);
        assert.equal(session.submittedUserMessageId, 'user-message-1');
      }
      const ordinaryAnswer = `<div data-message-author-role="assistant" data-message-id="answer"><div class="markdown">Thinking failed / 생각 실패</div></div>`;
      for (const [name, html] of [
        ['ordinary user/assistant words', `${user('user-message-1', 'Thinking failed / 생각 실패')}${ordinaryAnswer}`],
        ['quoted provider markup in user', user('user-message-1', header('Thinking failed'))],
        ['quoted provider markup in assistant', `${user('user-message-1')}<div data-chatgpt-selection-message-id="answer"><div class="markdown">${header('생각 실패')}</div></div>`],
        ['historical error', `${header('Thinking failed')}${user('user-message-1')}`],
        ['old error before human follow-up', `${user('user-message-1')}${header('생각 실패')}${user('human-followup')}`],
        ['missing exact anchor', `${user('unrelated')}${header('Thinking failed')}`],
        ['no message anchor', header('Thinking failed')],
        ['ordinary activity completion', `${user('user-message-1')}${header('분석 완료')}`],
        ['hidden error', `${user('user-message-1')}<div hidden>${header('생각 실패')}</div>`],
        ['hidden disclosure label', `${user('user-message-1')}${header('생각 실패').replace('<span id=', '<span hidden id=')}`],
        ['sidebar error', `${user('user-message-1')}<nav>${header('Thinking failed')}</nav>`],
      ]) {
        await page.setContent(`<main>${html}<textarea></textarea></main>`);
        assert.deepEqual((await observeChatGptDom(page, identity)).providerAlerts, [], name);
        assert.deepEqual(await observeChatGptAlerts(page, identity, true), [], name);
      }
    } finally {
      source.close();
    }
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('automatic UNKNOWN recovery never confirms an optimistic DOM anchor without the same canonical user', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-optimistic-ack-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    let pageRequests = 0;
    await page.route('https://chatgpt.com/**', route => {
      pageRequests++;
      return route.fulfill({ status: 200, contentType: 'text/html', body: '<main><div data-message-author-role="user" data-message-id="optimistic-user">Question</div><textarea id="prompt-textarea"></textarea></main>' });
    });
    await page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    registry.bindPage(binding.pageKey, { sessionId: 'session-observer', generation: 1, conversationId: CONVERSATION_ID });
    let status = 200;
    let userId: string | null = null;
    let probes = 0;
    t.mock.method(page.context().request, 'get', async (url: string) => {
      probes++;
      return { status: () => url.endsWith('/api/auth/session') ? 200 : status,
        headers: () => ({ 'retry-after': '120' }), dispose: async () => {},
        json: async () => url.endsWith('/api/auth/session') ? { accessToken: 'fixture-only-token' } : {
          id: CONVERSATION_ID, current_node: userId === null ? 'root' : 'user', mapping: {
            root: { parent: null, message: null },
            ...(userId === null ? {} : { user: { parent: 'root', message: { id: userId, author: { role: 'user' }, content: { parts: ['Question'] } } } }),
          },
        },
      };
    });
    const session = { ...sessionSnapshot(binding.pageKey), submissionState: 'submission_unknown' as const,
      submittedUserMessageId: null, submittedUserTurnId: null };
    const original = { ...session };
    for (const scenario of [
      { status: 200, userId: null },
      { status: 429, userId: 'optimistic-user' },
      { status: 200, userId: 'different-user' },
      { status: 200, userId: 'optimistic-user' },
    ]) {
      status = scenario.status; userId = scenario.userId;
      const adapter = new ChatGptAdapter({ browserOwner: owner, pageRegistry: registry, loginUrl: 'https://chatgpt.com/', acknowledgementTimeoutMs: 500 });
      const acknowledgement = await adapter.recoverAcknowledgement({ session, generation: 1, prompt: 'Question' });
      if (status === 200 && userId === 'optimistic-user') {
        assert.equal(acknowledgement?.submittedUserMessageId, userId);
        assert.equal(acknowledgement?.evidence, 'backend-exact-user');
      } else {
        assert.equal(acknowledgement, null, JSON.stringify(scenario));
      }
      if (status === 429) {
        const before = probes;
        assert.equal(await adapter.recoverAcknowledgement({ session, generation: 1, prompt: 'Question' }), null);
        assert.equal(probes, before, 'Retry-After prevents another backend probe');
      }
    }
    assert.equal(pageRequests, 1, 'No submit or navigation after the isolated fixture load');
    assert.equal(await page.locator('textarea').inputValue(), '');
    assert.deepEqual(session, original);
    assert.equal(registry.getBinding(binding.pageKey).generation, 1);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('missing DOM user binds only the exact backend prompt and retrieves its final without submission', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-backend-binding-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  try {
    await owner.start();
    const { page, binding } = await owner.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<main>Old completed response</main>' }));
    await page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    registry.bindPage(binding.pageKey, { sessionId: 'session-observer', generation: 1, conversationId: CONVERSATION_ID });
    const urls: string[] = [];
    t.mock.method(page.context().request, 'get', async (url: string) => {
      urls.push(url);
      const body = url.endsWith('/api/auth/session') ? { accessToken: 'fixture-only-token' } : {
        id: CONVERSATION_ID, current_node: 'answer', mapping: {
          root: { parent: null, message: null },
          user: { parent: 'root', message: { id: 'backend-user', author: { role: 'user' }, content: { parts: ['Question'] } } },
          answer: { parent: 'user', message: { id: 'backend-answer', author: { role: 'assistant' }, channel: 'final', status: 'finished_successfully', end_turn: true, content: { parts: ['Exact recovered result'] } } },
        },
      };
      return { status: () => 200, headers: () => ({}), json: async () => body, dispose: async () => {} };
    });
    const adapter = new ChatGptAdapter({ browserOwner: owner, pageRegistry: registry, loginUrl: 'https://chatgpt.com/', acknowledgementTimeoutMs: 500 });
    const session = { ...sessionSnapshot(binding.pageKey), submittedUserMessageId: null, submittedUserTurnId: null };
    assert.equal(await adapter.recoverAcknowledgement({ session, generation: 1, prompt: 'Question', selection: { messageId: 'invented', evidenceHash: '0'.repeat(64) } }), null);
    assert.equal(urls.length, 0, 'Explicit selections never bypass original evidence');
    const acknowledgement = await adapter.recoverAcknowledgement({ session, generation: 1, prompt: 'Question' });
    assert.equal(acknowledgement?.submittedUserMessageId, 'backend-user');
    const result = await adapter.recover({ session: { ...session, ...acknowledgement }, generation: 1 });
    assert.equal(result.kind, 'complete');
    assert.equal(result.responseMessageId, 'backend-answer');
    assert.equal(result.answerText, 'Exact recovered result');
    assert.ok(urls.every(url => url.endsWith('/api/auth/session') || url.endsWith(`/backend-api/conversation/${CONVERSATION_ID}`)));
    assert.equal(registry.getBinding(binding.pageKey).generation, 1);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('current ChatGPT message units recover the exact submitted turn and answer', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-message-units-'));
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: new PageRegistry(),
    headless: true,
  });
  try {
    await owner.start();
    const { page } = await owner.createPage();
    await page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: `
        <div data-chatgpt-search-message-ids="user-exact">
          <div data-user-message-bubble="true">Question</div>
        </div>
        <div data-chatgpt-search-message-ids="answer-exact answer-exact">
          <h4 data-conversation-role="assistant">Answer</h4>
          <div data-chatgpt-selection-message-id="answer-exact"><div class="markdown">Result</div></div>
        </div>
      ` });
    });
    await page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    const acknowledgement = await recoverChatGptAcknowledgement(page, 'Question', CONVERSATION_ID);
    assert.equal(acknowledgement?.submittedUserMessageId, 'user-exact');
    const observation = await observeChatGptDom(page, {
      submittedUserMessageId: acknowledgement?.submittedUserMessageId ?? null,
      submittedUserTurnId: acknowledgement?.submittedUserTurnId ?? null,
    });
    assert.equal(observation.submittedUserFound, true);
    assert.equal(observation.candidate?.responseMessageId, 'answer-exact');
    assert.equal(observation.candidate?.answerText, 'Result');
    await page.setContent(`<main>
      <aside role="alert"><button>Earlier notice</button></aside>
      <div data-message-author-role="user" data-message-id="user-exact">Question</div>
    </main>`);
    const identity = { submittedUserMessageId: 'user-exact', submittedUserTurnId: null };
    assert.equal((await observeChatGptDom(page, identity)).actionableAlert, false);
    await page.locator('main').evaluate((main) => {
      const alert = document.createElement('aside');
      alert.setAttribute('role', 'alert');
      alert.innerHTML = '<span>Provider notice</span><button>Action</button>';
      main.append(alert);
    });
    assert.equal((await observeChatGptDom(page, identity)).actionableAlert, true);
    await page.locator('main > aside').last().evaluate(alert => {
      alert.innerHTML = 'network error';
    });
    assert.deepEqual((await observeChatGptDom(page, identity)).providerAlerts, ['network error']);
    await page.locator('main').evaluate((main) => {
      const response = document.createElement('div');
      response.setAttribute('data-message-author-role', 'assistant');
      response.setAttribute('data-message-id', 'partial-answer');
      response.textContent = 'Partial response';
      main.insertBefore(response, main.lastElementChild);
    });
    const interrupted = await observeChatGptDom(page, identity);
    assert.equal(interrupted.actionableAlert, true);
    assert.equal(interrupted.candidate?.responseMessageId, 'partial-answer');
    assert.equal((await observeChatGptDom(page, { ...identity, submittedUserMessageId: 'other-turn' })).actionableAlert, false);
    await page.locator('main').evaluate(main => {
      main.insertAdjacentHTML('beforeend', '<div data-message-author-role="user" data-message-id="human-followup">Please finish the analysis with the corrected evidence.</div>');
    });
    const humanPending = await observeChatGptDom(page, identity);
    assert.equal(humanPending.submittedUserFound, true);
    assert.equal(humanPending.laterUserFound, true);
    assert.equal(humanPending.candidate, null, 'The earlier partial answer must be discarded');
    assert.equal(humanPending.actionableAlert, false, 'An earlier turn alert must not block the follow-up');
    await page.locator('main').evaluate(main => {
      main.insertAdjacentHTML('beforeend', '<div data-message-author-role="assistant" data-message-id="continued-final" data-end-turn="true">Completed review</div>');
    });
    const continued = await observeChatGptDom(page, identity);
    assert.equal(continued.candidate?.responseMessageId, 'continued-final');
    assert.equal(continued.candidate?.answerText, 'Completed review');
    assert.equal(continued.candidate?.terminalMarker, true);
    assert.equal((await observeChatGptDom(page, { ...identity, submittedUserMessageId: 'unrelated' })).candidate, null);

    await page.setContent('<aside role="alert">hostspan-desktop connection expired; reconnect before processing</aside><main><textarea></textarea></main>');
    const global = await observeChatGptDom(page, identity);
    assert.equal(global.submittedUserFound, false);
    assert.equal(global.actionableAlert, true);
    assert.match(global.providerAlerts[0]!, /connection expired/);
    await page.setContent('<main><aside role="alert">Unable to load conversation</aside></main>');
    const failedSurface = await observeChatGptDom(page, identity);
    assert.equal(failedSurface.conversationSurfaceAvailable, false);
    assert.deepEqual(failedSurface.providerAlerts, ['Unable to load conversation']);
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-exact">Question</div><div class="text-token-text-error">network error</div></main>');
    assert.deepEqual((await observeChatGptDom(page, identity)).providerAlerts, ['network error']);
    await page.setContent('<main><div data-message-author-role="user" data-message-id="user-exact"><span class="text-token-text-error">quoted network error</span></div><aside role="alert" hidden>Hidden</aside></main><nav><aside role="alert">Sidebar notice</aside></nav>');
    assert.equal((await observeChatGptDom(page, identity)).actionableAlert, false);

  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT WEB redirect follows only the exact submitted user turn', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-redirect-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });
  const webId = 'WEB:11111111-1111-4111-8111-111111111111';
  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: route.request().url().includes('other-conversation')
          ? observerFixture()
              .replaceAll('user-message-1', 'different-user')
              .replaceAll('user-turn-1', 'different-turn')
          : observerFixture(),
      });
    });
    await created.page.goto(`https://chatgpt.com/c/${webId}`);
    registry.bindPage(created.binding.pageKey, {
      sessionId: 'session-observer',
      generation: 1,
      conversationId: webId,
    });
    t.mock.method(created.page.context().request, 'get', async (url: string) => ({
      status: () => 200, headers: () => ({}), dispose: async () => {},
      json: async () => url.endsWith('/api/auth/session') ? { accessToken: 'fixture-only-token' } : {
        id: CONVERSATION_ID, current_node: 'user', mapping: {
          user: { parent: null, message: { id: 'user-message-1', author: { role: 'user' }, content: { parts: ['Question'] } } },
        },
      },
    }));
    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500,
    });
    const source = await adapter.openObservation({
      session: { ...sessionSnapshot(created.binding.pageKey), conversationId: webId },
      generation: 1,
    });
    try {
      await created.page.goto('https://chatgpt.com/c/other-conversation');
      const wrong = await source.observe();
      assert.equal(wrong.observationTransport, 'stale');

      await created.page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
      const exact = await source.observe();
      assert.equal(exact.observationTransport, 'fresh');
      assert.equal(exact.submittedUserFound, true);
      assert.equal(exact.conversationId, CONVERSATION_ID);
    } finally {
      source.close();
    }

    await created.page.close();
    const restored = await owner.createPage();
    await restored.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: observerFixture() });
    });
    registry.reservePage(restored.binding.pageKey, {
      sessionId: 'session-observer',
      generation: 1,
      conversationId: null,
    });
    await restored.page.goto(`https://chatgpt.com/c/${CONVERSATION_ID}`);
    const recovered = await adapter.recoverAcknowledgement({
      session: { ...sessionSnapshot(restored.binding.pageKey), conversationId: webId },
      generation: 1,
      prompt: 'Question',
    });
    assert.equal(recovered?.conversationId, CONVERSATION_ID);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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

      await target.page.setContent('<main><h1>Conversation cannot be displayed</h1><textarea hidden></textarea></main>');
      const absent = await source.observe();
      assert.equal(absent.errorCode, 'provider.conversation-unavailable');
      assert.equal(absent.reason, 'conversation-surface-unavailable');
      assert.equal(new ExactFinalTracker(1_000).evaluate(absent, Date.now()).kind, 'unverified');
      await target.page.route('**/backend-api/conversations/**', (route) =>
        route.fulfill({ status: 429, contentType: 'application/json', body: '{}' }));
      await target.page.evaluate(async () => { await fetch('/backend-api/conversations/unrelated'); });
      assert.equal((await source.observe()).reason, 'conversation-surface-unavailable');
      await target.page.evaluate(async (id) => { await (await fetch('/backend-api/conversations/' + id)).text(); }, CONVERSATION_ID);
      const unreadable = await source.observe();
      assert.equal(unreadable.errorCode, 'provider.conversation-unavailable');
      await target.page.setContent('<aside role="alert">network error</aside><main><textarea></textarea></main>');
      const alert = await source.observe();
      assert.equal(alert.errorCode, 'provider.actionable-alert');
      assert.equal(alert.reason, 'provider-actionable-alert');
      assert.equal(new ExactFinalTracker(1_000).evaluate(alert, Date.now()).kind, 'unverified');
      assert.equal(unreadable.observationTransport, 'unavailable');
      assert.equal(new ExactFinalTracker(1_000).evaluate(unreadable, Date.now()).kind, 'unverified');
      await target.page.locator('[role="alert"]').evaluate(element => element.remove());
      await target.page.locator('textarea').evaluate(element => { element.hidden = false; });
      const readable = await source.observe();
      assert.equal(readable.errorCode, undefined);
      assert.equal(readable.observationTransport, 'fresh');
      assert.equal(readable.submittedUserFound, false);
      await target.page.setContent(observerFixture());
      const restored = await source.observe();
      assert.equal(restored.errorCode, undefined);
      assert.equal(restored.submittedUserFound, true);

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
