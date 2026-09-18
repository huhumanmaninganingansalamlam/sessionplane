import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry, PageRegistryError } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { ChatGptSubmission } from '../../src/providers/chatgpt/submission.ts';

test('ChatGPT submission captures exact model, conversation, and user-turn acknowledgement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-submit-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-exact',
      generation: 1,
      conversationId: null,
    });

    const request = {
      session: sessionSnapshot({
        sessionId: 'session-exact',
        pageKey: created.binding.pageKey,
      }),
      generation: 1,
      prompt: 'Exact prompt body',
      model: 'Model B',
    } as const;
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request,
      acknowledgementTimeoutMs: 2_000,
    });

    await submission.prepare();
    assert.equal(
      await created.page.locator('[data-testid="model-switcher-dropdown-button"]').textContent(),
      'Model B',
    );
    assert.equal(await created.page.locator('#prompt-textarea').textContent(), request.prompt);

    await submission.submitOnce();
    const acknowledgement = await submission.captureAcknowledgement();
    assert.deepEqual(acknowledgement, {
      conversationId: 'conversation-123456',
      submittedUserMessageId: 'user-message-1',
      submittedUserTurnId: 'user-turn-1',
    });
    assert.equal(await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount), 1);

    assert.notEqual(acknowledgement, null);
    if (acknowledgement !== null) {
      submission.bindAcknowledgement(acknowledgement);
    }
    const binding = registry.getBinding(created.binding.pageKey);
    assert.equal(binding.state, 'owned');
    assert.equal(binding.sessionId, 'session-exact');
    assert.equal(binding.generation, 1);
    assert.equal(binding.conversationId, 'conversation-123456');

    await created.page.goto('https://chatgpt.com/c/another-conversation-999');
    assert.equal(registry.getBinding(created.binding.pageKey).state, 'identity_lost');
    assert.throws(
      () =>
        registry.requireSessionPage(created.binding.pageKey, {
          sessionId: 'session-exact',
          generation: 1,
          conversationId: 'conversation-123456',
        }),
      /does not have verifiable session ownership/,
    );

    await created.page.goto('https://chatgpt.com/c/conversation-123456');
    const restored = registry.getBinding(created.binding.pageKey);
    assert.equal(restored.state, 'owned');

    const duplicate = await owner.createPage();
    await duplicate.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>duplicate</main>' });
    });
    await duplicate.page.goto('https://chatgpt.com/c/conversation-123456');
    assert.ok(
      registry
        .findByConversation('conversation-123456')
        .every((candidate) => candidate.state === 'conflict'),
    );
    if (acknowledgement === null) {
      assert.fail('Expected an exact acknowledgement before duplicate-page validation');
    }
    assert.throws(
      () => submission.bindAcknowledgement(acknowledgement),
      (error: unknown) =>
        error instanceof PageRegistryError &&
        error.errorCode === 'session.page-identity-unverified',
    );

    const drifted = await owner.createPage();
    await drifted.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>drifted</main>' });
    });
    await drifted.page.goto('https://chatgpt.com/');
    registry.refreshPage(drifted.binding.pageKey);
    registry.reservePage(drifted.binding.pageKey, {
      sessionId: 'session-drifted',
      generation: 1,
      conversationId: null,
    });
    await drifted.page.goto('https://chatgpt.com/c/unexpected-conversation-123');
    assert.equal(registry.getBinding(drifted.binding.pageKey).state, 'identity_lost');
    assert.throws(
      () =>
        registry.requireSessionPage(drifted.binding.pageKey, {
          sessionId: 'session-drifted',
          generation: 1,
          conversationId: null,
        }),
      (error: unknown) =>
        error instanceof PageRegistryError &&
        error.errorCode === 'session.page-identity-unverified',
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission waits for a controlled composer to commit the filled prompt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-composer-commit-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    const prompt = 'Prompt committed after a controlled-editor render';
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, true, prompt, false, false, true),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-delayed-composer',
      generation: 1,
      conversationId: null,
    });

    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-delayed-composer',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt,
        model: null,
      },
      acknowledgementTimeoutMs: 500,
    });

    await submission.prepare();
    assert.equal(await created.page.locator('#prompt-textarea').textContent(), prompt);
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission accepts an already exact controlled composer value', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-composer-exact-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    const prompt = 'Already exact controlled composer value';
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, false, prompt, true),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-exact-composer',
      generation: 1,
      conversationId: null,
    });

    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-exact-composer',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt,
        model: null,
      },
      acknowledgementTimeoutMs: 500,
    });

    await submission.prepare();
    assert.equal(await created.page.locator('#prompt-textarea').textContent(), prompt);
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission follows the visible composer across a DOM replacement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-composer-replace-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    const prompt = 'Prompt survives visible composer replacement';
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, false, '', false, true),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-replaced-composer',
      generation: 1,
      conversationId: null,
    });

    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-replaced-composer',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt,
        model: null,
      },
      acknowledgementTimeoutMs: 500,
    });

    await submission.prepare();
    const visibleComposer = created.page
      .locator('#prompt-textarea')
      .filter({ visible: true })
      .first();
    assert.equal(await visibleComposer.textContent(), prompt);
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission refuses a disabled requested model before send', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-disabled-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: chatGptFixture(true) });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-disabled',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-disabled',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Do not submit this',
        model: 'Model B',
      },
      acknowledgementTimeoutMs: 500,
    });

    await assert.rejects(
      submission.prepare(),
      (error: unknown) =>
        error instanceof ProviderSubmissionError &&
        error.errorCode === 'provider.model-unavailable' &&
        error.promptSubmitted === false,
    );
    assert.equal(await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount), 0);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission verifies that model selection actually took effect', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-model-ack-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, false),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-model-noop',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-model-noop',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Do not submit under the wrong model',
        model: 'Model B',
      },
      acknowledgementTimeoutMs: 500,
    });

    await assert.rejects(
      submission.prepare(),
      (error: unknown) =>
        error instanceof ProviderSubmissionError &&
        error.errorCode === 'provider.model-unavailable' &&
        error.promptSubmitted === false,
    );
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function sessionSnapshot(overrides: {
  readonly sessionId: string;
  readonly pageKey: string;
}): SessionSnapshot {
  return {
    requestOk: true,
    teamId: '11111111-1111-4111-8111-111111111111',
    roleId: '22222222-2222-4222-8222-222222222222',
    roleKey: 'main',
    sessionId: overrides.sessionId,
    predecessorSessionId: null,
    provider: 'chatgpt',
    generation: 1,
    sessionState: 'submitting',
    providerState: 'pending',
    observationTransport: 'fresh',
    terminal: false,
    waitExpired: false,
    nextCheckAt: null,
    conversationId: null,
    pageKey: overrides.pageKey,
    submittedUserMessageId: null,
    submittedUserTurnId: null,
    responseMessageId: null,
    answerText: null,
    reason: null,
    errorCode: null,
    promptSubmitted: false,
  };
}

