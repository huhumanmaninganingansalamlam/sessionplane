import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

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

