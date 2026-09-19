import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { GeminiAdapter } from '../../src/providers/gemini/adapter.ts';
import { GrokAdapter } from '../../src/providers/grok/adapter.ts';
import type {
  ProviderAdapter,
  ProviderAttachment,
  ProviderName,
} from '../../src/providers/provider-adapter.ts';

for (const provider of ['gemini', 'grok'] as const) {
  test(`${provider} DOM adapter submits, observes, uploads, and downloads exact artifacts`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `sessionplane-${provider}-adapter-`));
    const registry = new PageRegistry();
    const owner = new BrowserOwner({
      profileDir: path.join(root, 'profile'),
      pageRegistry: registry,
      headless: true,
    });

    try {
      await owner.start();
      const created = await owner.createPage();
      const url = provider === 'gemini' ? 'https://gemini.google.com/app' : 'https://grok.com/';
      await created.page.route(`${new URL(url).origin}/**`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: fixtureHtml(provider),
        });
      });
      await created.page.goto(url);
      registry.refreshPage(created.binding.pageKey);
      registry.reservePage(created.binding.pageKey, {
        sessionId: `${provider}-session`,
        generation: 1,
        conversationId: null,
      });

      const attachmentPath = path.join(root, `${provider}-attachment.txt`);
      writeFileSync(attachmentPath, `${provider} attachment`, 'utf8');
      const bytes = Buffer.from(`${provider} attachment`);
      const attachment: ProviderAttachment = {
        path: attachmentPath,
        name: path.basename(attachmentPath),
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mediaType: 'text/plain',
      };
      const adapter = createAdapter(provider, owner, registry);
      const base = sessionSnapshot(provider, created.binding.pageKey);
      const submission = await adapter.openSubmission({
        session: base,
        generation: 1,
        prompt: `Exact ${provider} prompt`,
        model: null,
        attachments: [attachment],
      });
      await submission.prepare();
      await submission.submitOnce();
      const acknowledgement = await submission.captureAcknowledgement();
      assert.notEqual(acknowledgement, null);
      if (acknowledgement === null) throw new Error('missing acknowledgement');
      submission.bindAcknowledgement(acknowledgement);
      assert.match(acknowledgement.conversationId, new RegExp(`^${provider}-conversation-`));
      if (provider === 'grok') {
        assert.notEqual(
          acknowledgement.submittedUserMessageId,
          'user-message',
          'repeated data-testid values are not stable turn identities',
        );
      }
      assert.equal(
        await created.page.locator('#attachment-name').textContent(),
        attachment.name,
      );

      await created.page.evaluate((providerName) => {
        const message = document.createElement(
          providerName === 'gemini' ? 'model-response' : 'article',
        );
        if (providerName === 'grok') message.setAttribute('data-testid', 'assistant-message');
        message.id = `${providerName}-assistant-1`;
        message.setAttribute('data-complete', 'true');
        const content = document.createElement('div');
        content.className = providerName === 'gemini' ? 'markdown' : 'response-content-markdown';
        content.textContent = `Exact ${providerName} final`;
        const artifact = document.createElement('a');
        artifact.href = 'data:text/plain;base64,QVJUSUZBQ1Q=';
        artifact.download = `${providerName}-artifact.txt`;
        artifact.textContent = 'Download artifact';
        message.append(content, artifact);
        document.querySelector('#messages')?.appendChild(message);
      }, provider);

      const observedSession: SessionSnapshot = {
        ...base,
        conversationId: acknowledgement.conversationId,
        submittedUserMessageId: acknowledgement.submittedUserMessageId,
        submittedUserTurnId: acknowledgement.submittedUserTurnId,
        promptSubmitted: true,
        sessionState: 'submitted',
        providerState: 'generating',
        observationTransport: 'fresh',
      };
      const source = await adapter.openObservation({ session: observedSession, generation: 1 });
      const evidence = await source.observe();
      assert.equal(evidence.submittedUserFound, true);
      assert.equal(evidence.candidate?.answerText, `Exact ${provider} final`);
      assert.equal(evidence.candidate?.terminalMarker, true);
      source.close();

      const request = { session: observedSession, generation: 1 };
      const candidates = await adapter.discoverArtifacts?.(request);
      assert.equal(candidates?.length, 1);
      const candidate = candidates?.[0];
      if (candidate === undefined) throw new Error('missing artifact candidate');
      const downloaded = await adapter.downloadArtifact?.(request, candidate);
      assert.equal(Buffer.from(downloaded?.bytes ?? []).toString('utf8'), 'ARTIFACT');
    } finally {
      await owner.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${provider} replaces a missing Page only before any prompt submission`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `sessionplane-${provider}-stale-page-`));
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
      const adapter = createAdapter(provider, owner, registry);
      const staleSession: SessionSnapshot = {
        ...sessionSnapshot(provider, stale.binding.pageKey),
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
        prompt: `Safe ${provider} retry`,
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
          prompt: `Never replace submitted ${provider} Page`,
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
}

test('Grok waits for the real composer to hydrate before declaring it unavailable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-grok-hydration-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://grok.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html>
          <html>
            <body>
              <div id="root"></div>
              <script>
                setTimeout(() => {
                  const composer = document.createElement('div');
                  composer.className = 'tiptap ProseMirror query-bar-editor';
                  composer.contentEditable = 'true';
                  composer.setAttribute('role', 'textbox');
                  composer.setAttribute('aria-label', 'Ask Grok anything');
                  const button = document.createElement('button');
                  button.type = 'submit';
                  button.disabled = true;
                  button.textContent = 'Send';
                  composer.addEventListener('input', () => {
                    setTimeout(() => { button.disabled = false; }, 100);
                  });
                  document.querySelector('#root').append(composer, button);
                }, 200);
              </script>
            </body>
          </html>`,
      });
    });
    await created.page.goto('https://grok.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'grok-hydration-session',
      generation: 1,
      conversationId: null,
    });

    const adapter = createAdapter('grok', owner, registry);
    const submission = await adapter.openSubmission({
      session: {
        ...sessionSnapshot('grok', created.binding.pageKey),
        sessionId: 'grok-hydration-session',
      },
      generation: 1,
      prompt: 'Hydrated Grok prompt',
      model: null,
    });
    await submission.prepare();
    assert.equal(
      await created.page.locator('[role="textbox"]').innerText(),
      'Hydrated Grok prompt',
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gemini waits for an async composer DOM commit before validating the prompt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-gemini-composer-commit-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://gemini.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html>
          <html>
            <body>
              <rich-textarea>
                <div class="ql-editor" contenteditable="true" role="textbox" aria-label="Gemini prompt"></div>
              </rich-textarea>
              <button class="send-button" type="button">Send</button>
              <script>
                const composer = document.querySelector('.ql-editor');
                composer.addEventListener('input', () => {
                  composer.textContent = 'pending framework commit';
                  setTimeout(() => {
                    composer.textContent = 'Delayed Gemini prompt';
                  }, 120);
                });
              </script>
            </body>
          </html>`,
      });
    });
    await created.page.goto('https://gemini.google.com/app');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'gemini-composer-commit-session',
      generation: 1,
      conversationId: null,
    });

    const adapter = createAdapter('gemini', owner, registry);
    const submission = await adapter.openSubmission({
      session: {
        ...sessionSnapshot('gemini', created.binding.pageKey),
        sessionId: 'gemini-composer-commit-session',
      },
      generation: 1,
      prompt: 'Delayed Gemini prompt',
      model: null,
    });
    await submission.prepare();
    assert.equal(
      await created.page.locator('.ql-editor').innerText(),
      'Delayed Gemini prompt',
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gemini keeps stable identities when a shared turn wrapper gains its id after acknowledgement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-gemini-shared-turn-id-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://gemini.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html>
          <html>
            <body>
              <rich-textarea>
                <div class="ql-editor" contenteditable="true" role="textbox" aria-label="Gemini prompt"></div>
              </rich-textarea>
              <button class="send-button" type="button">Send</button>
              <section id="messages"></section>
              <script>
                const composer = document.querySelector('.ql-editor');
                document.querySelector('button').addEventListener('click', () => {
                  history.pushState({}, '', '/app/shared-turn-conversation-123456');
                  const pair = document.createElement('div');
                  const user = document.createElement('user-query');
                  user.textContent = composer.textContent;
                  pair.append(user);
                  document.querySelector('#messages').appendChild(pair);
                  setTimeout(() => {
                    pair.id = 'shared-turn-pair-1';
                    const assistant = document.createElement('model-response');
                    assistant.setAttribute('data-complete', 'true');
                    const content = document.createElement('div');
                    content.className = 'markdown';
                    content.textContent = 'Shared turn final';
                    assistant.appendChild(content);
                    pair.appendChild(assistant);
                  }, 250);
                });
              </script>
            </body>
          </html>`,
      });
    });
    await created.page.goto('https://gemini.google.com/app');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'gemini-shared-turn-session',
      generation: 1,
      conversationId: null,
    });

    const adapter = createAdapter('gemini', owner, registry);
    const base = {
      ...sessionSnapshot('gemini', created.binding.pageKey),
      sessionId: 'gemini-shared-turn-session',
    };
    const submission = await adapter.openSubmission({
      session: base,
      generation: 1,
      prompt: 'Shared turn prompt',
      model: null,
    });
    await submission.prepare();
    await submission.submitOnce();
    const acknowledgement = await submission.captureAcknowledgement();
    assert.notEqual(acknowledgement, null);
    if (acknowledgement === null) throw new Error('missing acknowledgement');
    submission.bindAcknowledgement(acknowledgement);
    await created.page.waitForTimeout(350);

    const observedSession: SessionSnapshot = {
      ...base,
      conversationId: acknowledgement.conversationId,
      submittedUserMessageId: acknowledgement.submittedUserMessageId,
      submittedUserTurnId: acknowledgement.submittedUserTurnId,
      promptSubmitted: true,
      sessionState: 'submitted',
      providerState: 'generating',
    };
    const source = await adapter.openObservation({ session: observedSession, generation: 1 });
    const first = await source.observe();
    const second = await source.observe();
    source.close();

    assert.equal(first.submittedUserFound, true);
    assert.equal(first.candidate?.answerText, 'Shared turn final');
    assert.notEqual(first.candidate?.responseMessageId, acknowledgement.submittedUserMessageId);
    assert.equal(second.candidate?.responseMessageId, first.candidate?.responseMessageId);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Grok refuses the anonymous composer before mutating or submitting a prompt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-grok-auth-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://grok.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html>
          <html>
            <body>
              <a href="/sign-in?return_to=%2F">Log in</a>
              <a href="/sign-up?return_to=%2F">Sign up</a>
              <div class="ProseMirror" contenteditable="true" role="textbox"></div>
              <button type="submit">Send</button>
              <script>
                window.sendCount = 0;
                document.querySelector('button').addEventListener('click', () => {
                  window.sendCount += 1;
                });
              </script>
            </body>
          </html>`,
      });
    });
    await created.page.goto('https://grok.com/');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'grok-auth-session',
      generation: 1,
      conversationId: null,
    });

    const adapter = createAdapter('grok', owner, registry);
    const submission = await adapter.openSubmission({
      session: {
        ...sessionSnapshot('grok', created.binding.pageKey),
        sessionId: 'grok-auth-session',
      },
      generation: 1,
      prompt: 'Never submit anonymously',
      model: null,
    });
    await assert.rejects(
      submission.prepare(),
      (error: unknown) =>
        error instanceof Error &&
        'errorCode' in error &&
        error.errorCode === 'provider.authentication-required',
    );
    assert.equal(await created.page.locator('[role="textbox"]').textContent(), '');
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('generic provider verification fails closed before prompt or submit mutation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-provider-verification-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    await created.page.route('https://gemini.google.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html>
          <title>Security verification</title>
          <section id="challenge-stage" style="width:320px;height:120px">Verify</section>
          <rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
          <button class="send-button" type="button">Send</button>
          <script>
            window.sendCount = 0;
            document.querySelector('button').addEventListener('click', () => { window.sendCount += 1; });
          </script>`,
      });
    });
    await created.page.goto('https://gemini.google.com/app');
    registry.refreshPage(created.binding.pageKey);
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'gemini-verification-session',
      generation: 1,
      conversationId: null,
    });
    const adapter = createAdapter('gemini', owner, registry);
    const submission = await adapter.openSubmission({
      session: {
        ...sessionSnapshot('gemini', created.binding.pageKey),
        sessionId: 'gemini-verification-session',
      },
      generation: 1,
      prompt: 'Do not mutate this composer.',
      model: null,
    });

    await assert.rejects(
      submission.prepare(),
      (error: unknown) =>
        error instanceof Error &&
        'errorCode' in error &&
        error.errorCode === 'provider.human-action-required',
    );
    assert.equal(await created.page.locator('[contenteditable="true"]').textContent(), '');
    assert.equal(
      await created.page.evaluate(() => (window as Window & { sendCount: number }).sendCount),
      0,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createAdapter(
  provider: ProviderName,
  browserOwner: BrowserOwner,
  pageRegistry: PageRegistry,
): ProviderAdapter {
  const shared = {
    browserOwner,
    pageRegistry,
    acknowledgementTimeoutMs: 2_000,
  };
  return provider === 'gemini'
    ? new GeminiAdapter({ ...shared, loginUrl: 'https://gemini.google.com/app' })
    : new GrokAdapter({ ...shared, loginUrl: 'https://grok.com/' });
}

function sessionSnapshot(provider: ProviderName, pageKey: string): SessionSnapshot {
  return {
    requestOk: true,
    teamId: '11111111-1111-4111-8111-111111111111',
    roleId: '22222222-2222-4222-8222-222222222222',
    roleKey: `expert.${provider}`,
    sessionId: `${provider}-session`,
    predecessorSessionId: null,
    provider,
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

function fixtureHtml(provider: ProviderName): string {
  const composer = provider === 'gemini'
    ? '<rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>'
    : '<div class="ProseMirror" contenteditable="true"></div>';
  const send = provider === 'gemini'
    ? '<button class="send-button" type="button">Send</button>'
    : '<button type="submit">Send</button>';
  return `<!doctype html>
    <html>
      <head><title>${provider} fixture</title></head>
      <body>
        ${composer}
        ${send}
        <input id="upload" type="file">
        <input-area-v2>
          <div id="attachment-name" data-test-id="attachment-chip" data-testid="attachment-chip"></div>
        </input-area-v2>
        <section id="messages"></section>
        <script>
          const provider = ${JSON.stringify(provider)};
          const composer = document.querySelector('[contenteditable="true"]');
          document.querySelector('#upload').addEventListener('change', (event) => {
            document.querySelector('#attachment-name').textContent = event.target.files[0]?.name || '';
          });
          document.querySelector('button').addEventListener('click', () => {
            history.pushState({}, '', provider === 'gemini'
              ? '/app/gemini-conversation-123456'
              : '/c/grok-conversation-123456');
            const user = document.createElement(provider === 'gemini' ? 'user-query' : 'article');
            if (provider === 'grok') user.setAttribute('data-testid', 'user-message');
            user.id = provider + '-user-1';
            if (provider === 'gemini') {
              const hidden = document.createElement('h5');
              hidden.className = 'screen-reader-user-query-label';
              hidden.textContent = 'What you said ' + composer.textContent.slice(0, 24) + '…';
              const queryText = document.createElement('div');
              queryText.className = 'query-text';
              for (const line of composer.textContent.split(String.fromCharCode(10))) {
                const paragraph = document.createElement('p');
                paragraph.className = 'query-text-line';
                paragraph.textContent = line;
                queryText.appendChild(paragraph);
              }
              const outer = document.createElement('span');
              outer.className = 'user-query-container';
              const content = document.createElement('div');
              content.className = 'user-query-container';
              content.append(hidden, queryText);
              outer.append(content);
              user.append(outer);
            } else {
              user.textContent = composer.textContent;
            }
            document.querySelector('#messages').appendChild(user);
          });
        </script>
      </body>
    </html>`;
}
