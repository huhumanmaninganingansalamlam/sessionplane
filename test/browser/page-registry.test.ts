import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { parseChatGptConversationId } from '../../src/browser/page-binding.ts';
import { PageMutationMutex } from '../../src/browser/page-mutex.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

const FIRST_CONVERSATION = '11111111-1111-4111-8111-111111111111';
const SECOND_CONVERSATION = '22222222-2222-4222-8222-222222222222';

test('conversation ids are parsed only from exact ChatGPT conversation URLs', () => {
  assert.equal(parseChatGptConversationId(`https://chatgpt.com/c/${FIRST_CONVERSATION}`), FIRST_CONVERSATION);
  assert.equal(
    parseChatGptConversationId(`https://chatgpt.com/g/g-abc/c/${FIRST_CONVERSATION}?model=test`),
    FIRST_CONVERSATION,
  );
  assert.equal(
    parseChatGptConversationId(`https://chatgpt.com/c/WEB:${FIRST_CONVERSATION}`),
    `WEB:${FIRST_CONVERSATION}`,
  );
  assert.equal(
    parseChatGptConversationId(`https://chatgpt.com/c/WEB%3A${FIRST_CONVERSATION}`),
    `WEB:${FIRST_CONVERSATION}`,
  );
  assert.equal(parseChatGptConversationId('https://chatgpt.com/c/WEB:not-a-uuid'), null);
  assert.equal(parseChatGptConversationId(`https://example.com/c/${FIRST_CONVERSATION}`), null);
  assert.equal(parseChatGptConversationId('https://chatgpt.com/'), null);
  assert.equal(parseChatGptConversationId('https://chatgpt.com/c/%E0%A4%A'), null);
});

test('PageMutationMutex serializes one Page while allowing distinct Pages to proceed', async () => {
  const mutex = new PageMutationMutex();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = mutex.runExclusive('page-a', async () => {
    events.push('a1-start');
    await firstGate;
    events.push('a1-end');
    return 1;
  });
  const second = mutex.runExclusive('page-a', async () => {
    events.push('a2');
    return 2;
  });
  const other = mutex.runExclusive('page-b', async () => {
    events.push('b');
    return 3;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['a1-start', 'b']);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second, other]), [1, 2, 3]);
  assert.deepEqual(events, ['a1-start', 'b', 'a1-end', 'a2']);
  assert.equal(mutex.isBusy('page-a'), false);
});

test('PageRegistry detach invalidates every Page from the detached context', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-page-registry-detach-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const created = await owner.createPage();
    registry.reservePage(created.binding.pageKey, {
      sessionId: 'detached-session',
      generation: 1,
      conversationId: null,
    });

    registry.detach();

    assert.equal(registry.getBinding(created.binding.pageKey).state, 'closed');
    assert.equal(
      registry
        .listBindings({ includeClosed: false })
        .some((binding) => binding.pageKey === created.binding.pageKey),
      false,
    );
    assert.throws(
      () => registry.pageForObservation(created.binding.pageKey),
      /closed/,
    );
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('PageRegistry quarantines duplicate conversations and detects navigation identity loss', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-page-registry-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const first = await owner.createPage();
    await first.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>first</main>' });
    });
    await first.page.goto(`https://chatgpt.com/c/${FIRST_CONVERSATION}`);
    const bound = registry.bindPage(first.binding.pageKey, {
      sessionId: 'session-1',
      generation: 1,
      conversationId: FIRST_CONVERSATION,
    });
    assert.equal(bound.state, 'owned');

    const second = await owner.createPage();
    await second.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<main>duplicate</main>' });
    });
    await second.page.goto(`https://chatgpt.com/c/${FIRST_CONVERSATION}`);

    const duplicates = registry.findByConversation(FIRST_CONVERSATION);
    assert.equal(duplicates.length, 2);
    assert.ok(duplicates.every((binding) => binding.state === 'conflict'));
    assert.ok(duplicates.every((binding) => binding.conflictOwnerPageKey === first.binding.pageKey));
    assert.throws(
      () =>
        registry.requireOwnedPage(first.binding.pageKey, {
          sessionId: 'session-1',
          generation: 1,
          conversationId: FIRST_CONVERSATION,
        }),
      /quarantined/,
    );

    await second.page.close();
    assert.equal(registry.getBinding(first.binding.pageKey).state, 'owned');

    const beforeEpoch = registry.getBinding(first.binding.pageKey).bindingEpoch;
    await first.page.goto(`https://chatgpt.com/c/${SECOND_CONVERSATION}`);
    const lost = registry.getBinding(first.binding.pageKey);
    assert.equal(lost.state, 'identity_lost');
    assert.ok(lost.bindingEpoch > beforeEpoch);

    await first.page.goto(`https://chatgpt.com/c/${FIRST_CONVERSATION}`);
    const restored = registry.getBinding(first.binding.pageKey);
    assert.equal(restored.state, 'owned');
    assert.ok(restored.bindingEpoch > lost.bindingEpoch);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});
