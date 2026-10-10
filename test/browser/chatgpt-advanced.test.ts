import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareFixture } from '../helpers/preparation-fixture.ts';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import type { ProviderAttachment, ProviderArtifactRequest } from '../../src/providers/provider-adapter.ts';
import { discoverFileCards, downloadFileCard } from '../../src/providers/chatgpt/file-cards.ts';
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';
import { ChatGptSubmission } from '../../src/providers/chatgpt/submission.ts';
import { navigateProviderPage } from '../../src/providers/human-verification.ts';

test('localized file-card discovery and exact download preserve response ancestry', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-localized-file-'));
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<main></main>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: new PageRegistry(), headless: true });
  try {
    await owner.start(); const { page } = await owner.createPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/c/local-file-fixture`);
    const request = { session: { responseMessageId:'exact-answer', submittedUserMessageId:'exact-user', submittedUserTurnId:'exact-user' } } as ProviderArtifactRequest;
    const name = 'cd129-c127-exact-one-invocation-current-context-runtime-authority.md';
    for (const korean of [false, true]) {
      await page.setContent('<main><div data-message-author-role="user" data-message-id="exact-user">User</div><div data-message-author-role="assistant" data-message-id="exact-answer">Answer</div></main>');
      await page.evaluate(({ korean, name }) => {
        const box = document.createElement('div');
        const preview = document.createElement('button');
        preview.setAttribute('aria-label', korean ? name + ' 미리보기 열기' : 'Open preview of ' + name);
        preview.onclick = () => { throw Error('Preview must not open'); };
        const download = document.createElement('button');
        download.setAttribute('aria-label', korean ? '파일 다운로드' : 'Download file');
        download.style.opacity = '0';
        download.onclick = () => { const a=document.createElement('a'); a.download=name; a.href=URL.createObjectURL(new Blob(['ISOLATED-FIXTURE-BYTES'])); a.click(); };
        box.append(preview, download); document.querySelector('[data-message-id="exact-answer"]')!.append(box);
      }, { korean, name });
      const found = await discoverFileCards(page, request, () => {});
      assert.deepEqual(found.map(c => c.name), [name]);
      const candidate = { providerArtifactId:'isolated-card', name, sourceUrl:found[0]!.source, mediaType:null };
      assert.equal(Buffer.from((await downloadFileCard(page, request, candidate, () => {})).bytes).toString(), 'ISOLATED-FIXTURE-BYTES');
      await page.evaluate(() => { document.querySelector('[data-message-id="exact-user"]')!.setAttribute('data-message-id','different-user'); });
      await assert.rejects(discoverFileCards(page, request, () => {}), /anchor/);
      await assert.rejects(downloadFileCard(page, request, candidate, () => {}), /anchor/);
    }
  } finally { await owner.close(); server.close(); rmSync(root, { recursive:true, force:true }); }
});

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
        body: advancedFixture()
          .replace('window.sendCount += 1;', `window.sendCount += 1;
            void fetch('/backend-api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: [{ id: 'advanced-user-message-1', author: { role: 'user' } }] }) });`)
          .replace("document.querySelector('#messages').appendChild(message);",
            "document.querySelector('#messages').appendChild(message); document.querySelector('#prompt-textarea').textContent = '';")
          .replace('<section id="messages"></section>',
          '<section id="messages"><article data-message-author-role="user"><span data-testid="attachment-pill">context-one.txt context-two.md</span></article></section>')
          .replace('<div id="attachments"></div>', '<form><span data-testid="attachment-pill">context-one.txt</span><span data-testid="attachment-pill">context-two.md</span></form><div id="attachments"></div>')
          .replace("host.appendChild(pill);", "pill.textContent = 'old-' + file.name; host.appendChild(pill); setTimeout(() => { pill.textContent = file.name; }, 400);"),
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

    await prepareFixture(submission, registry.pageForObservation(submission.pageKey));
    assert.equal(await created.page.locator('#chat').getAttribute('aria-checked'), 'true');
    assert.deepEqual(
      await created.page.locator('#attachments [data-testid="attachment-pill"]').allTextContents(),
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
      evidence: 'accepted-request-stable-anchor-cleared-composer',
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
      const answer = document.createElement('div');
      answer.setAttribute('data-message-author-role', 'assistant');
      answer.setAttribute('data-message-id', 'artifact-response');
      answer.appendChild(artifact);
      document.body.appendChild(answer);
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
      providerState: 'complete',
      responseMessageId: 'artifact-response',
      terminal: true,
    };
    registry.reservePage(created.binding.pageKey, {
      sessionId: observedSession.sessionId, generation: 2, conversationId: observedSession.conversationId,
    });
    await created.page.evaluate(() => {
      const exact = document.querySelector('[data-message-id="artifact-response"]')!;
      exact.remove();
      setTimeout(() => document.body.appendChild(exact), 250);
      const other = document.createElement('div');
      other.setAttribute('data-message-author-role', 'assistant');
      other.setAttribute('data-message-id', 'newer-response');
      other.innerHTML = '<a download="wrong.txt" href="data:text/plain,WRONG">Different answer</a>';
      document.body.appendChild(other);
    });
    const candidates = await adapter.discoverArtifacts?.({
      session: observedSession, generation: 1, bindingGeneration: 2,
    });
    assert.deepEqual(candidates?.map((candidate) => candidate.name), ['diagram.png']);
    const image = candidates?.find((candidate) => candidate.name === 'diagram.png');
    assert.notEqual(image, undefined);
    if (image === undefined) throw new Error('missing image candidate');
    const downloaded = await adapter.downloadArtifact?.(
      { session: observedSession, generation: 1, bindingGeneration: 2 },
      image,
    );
    assert.equal(Buffer.from(downloaded?.bytes ?? []).toString('utf8'), 'PNGDATA');
    // Current provider file cards have no href; the preview overlay intercepts pointer clicks.
    await created.page.evaluate(() => {
      document.querySelector('[data-message-id="artifact-response"]')!.remove();
      const answer = document.createElement('div');
      answer.setAttribute('data-chatgpt-search-message-ids', 'artifact-response');
      answer.innerHTML = '<div data-chatgpt-selection-message-id="artifact-response">Original answer</div>';
      const card = (name: string, bytes: string) => {
        const box = document.createElement('div');
        box.style.cssText = 'position:relative;width:300px;height:60px';
        const button = document.createElement('button');
        button.type = 'button'; button.setAttribute('aria-label', 'Download file');
        button.textContent = 'Download';
        button.onclick = () => {
          const a = document.createElement('a'); a.download = name;
          a.href = URL.createObjectURL(new Blob([bytes])); a.click();
        };
        const preview = document.createElement('button');
        preview.type = 'button'; preview.setAttribute('aria-label', 'Open preview of ' + name);
        preview.style.cssText = 'position:absolute;inset:0;z-index:1';
        preview.onclick = () => { throw new Error('Preview must not be activated'); };
        box.append(button, preview); return box;
      };
      answer.append(card('authority.zip', 'EXACT-ZIP-BYTES'));
      const more = document.createElement('button'); more.textContent = '1 more'; more.type = 'button';
      more.onclick = () => { answer.append(card('manifest.json', '{"exact":true}')); more.remove(); };
      answer.append(more); document.body.append(answer);
    });
    const cardRequest = { session: observedSession, generation: 1, bindingGeneration: 2 };
    const fileCards = await adapter.discoverArtifacts(cardRequest);
    assert.deepEqual(fileCards.map(c => c.name), ['authority.zip', 'manifest.json']);
    assert.ok(fileCards.every(c => c.sourceUrl.startsWith('sessionplane-file-card:')));
    assert.equal(Buffer.from((await adapter.downloadArtifact(cardRequest, fileCards[0]!)).bytes).toString(), 'EXACT-ZIP-BYTES');
    assert.equal(Buffer.from((await adapter.downloadArtifact(cardRequest, fileCards[1]!)).bytes).toString(), '{"exact":true}');
    await assert.rejects(adapter.downloadArtifact({ ...cardRequest, bindingGeneration: 99 }, fileCards[0]!));
    await created.page.evaluate(() => {
      const root = document.querySelector('[data-chatgpt-search-message-ids="artifact-response"]')!;
      root.append(root.querySelector('[aria-label="Download file"]')!.parentElement!.cloneNode(true));
    });
    await assert.rejects(adapter.discoverArtifacts(cardRequest), /ambiguous/);
    await assert.rejects(adapter.downloadArtifact(cardRequest, fileCards[0]!), /ambiguous/);

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
    await prepareFixture(retry, created.page);
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

    await prepareFixture(submission, registry.pageForObservation(submission.pageKey));
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
