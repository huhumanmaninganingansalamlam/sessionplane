import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

test('headed chat creation and interaction preserve the human foreground tab', {
  skip: !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async (t) => {
  // Observe actual tab visibility, without Playwright's per-target focus emulation.
  const connect = chromium.connectOverCDP.bind(chromium);
  t.mock.method(chromium, 'connectOverCDP', (endpoint: string, options: object) =>
    connect(endpoint, { ...options, noDefaults: true }));
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-background-chat-'));
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'),
    pageRegistry: new PageRegistry(), headless: false });
  try {
    await owner.start();
    const human = await owner.createPage();
    await human.page.setContent('<title>Human foreground</title><textarea></textarea>');
    await human.page.bringToFront();
    const visible = () => human.page.evaluate(() => document.visibilityState);
    assert.equal(await visible(), 'visible');
    const created = await Promise.all([owner.createPage(), owner.createPage()]);
    assert.notEqual(created[0]!.binding.targetId, created[1]!.binding.targetId);
    for (const { page } of created) {
      assert.equal(await visible(), 'visible', 'Creating a chat must not activate its tab');
      const session = await page.context().newCDPSession(page);
      // Match normal Playwright interaction, then remove emulation for the visibility assertion.
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await page.goto('data:text/html,<form onsubmit="event.preventDefault();document.querySelector(\'p\').textContent=document.querySelector(\'textarea\').value"><textarea></textarea><button>Send</button></form><p></p>');
      await page.locator('textarea').focus();
      await page.locator('textarea').fill('Background message');
      await page.locator('button').click();
      assert.equal(await page.locator('p').innerText(), 'Background message');
      assert.equal(await visible(), 'visible', 'Chat interaction must not activate its tab');
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      assert.equal(await page.evaluate(() => document.visibilityState), 'hidden');
      await session.detach();
    }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

test('four background Pages are read independently without focus switching', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-background-pages-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'profile'),
    pageRegistry: registry,
    headless: true,
  });

  try {
    await owner.start();
    const pages = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const created = await owner.createPage();
        await created.page.setContent(`<main data-index="${index}">page-${index}</main>`);
        let focusCalls = 0;
        Object.defineProperty(created.page, 'bringToFront', {
          configurable: true,
          value: async () => {
            focusCalls += 1;
          },
        });
        return { ...created, index, focusCalls: () => focusCalls };
      }),
    );

    const values = await Promise.all(
      pages.map(({ page }) => page.locator('main').getAttribute('data-index')),
    );
    assert.deepEqual(values, ['0', '1', '2', '3']);
    assert.ok(pages.every(({ focusCalls }) => focusCalls() === 0));
    assert.ok(registry.listBindings({ includeClosed: false }).length >= 4);
  } finally {
    await owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});
