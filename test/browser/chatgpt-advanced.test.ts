import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import type { ProviderAttachment } from '../../src/providers/provider-adapter.ts';
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';
import { ChatGptSubmission } from '../../src/providers/chatgpt/submission.ts';
import { navigateProviderPage } from '../../src/providers/human-verification.ts';

test('ChatGPT Chat prepares exact attachments before one submit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-advanced-'));
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
        body: advancedFixture(),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'advanced-session',
      generation: 1,
      conversationId: null,
    });

    const first = attachment(root, 'context-one.txt', 'first context');
    const second = attachment(root, 'context-two.md', '# second context');
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: sessionSnapshot(created.binding.pageKey),
        generation: 1,
        prompt: 'Perform the exact Chat task',
        model: null,
        effort: null,
        surface: 'chat',
        attachments: [first, second],
      },
      acknowledgementTimeoutMs: 2_000,
    });

    await submission.prepare();
    assert.equal(await created.page.locator('#chat').getAttribute('aria-checked'), 'true');
    assert.deepEqual(
      await created.page.locator('[data-testid="attachment-pill"]').allTextContents(),
      ['context-one.txt', 'context-two.md'],
    );
    assert.equal(
      await created.page.locator('#prompt-textarea').textContent(),
      'Perform the exact Chat task',
    );
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );

    await submission.submitOnce();
    const acknowledgement = await submission.captureAcknowledgement();
    assert.deepEqual(acknowledgement, {
      conversationId: 'advanced-conversation-123456',
      submittedUserMessageId: 'advanced-user-message-1',
      submittedUserTurnId: 'advanced-user-turn-1',
    });
    if (acknowledgement === null) throw new Error('missing acknowledgement');
    submission.bindAcknowledgement(acknowledgement);
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      1,
    );

    await created.page.evaluate(() => {
      const artifact = document.createElement('a');
      artifact.download = 'diagram.png';
      artifact.href = 'data:image/png;base64,UE5HREFUQQ==';
      artifact.textContent = 'Download diagram';
      document.body.appendChild(artifact);
    });
    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 2_000,
    });
    const observedSession: SessionSnapshot = {
      ...sessionSnapshot(created.binding.pageKey),
      conversationId: acknowledgement.conversationId,
      submittedUserMessageId: acknowledgement.submittedUserMessageId,
      submittedUserTurnId: acknowledgement.submittedUserTurnId,
      promptSubmitted: true,
      sessionState: 'complete',
      providerState: 'completed',
      terminal: true,
    };
    const candidates = await adapter.discoverArtifacts?.({
      session: observedSession,
      generation: 1,
    });
    const image = candidates?.find((candidate) => candidate.name === 'diagram.png');
    assert.notEqual(image, undefined);
    if (image === undefined) throw new Error('missing image candidate');
    const downloaded = await adapter.downloadArtifact?.(
      { session: observedSession, generation: 1 },
      image,
    );
    assert.equal(Buffer.from(downloaded?.bytes ?? []).toString('utf8'), 'PNGDATA');
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT replaces only a missing unsubmitted Page after restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-stale-page-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const stale = await owner.createPage();
    await stale.page.close();
    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500,
    });
    const staleSession: SessionSnapshot = {
      ...sessionSnapshot(stale.binding.pageKey),
      generation: 2,
      sessionState: 'ready',
      providerState: 'error',
      errorCode: 'provider.composer-unavailable',
      reason: 'pre-submit-failure',
      promptSubmitted: false,
    };

    const replacement = await adapter.openSubmission({
      session: staleSession,
      generation: 3,
      prompt: 'Safe retry after a pre-submit failure',
      model: null,
    });
    assert.notEqual(replacement.pageKey, stale.binding.pageKey);
    const replacementBinding = registry.getBinding(replacement.pageKey);
    assert.equal(replacementBinding.state, 'reserved');
    assert.equal(replacementBinding.sessionId, staleSession.sessionId);
    assert.equal(replacementBinding.generation, 3);

    await assert.rejects(
      adapter.openSubmission({
        session: { ...staleSession, promptSubmitted: true },
        generation: 4,
        prompt: 'Never replace an ambiguously submitted Page',
        model: null,
      }),
      (error: unknown) =>
        error instanceof Error &&
        'errorCode' in error &&
        error.errorCode === 'browser.unavailable',
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT pre-submit retry re-navigates an open blank reserved Page', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-blank-retry-'));
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
        body: advancedFixture(),
      });
    });
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'advanced-session',
      generation: 1,
      conversationId: null,
    });
    const failed: SessionSnapshot = {
      ...sessionSnapshot(created.binding.pageKey),
      sessionState: 'ready',
      providerState: 'error',
      observationTransport: 'unavailable',
      errorCode: 'browser.unavailable',
      reason: 'pre-submit-failure',
      promptSubmitted: false,
    };
    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500,
    });
    const retry = await adapter.openSubmission({
      session: failed,
      generation: 2,
      prompt: 'Retry safely from the blank Page',
      model: null,
    });
    assert.equal(retry.pageKey, created.binding.pageKey);
    await retry.prepare();
    assert.equal(new URL(created.page.url()).origin, 'https://chatgpt.com');
    assert.equal(
      await created.page.locator('#prompt-textarea').textContent(),
      'Retry safely from the blank Page',
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

test('ChatGPT follow-up reopens the exact conversation when the durable pageKey is stale', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-followup-rebind-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const routingPage = await owner.createPage();
    await routingPage.page.context().route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: advancedFixture(),
      });
    });
    const stalePageKey = routingPage.binding.pageKey;
    registry.detach();
    assert.equal(registry.getBinding(stalePageKey).state, 'closed');
    const adapter = new ChatGptAdapter({
      browserOwner: owner,
      pageRegistry: registry,
      loginUrl: 'https://chatgpt.com/',
      acknowledgementTimeoutMs: 500,
    });
    const conversationId = '6aacf04a-4964-83e9-8954-fc317621f157';
    const preparedSession: SessionSnapshot = {
      ...sessionSnapshot(stalePageKey),
      sessionId: 'restart-followup-session',
      generation: 2,
      sessionState: 'submitting',
      providerState: 'pending',
      terminal: false,
      conversationId,
      promptSubmitted: false,
      answerText: null,
      responseMessageId: null,
    };

    const submission = await adapter.openSubmission({
      session: preparedSession,
      generation: 2,
      prompt: 'Continue the exact durable conversation',
      model: null,
    });
    assert.notEqual(submission.pageKey, preparedSession.pageKey);
    const binding = registry.getBinding(submission.pageKey);
    assert.equal(binding.state, 'owned');
    assert.equal(binding.sessionId, preparedSession.sessionId);
    assert.equal(binding.generation, 2);
    assert.equal(binding.conversationId, conversationId);
    assert.equal(
      registry.pageForObservation(submission.pageKey).url(),
      `https://chatgpt.com/c/${conversationId}`,
    );

    await submission.prepare();
    assert.equal(
      await registry
        .pageForObservation(submission.pageKey)
        .locator('#prompt-textarea')
        .textContent(),
      'Continue the exact durable conversation',
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT Work surface is rejected before composer mutation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-work-rejected-'));
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
        body: workSurfaceFixture(),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'work-rejected-session',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: {
          ...sessionSnapshot(created.binding.pageKey),
          sessionId: 'work-rejected-session',
        },
        generation: 1,
        prompt: 'This must not enter Work.',
        model: null,
        surface: 'chat',
      },
      acknowledgementTimeoutMs: 1_000,
    });

    await assert.rejects(
      submission.prepare(),
      (error: unknown) =>
        error instanceof Error &&
        'errorCode' in error &&
        error.errorCode === 'capability.unsupported',
    );
    assert.equal(await created.page.locator('#prompt-textarea').textContent(), '');
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider navigation surfaces visible verification before DOM readiness timeout', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-navigation-verification-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });
  let slowResourceReleased = false;

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      if (route.request().url().endsWith('/slow-verification.js')) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        slowResourceReleased = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: '',
        });
        return;
      }
      await route.fulfill({
        status: 403,
        headers: { 'cf-mitigated': 'challenge' },
        contentType: 'text/html',
        body:
          '<!doctype html>' +
          '<title>Just a moment...</title>' +
          '<section id="challenge-stage" style="width:320px;height:120px">Verify</section>' +
          '<script src="/slow-verification.js"></script>',
      });
    });

    await assert.rejects(
      navigateProviderPage({
        page: created.page,
        provider: 'chatgpt',
        pageKey: created.binding.pageKey,
        url: 'https://chatgpt.com/',
        timeoutMs: 5_000,
      }),
      (error: unknown) =>
        error instanceof Error &&
        'errorCode' in error &&
        error.errorCode === 'provider.human-action-required',
    );
    assert.equal(slowResourceReleased, false);
    assert.equal(created.page.isClosed(), false);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('visible browser verification is handed to a human before composer mutation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-verification-'));
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
        body: humanVerificationFixture(),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'verification-session',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: {
          ...sessionSnapshot(created.binding.pageKey),
          sessionId: 'verification-session',
        },
        generation: 1,
        prompt: 'This must remain untouched.',
        model: null,
        surface: 'chat',
      },
      acknowledgementTimeoutMs: 1_000,
    });

    await assert.rejects(
      submission.prepare(),
      (error: unknown) =>
        error instanceof Error &&
        'errorCode' in error &&
        error.errorCode === 'provider.human-action-required' &&
        'details' in error &&
        (error.details as Record<string, unknown>).requiresHumanAction === true,
    );
    assert.equal(await created.page.locator('#prompt-textarea').textContent(), '');
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
    assert.equal(created.page.isClosed(), false);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ChatGPT named Deep Research mode must acknowledge selection before submit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chatgpt-deep-research-'));
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
        body: namedModeFixture(),
      });
    });
    await created.page.goto('https://chatgpt.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'deep-research-session',
      generation: 1,
      conversationId: null,
    });
    const submission = new ChatGptSubmission({
      page: created.page,
      pageKey: created.binding.pageKey,
      pageRegistry: registry,
      request: {
        session: { ...sessionSnapshot(created.binding.pageKey), sessionId: 'deep-research-session' },
        generation: 1,
        prompt: 'Research exact primary sources.',
        model: null,
        surface: 'deep-research',
      },
      acknowledgementTimeoutMs: 1_000,
    });

    await submission.prepare();
    assert.equal(
      await created.page.locator('[data-testid="composer-tools"]').textContent(),
      'Deep Research',
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

function attachment(root: string, name: string, content: string): ProviderAttachment {
  const filePath = path.join(root, name);
  const bytes = Buffer.from(content, 'utf8');
  writeFileSync(filePath, bytes);
  return {
    path: filePath,
    name,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mediaType: name.endsWith('.md') ? 'text/markdown' : 'text/plain',
  };
}

function sessionSnapshot(pageKey: string): SessionSnapshot {
  return {
    requestOk: true,
    teamId: '11111111-1111-4111-8111-111111111111',
    roleId: '22222222-2222-4222-8222-222222222222',
    roleKey: 'main',
    sessionId: 'advanced-session',
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
    pageKey,
    submittedUserMessageId: null,
    submittedUserTurnId: null,
    responseMessageId: null,
    answerText: null,
    reason: null,
    errorCode: null,
    promptSubmitted: false,
  };
}

function advancedFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <div role="radiogroup">
          <button id="chat" role="radio" aria-checked="true" type="button">Chat</button>
          <button id="work" role="radio" aria-checked="false" type="button">Work</button>
        </div>
        <input id="files" type="file" multiple>
        <div id="attachments"></div>
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button" type="button">Send</button>
        <section id="messages"></section>
        <script>
          window.sendCount = 0;
          document.querySelector('#files').addEventListener('change', (event) => {
            const host = document.querySelector('#attachments');
            host.replaceChildren();
            for (const file of event.target.files) {
              const pill = document.createElement('span');
              pill.setAttribute('data-testid', 'attachment-pill');
              pill.textContent = file.name;
              host.appendChild(pill);
            }
          });
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            window.sendCount += 1;
            history.pushState({}, '', '/c/advanced-conversation-123456');
            const message = document.createElement('article');
            message.setAttribute('data-message-author-role', 'user');
            message.setAttribute('data-message-id', 'advanced-user-message-1');
            message.setAttribute('data-turn-id', 'advanced-user-turn-1');
            message.textContent = document.querySelector('#prompt-textarea').textContent;
            document.querySelector('#messages').appendChild(message);
          });
        </script>
      </body>
    </html>`;
}

function workSurfaceFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <div role="radiogroup">
          <button id="chat" role="radio" aria-checked="false" type="button">Chat</button>
          <button id="work" role="radio" aria-checked="true" type="button">Work</button>
        </div>
        <section data-testid="composer-model-picker-slider-simple-view">Work picker</section>
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button" type="button">Send</button>
        <script>
          window.sendCount = 0;
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            window.sendCount += 1;
          });
        </script>
      </body>
    </html>`;
}

