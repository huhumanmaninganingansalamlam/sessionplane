import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry, PageRegistryError } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { ChatGptSubmission, recoverChatGptAcknowledgement } from '../../src/providers/chatgpt/submission.ts';

test('ChatGPT read-only acknowledgement recovery requires one unique exact prompt identity', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-ack-recovery-'));
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
        body: '<html><body><div data-message-author-role="user" data-message-id="user-1" data-turn-id="turn-1"><div class="whitespace-pre-wrap">Recover me exactly</div></div></body></html>',
      });
    });
    await created.page.goto('https://chatgpt.com/c/auditconv123');
    const recovered = await recoverChatGptAcknowledgement(
      created.page,
      'Recover me exactly',
      'auditconv123',
    );
    assert.deepEqual(recovered, {
      conversationId: 'auditconv123',
      submittedUserMessageId: 'user-1',
      submittedUserTurnId: 'turn-1',
    });

    await created.page.setContent(
      '<div data-message-author-role="user" data-message-id="user-1" data-turn-id="turn-1"><div class="whitespace-pre-wrap">Recover me exactly</div></div><div data-message-author-role="user" data-message-id="user-2" data-turn-id="turn-2"><div class="whitespace-pre-wrap">Recover me exactly</div></div>',
    );
    assert.equal(
      await recoverChatGptAcknowledgement(created.page, 'Recover me exactly', 'auditconv123'),
      null,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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

test('ChatGPT submission preserves exact multiline text through ProseMirror block paragraphs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-prosemirror-lines-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    const prompt = [
      '[USER]',
      '## Question',
      'Return exactly MULTILINE_OK.',
      '',
      '[INSTRUCTIONS]',
      'Keep the logical line breaks exact.',
    ].join('\n');
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixture(false, true, false, prompt, false, false, false, true),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-prosemirror-lines',
      generation: 1,
      conversationId: null,
    });

    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-prosemirror-lines',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt,
        model: null,
      },
      acknowledgementTimeoutMs: 2_000,
    });

    await submission.prepare();
    assert.equal(
      await created.page.locator('#prompt-textarea').evaluate((element) =>
        Array.from(element.children)
          .map((child) => child.textContent ?? '')
          .join('\n'),
      ),
      prompt,
    );

    await submission.submitOnce();
    assert.deepEqual(await submission.captureAcknowledgement(), {
      conversationId: 'conversation-123456',
      submittedUserMessageId: 'user-message-1',
      submittedUserTurnId: 'user-turn-1',
    });
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