function chatGptFixture(
  disabledModel: boolean,
  applyModelSelection = true,
  delayedComposerCommit = false,
  initialComposerText = '',
  stickyComposerValue = false,
  replaceComposerOnInput = false,
  delayedComposerVisibility = false,
): string {
  return `<!doctype html>
    <html>
      <body>
        <button data-testid="model-switcher-dropdown-button" type="button">Model A</button>
        <div id="model-menu" role="menu" hidden>
          <button role="menuitem" type="button" aria-disabled="${disabledModel ? 'true' : 'false'}">Model B</button>
        </div>
        ${delayedComposerVisibility ? '<form><textarea placeholder="Proxy composer"></textarea></form>' : ''}
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true">${initialComposerText}</div>
        <button data-testid="send-button" type="button">Send</button>
        <section id="messages"></section>
        <script>
          window.sendCount = 0;
          const switcher = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
          const menu = document.querySelector('#model-menu');
          const option = menu.querySelector('[role="menuitem"]');
          switcher.addEventListener('click', () => { menu.hidden = false; });
          option.addEventListener('click', () => {
            if (option.getAttribute('aria-disabled') === 'true') return;
            if (!${applyModelSelection}) return;
            switcher.textContent = option.textContent;
            menu.hidden = true;
          });
          const composer = document.querySelector('#prompt-textarea');
          if (${delayedComposerVisibility}) {
            composer.setAttribute('hidden', '');
            setTimeout(() => composer.removeAttribute('hidden'), 150);
          }
          if (${delayedComposerCommit}) {
            composer.addEventListener('input', () => {
              const nextValue = composer.textContent;
              composer.textContent = '';
              setTimeout(() => { composer.textContent = nextValue; }, 150);
            });
          }
          if (${stickyComposerValue}) {
            const exactValue = ${JSON.stringify(initialComposerText)};
            composer.addEventListener('input', () => {
              composer.textContent = exactValue;
            });
          }
          if (${replaceComposerOnInput}) {
            let replaced = false;
            composer.addEventListener('input', () => {
              if (replaced || composer.textContent === '') return;
              replaced = true;
              const replacement = composer.cloneNode(false);
              replacement.textContent = composer.textContent;
              composer.textContent = '';
              composer.setAttribute('hidden', '');
              composer.after(replacement);
            });
          }
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            window.sendCount += 1;
            const prompt = composer.textContent;
            history.pushState({}, '', '/c/conversation-123456');
            const message = document.createElement('article');
            message.setAttribute('data-message-author-role', 'user');
            message.setAttribute('data-message-id', 'user-message-1');
            message.setAttribute('data-turn-id', 'user-turn-1');
            message.textContent = prompt;
            document.querySelector('#messages').appendChild(message);
          });
        </script>
      </body>
    </html>`;
}