function namedModeFixture(): string {
  return `<!doctype html>
    <html>
      <body>
        <button data-testid="composer-tools" type="button">Tools</button>
        <div id="tools-menu" role="menu" hidden>
          <button id="deep-research" role="menuitem" type="button">Deep Research</button>
        </div>
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button" type="button">Send</button>
        <section id="messages"></section>
        <script>
          window.sendCount = 0;
          const switcher = document.querySelector('[data-testid="composer-tools"]');
          const menu = document.querySelector('#tools-menu');
          const option = document.querySelector('#deep-research');
          switcher.addEventListener('click', () => { menu.hidden = false; });
          option.addEventListener('click', () => {
            option.setAttribute('aria-selected', 'true');
            switcher.textContent = 'Deep Research';
            menu.hidden = true;
          });
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            window.sendCount += 1;
          });
        </script>
      </body>
    </html>`;
}

function humanVerificationFixture(): string {
  return `<!doctype html>
    <html>
      <head><title>Just a moment...</title></head>
      <body>
        <section id="challenge-stage" style="width:320px;height:120px">Verify you are human</section>
        <div id="prompt-textarea" data-testid="prompt-textarea" contenteditable="true"></div>
        <button data-testid="send-button" type="button">Send</button>
        <script>
          window.sendCount = 0;
          document.querySelector('[data-testid="send-button"]').addEventListener('click', () => {
            window.sendCount += 1;
          });
        </script>
      </body>
    </html>`;
}