test('ChatGPT submission resolves Pro family to the highest enabled discovered model', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-pro-family-'));
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
        body: chatGptModelFixture('5.6 Pro', [
          { label: '5.6 Pro' },
          { label: '6 Pro' },
          { label: 'Instant' },
        ]),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-pro-family-highest',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-pro-family-highest',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Use the best available Pro model',
        model: 'Pro',
      },
      acknowledgementTimeoutMs: 500,
    });

    await submission.prepare();
    assert.equal(
      await created.page.locator('[data-testid="model-switcher-dropdown-button"]').textContent(),
      '6 Pro',
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

test('ChatGPT submission falls back to the next enabled Pro model', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-pro-fallback-'));
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
        body: chatGptModelFixture('6 Pro', [
          { label: '6 Pro', disabled: true },
          { label: '5.6 Pro' },
          { label: 'Instant' },
        ]),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-pro-family-fallback',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-pro-family-fallback',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Fall back within the Pro family',
        model: 'Pro',
      },
      acknowledgementTimeoutMs: 500,
    });

    await submission.prepare();
    assert.equal(
      await created.page.locator('[data-testid="model-switcher-dropdown-button"]').textContent(),
      '5.6 Pro',
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

test('ChatGPT submission selects the live intelligence Pro preset without misclassifying Chat as Work', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-live-pro-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await routeIntelligenceFixture(created.page, {
      latestProLocked: false,
      selectedVersion: 'latest',
      selectedPreset: 3,
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-live-pro',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-live-pro',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Use the best available Pro model',
        model: 'Pro',
        effort: 'Extra High',
      },
      acknowledgementTimeoutMs: 500,
    });

    await submission.prepare();
    assert.equal(
      await created.page
        .locator('[data-model-reasoning-effort-slider] [role="slider"]')
        .getAttribute('aria-valuenow'),
      '4',
    );
    assert.equal(
      await created.page
        .locator(
          '[data-testid="composer-model-picker-slider-advanced-view"] [role="menuitemradio"][aria-checked="true"]',
        )
        .getAttribute('data-version-id'),
      'latest',
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

test('ChatGPT submission falls back from a locked latest Pro preset to the next available Pro version', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-live-pro-fallback-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await routeIntelligenceFixture(created.page, {
      latestProLocked: true,
      selectedVersion: 'latest',
      selectedPreset: 3,
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-live-pro-fallback',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-live-pro-fallback',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Fall back to the next unlocked Pro version',
        model: 'Pro',
      },
      acknowledgementTimeoutMs: 500,
    });

    await submission.prepare();
    assert.equal(
      await created.page
        .locator(
          '[data-testid="composer-model-picker-slider-advanced-view"] [role="menuitemradio"][aria-checked="true"]',
        )
        .getAttribute('data-version-id'),
      '5.6',
    );
    assert.equal(
      await created.page
        .locator('[data-model-reasoning-effort-slider] [role="slider"]')
        .getAttribute('aria-valuenow'),
      '4',
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
test('ChatGPT submission uses live intelligence slider when capability feed exposes only Instant', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-live-slider-fallback-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  const cases = [
    {
      name: 'semantic Pro',
      model: 'Pro',
      effort: null,
      expectedVersion: 'latest',
      expectedPreset: '4',
    },
    {
      name: 'exact GPT-5.6 Pro',
      model: 'GPT-5.6 Pro',
      effort: null,
      expectedVersion: '5.6',
      expectedPreset: '4',
    },
    {
      name: 'Extra High effort',
      model: null,
      effort: 'Extra High',
      expectedVersion: 'latest',
      expectedPreset: '3',
    },
  ] as const;

  try {
    await owner.start();
    for (const [index, testCase] of cases.entries()) {
      const created = await owner.createPage();
      await routeIntelligenceFixture(created.page, {
        latestProLocked: false,
        selectedVersion: 'latest',
        selectedPreset: 0,
        backendPresets: 'instant-only',
      });
      await created.page.goto('https://chatgpt.com/');
      registry.refreshPage(created.binding.pageKey);
      const sessionId = 'session-live-slider-fallback-' + String(index);
      registry.reservePage(created.binding.pageKey, {
        sessionId,
        generation: 1,
        conversationId: null,
      });
      const submission = new ChatGptSubmission({
        page: created.page,
        pageKey: created.binding.pageKey,
        pageRegistry: registry,
        request: {
          session: sessionSnapshot({
            sessionId,
            pageKey: created.binding.pageKey,
          }),
          generation: 1,
          prompt: 'Prepare only with incomplete capabilities: ' + testCase.name,
          model: testCase.model,
          effort: testCase.effort,
        },
        acknowledgementTimeoutMs: 500,
      });

      await submission.prepare();
      assert.equal(
        await created.page
          .locator('[data-model-reasoning-effort-slider] [role="slider"]')
          .getAttribute('aria-valuenow'),
        testCase.expectedPreset,
        testCase.name,
      );
      assert.equal(
        await created.page
          .locator(
            '[data-testid="composer-model-picker-slider-advanced-view"] [role="menuitemradio"][aria-checked="true"]',
          )
          .getAttribute('data-version-id'),
        testCase.expectedVersion,
        testCase.name,
      );
      assert.equal(
        await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
        0,
        testCase.name,
      );
      await created.page.close();
    }
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission classifies a proven logged-out auth session before model selection', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-auth-required-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await routeIntelligenceFixture(created.page, {
      latestProLocked: false,
      selectedVersion: 'latest',
      selectedPreset: 0,
      authenticated: false,
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-auth-required',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-auth-required',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'This must not reach model selection or submit.',
        model: 'Pro',
      },
      acknowledgementTimeoutMs: 500,
    });

    await assert.rejects(
      submission.prepare(),
      (error: unknown) =>
        error instanceof ProviderSubmissionError &&
        error.errorCode === 'provider.authentication-required' &&
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

test('ChatGPT submission does not classify the ordinary intelligence picker as Work', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-intelligence-chat-'));
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
        body: [
          '<!doctype html><html><body>',
          '<div data-testid="composer-model-picker-slider-simple-view" data-active="true"></div>',
          '<form>',
          '<textarea id="prompt-textarea" placeholder="Ask ChatGPT"></textarea>',
          '<button data-testid="send-button" type="button">Send</button>',
          '</form>',
          '<script>window.sendCount=0;document.querySelector("[data-testid=\\"send-button\\"]").addEventListener("click",()=>{window.sendCount+=1;});</script>',
          '</body></html>',
        ].join(''),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-intelligence-chat',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-intelligence-chat',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Ordinary Chat must remain supported',
        model: null,
      },
      acknowledgementTimeoutMs: 500,
    });

    await submission.prepare();
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT submission extends acknowledgement while exact user identity hydrates', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-late-ack-'));
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
        body: chatGptFixture(false, true, false, '', false, false, false, false, null, 180),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'session-late-ack',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot({
          sessionId: 'session-late-ack',
          pageKey: created.binding.pageKey,
        }),
        generation: 1,
        prompt: 'Exact prompt whose user identity hydrates late',
        model: null,
      },
      acknowledgementTimeoutMs: 100,
    });

    await submission.prepare();
    await submission.submitOnce();
    assert.deepEqual(await submission.captureAcknowledgement(), {
      conversationId: 'conversation-123456',
      submittedUserMessageId: 'user-message-1',
      submittedUserTurnId: 'user-turn-1',
    });
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      1,
    );
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
  proseMirrorBlocks = false,
  modelFixture: {
    readonly current: string;
    readonly options: readonly { readonly label: string; readonly disabled?: boolean }[];
  } | null = null,
  acknowledgementIdentityDelayMs = 0,
): string {
  const modelState = modelFixture ?? {
    current: 'Model A',
    options: [{ label: 'Model B', disabled: disabledModel }],
  };
  const modelOptionsMarkup = modelState.options
    .map(
      (option) =>
        `<button role="menuitem" type="button" aria-disabled="${option.disabled === true ? 'true' : 'false'}">${escapeHtml(option.label)}</button>`,
    )
    .join('');
  const initialComposerMarkup = proseMirrorBlocks
    ? initialComposerText
        .split('\n')
        .map((line) =>
          line === ''
            ? '<p data-empty-paragraph="true"><br class="ProseMirror-trailingBreak"></p>'
            : `<p>${escapeHtml(line)}</p>`,
        )
        .join('')
    : initialComposerText;
  return `<!doctype html>
    <html>
      <body>
        <button data-testid="model-switcher-dropdown-button" type="button">${escapeHtml(modelState.current)}</button>
        <div id="model-menu" role="menu" hidden>
          ${modelOptionsMarkup}
        </div>
        ${delayedComposerVisibility ? '<form><textarea placeholder="Proxy composer"></textarea></form>' : ''}
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true">${initialComposerMarkup}</div>
        <button data-testid="send-button" type="button">Send</button>
        <section id="messages"></section>
        <script>
          window.sendCount = 0;
          const switcher = document.querySelector('[data-testid="model-switcher-dropdown-button"]');
          const menu = document.querySelector('#model-menu');
          switcher.addEventListener('click', () => { menu.hidden = false; });
          for (const option of menu.querySelectorAll('[role="menuitem"]')) {
            option.addEventListener('click', () => {
              if (option.getAttribute('aria-disabled') === 'true') return;
              if (!${applyModelSelection}) return;
              switcher.textContent = option.textContent;
              menu.hidden = true;
            });
          }
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
          if (${proseMirrorBlocks}) {
            composer.addEventListener('input', () => {
              const value = composer.innerText;
              const blocks = value.split('\\n').map((line) => {
                const paragraph = document.createElement('p');
                if (line === '') {
                  paragraph.appendChild(document.createElement('br'));
                } else {
                  paragraph.textContent = line;
                }
                return paragraph;
              });
              composer.replaceChildren(...blocks);
            });
          }
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            window.sendCount += 1;
            const prompt = ${proseMirrorBlocks}
              ? Array.from(composer.children).map((child) => child.textContent ?? '').join('\\n')
              : composer.textContent;
            history.pushState({}, '', '/c/conversation-123456');
            const message = document.createElement('article');
            message.setAttribute('data-message-author-role', 'user');
            const hydrateIdentity = () => {
              message.setAttribute('data-message-id', 'user-message-1');
              message.setAttribute('data-turn-id', 'user-turn-1');
            };
            if (${acknowledgementIdentityDelayMs} > 0) {
              setTimeout(hydrateIdentity, ${acknowledgementIdentityDelayMs});
            } else {
              hydrateIdentity();
            }
            if (${proseMirrorBlocks}) {
              const content = document.createElement('div');
              content.setAttribute('data-testid', 'collapsible-user-message-content');
              const body = document.createElement('div');
              body.className = 'whitespace-pre-wrap';
              body.textContent = prompt;
              content.appendChild(body);
              const toggle = document.createElement('button');
              toggle.textContent = 'Show moreShow less';
              message.append(content, toggle);
            } else {
              message.textContent = prompt;
            }
            document.querySelector('#messages').appendChild(message);
          });
        </script>
      </body>
    </html>`;
}

function chatGptModelFixture(
  current: string,
  options: readonly { readonly label: string; readonly disabled?: boolean }[],
): string {
  return chatGptFixture(false, true, false, '', false, false, false, false, {
    current,
    options,
  });
}

async function routeIntelligenceFixture(
  page: import('playwright-core').Page,
  options: {
    readonly latestProLocked: boolean;
    readonly selectedVersion: 'latest' | '5.6';
    readonly selectedPreset: number;
    readonly backendPresets?: 'complete' | 'instant-only';
    readonly authenticated?: boolean;
  },
): Promise<void> {
  await page.route('https://chatgpt.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          options.authenticated === false
            ? { WARNING_BANNER: 'fixture logged out' }
            : {
                user: { id: 'fixture-user' },
                WARNING_BANNER: 'no access token required for same-origin models',
              },
        ),
      });
      return;
    }
    if (url.pathname === '/backend-api/models') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(intelligenceModelsFixture(options.backendPresets ?? 'complete')),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: chatGptIntelligenceFixture(options),
    });
  });
}

function intelligenceModelsFixture(mode: 'complete' | 'instant-only' = 'complete') {
  if (mode === 'instant-only') {
    return {
      default_model_slug: 'auto',
      model_picker_version: 2,
      versions: [
        {
          id: '5.6',
          display_text: 'Latest • 5.6',
          display_text_for_intelligence: 'GPT-5.6 Sol',
          enabled: true,
          intelligence_presets: [
            {
              title: 'Instant',
              model_slug: 'gpt-5-6',
              lane: 'instant',
              preset_type: 'available',
            },
          ],
        },
        { id: 'auto', display_text: 'Auto', enabled: true, intelligence_presets: [] },
      ],
    };
  }
  return {
    default_model_slug: 'gpt-5-6',
    model_picker_version: 2,
    versions: [
      {
        id: 'latest',
        display_text: 'Latest',
        display_text_for_intelligence: 'Latest',
        enabled: true,
        intelligence_presets: [
          { title: 'Instant', model_slug: 'gpt-5-6-instant', lane: 'instant', preset_type: 'available' },
          {
            title: 'Medium',
            model_slug: 'gpt-5-6-thinking',
            lane: 'thinking',
            thinking_effort: 'standard',
            preset_type: 'available',
          },
          {
            title: 'High',
            model_slug: 'gpt-5-6-thinking',
            lane: 'thinking',
            thinking_effort: 'extended',
            preset_type: 'available',
          },
          {
            title: 'Very High',
            model_slug: 'gpt-5-6-thinking',
            lane: 'thinking',
            thinking_effort: 'max',
            preset_type: 'available',
          },
          {
            title: 'Pro',
            selected_display_title: 'Pro',
            selected_display_version: '6',
            model_slug: 'gpt-6-pro',
            lane: 'pro',
            preset_type: 'available',
          },
        ],
      },
      {
        id: '5.6',
        display_text: '5.6',
        display_text_for_intelligence: 'GPT-5.6 Sol',
        enabled: true,
        intelligence_presets: [
          { title: 'Instant', model_slug: 'gpt-5-6-instant', lane: 'instant', preset_type: 'available' },
          {
            title: 'Medium',
            model_slug: 'gpt-5-6-thinking',
            lane: 'thinking',
            thinking_effort: 'standard',
            preset_type: 'available',
          },
          {
            title: 'High',
            model_slug: 'gpt-5-6-thinking',
            lane: 'thinking',
            thinking_effort: 'extended',
            preset_type: 'available',
          },
          {
            title: 'Very High',
            model_slug: 'gpt-5-6-thinking',
            lane: 'thinking',
            thinking_effort: 'max',
            preset_type: 'available',
          },
          {
            title: 'Pro',
            selected_display_title: 'Pro',
            selected_display_version: '5.6',
            model_slug: 'gpt-5-6-pro',
            lane: 'pro',
            preset_type: 'available',
          },
        ],
      },
    ],
  };
}

function chatGptIntelligenceFixture(options: {
  readonly latestProLocked: boolean;
  readonly selectedVersion: 'latest' | '5.6';
  readonly selectedPreset: number;
}): string {
  const dots = [0, 1, 2, 3, 4]
    .map(
      (index) =>
        '<span data-dot="' +
        String(index) +
        '" data-locked="' +
        String(options.latestProLocked && index === 4) +
        '" data-selected="' +
        String(index <= options.selectedPreset) +
        '"></span>',
    )
    .join('');
  return [
    '<!doctype html><html><body>',
    '<div role="radiogroup" aria-label="Chat surface">',
    '<button role="radio" type="button" aria-checked="true" data-state="on">Chat</button>',
    '<button role="radio" type="button" aria-checked="false" data-state="off">Work</button>',
    '</div>',
    '<form>',
    '<textarea id="prompt-textarea" placeholder="Ask ChatGPT"></textarea>',
    '<button data-testid="composer-plus-btn" type="button" aria-haspopup="menu">+</button>',
    '<button id="intelligence-button" type="button" aria-haspopup="menu" data-state="closed">Very High</button>',
    '<button data-testid="send-button" type="button">Send</button>',
    '</form>',
    '<div id="intelligence-menu" role="menu" data-state="closed" hidden>',
    '<div data-testid="composer-intelligence-picker-content" role="group">',
    '<div id="picker-root" data-expanded="false"><div role="menuitem" tabindex="0">Model selection</div></div>',
    '<div data-testid="composer-model-picker-slider-simple-view" data-active="true">',
    '<div id="slider-control" role="menuitem" tabindex="0" aria-label="Performance">',
    '<div data-model-reasoning-effort-slider><span data-locked="false"></span>',
    dots,
    '<span role="slider" tabindex="-1" style="display:inline-block;width:120px;height:20px" aria-valuemin="0" aria-valuemax="4" aria-valuenow="' +
      String(options.selectedPreset) +
      '"></span></div></div>',
    '<span id="slider-announcement"></span>',
    '</div>',
    '<div data-testid="composer-model-picker-slider-advanced-view" data-active="false">',
    '<div role="menuitemradio" data-version-id="latest" aria-checked="' +
      String(options.selectedVersion === 'latest') +
      '" data-state="' +
      (options.selectedVersion === 'latest' ? 'checked' : 'unchecked') +
      '">Latest</div>',
    '<div role="menuitemradio" data-version-id="5.6" aria-checked="' +
      String(options.selectedVersion === '5.6') +
      '" data-state="' +
      (options.selectedVersion === '5.6' ? 'checked' : 'unchecked') +
      '">GPT-5.6 Sol</div>',
    '</div></div></div>',
    '<script>',
    'window.sendCount=0;',
    'let selectedVersion=' + JSON.stringify(options.selectedVersion) + ';',
    'let selectedPreset=' + String(options.selectedPreset) + ';',
    'const lockedByVersion={latest:[false,false,false,false,' +
      String(options.latestProLocked) +
      '],"5.6":[false,false,false,false,false]};',
    'const labels=["Instant","Medium","High","Very High","Pro"];',
    'const button=document.querySelector("#intelligence-button");',
    'const menu=document.querySelector("#intelligence-menu");',
    'const root=document.querySelector("#picker-root");',
    'const simple=document.querySelector("[data-testid=\\"composer-model-picker-slider-simple-view\\"]");',
    'const advanced=document.querySelector("[data-testid=\\"composer-model-picker-slider-advanced-view\\"]");',
    'const slider=document.querySelector("[role=\\"slider\\"]");',
    'const sliderControl=document.querySelector("#slider-control");',
    'const announcement=document.querySelector("#slider-announcement");',
    'const dotNodes=Array.from(document.querySelectorAll("[data-dot]"));',
    'const update=()=>{button.textContent=labels[selectedPreset];slider.setAttribute("aria-valuenow",String(selectedPreset));dotNodes.forEach((dot,index)=>{dot.setAttribute("data-locked",String(lockedByVersion[selectedVersion][index]));dot.setAttribute("data-selected",String(index<=selectedPreset));});for(const radio of advanced.querySelectorAll("[role=\\"menuitemradio\\"]")){const checked=radio.getAttribute("data-version-id")===selectedVersion;radio.setAttribute("aria-checked",String(checked));radio.setAttribute("data-state",checked?"checked":"unchecked");}};',
    'button.addEventListener("click",()=>{menu.hidden=false;menu.setAttribute("data-state","open");button.setAttribute("data-state","open");});',
    'root.querySelector("[role=\\"menuitem\\"]").addEventListener("click",()=>{root.setAttribute("data-expanded","true");simple.setAttribute("data-active","false");advanced.setAttribute("data-active","true");});',
    'for(const radio of advanced.querySelectorAll("[role=\\"menuitemradio\\"]")){radio.addEventListener("click",()=>{selectedVersion=radio.getAttribute("data-version-id");selectedPreset=Math.min(selectedPreset,3);root.setAttribute("data-expanded","false");simple.setAttribute("data-active","true");advanced.setAttribute("data-active","false");update();});}',
    'slider.addEventListener("keydown",(event)=>{if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;const direction=event.key==="ArrowRight"?1:-1;const next=Math.max(0,Math.min(4,selectedPreset+direction));if(lockedByVersion[selectedVersion][next])return;selectedPreset=next;update();});',
    'document.querySelector("[data-testid=\\"send-button\\"]").addEventListener("click",()=>{window.sendCount+=1;});',
    'sliderControl.addEventListener("keydown",(event)=>{if(event.key!=="ArrowLeft"&&event.key!=="ArrowRight")return;const direction=event.key==="ArrowRight"?1:-1;const next=Math.max(0,Math.min(4,selectedPreset+direction));if(lockedByVersion[selectedVersion][next])return;selectedPreset=next;update();announcement.textContent=labels[selectedPreset]+", 5 of 5.";});',
    'update();announcement.textContent=labels[selectedPreset]+", 5 of 5.";',
    '</script></body></html>',
  ].join('');
}
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

