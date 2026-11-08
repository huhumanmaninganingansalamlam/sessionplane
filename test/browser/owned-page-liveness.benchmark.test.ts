import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

/**
 * Optional L2 fixture: deliberately uses its OWN temporary profile and only
 * headless pages. This is NOT proof of headed/user-foreground continuity.
 */
test('isolated Chrome measures timers, rAF, DOM and clicks on four background tabs', {
  skip: process.env.SESSIONPLANE_RUN_HEADLESS_BROWSER_L2 !== '1',
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-owned-l2-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: path.join(root, 'disposable-profile'),
    pageRegistry: registry,
    headless: true,
  });
  let foregroundCalls = 0;
  try {
    await owner.start();
    const pages = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const created = await owner.createPage();
      const { page, binding } = created;
      Object.defineProperty(page, 'bringToFront', {
        configurable: true,
        value: async () => { foregroundCalls++; throw new Error('Routine focus forbidden'); },
      });
      registry.reservePage(binding.pageKey, {
        sessionId: `fixture-${index}`, generation: 1, conversationId: null,
      });
      await owner.preparePageInteraction(binding.pageKey, {
        sessionId: `fixture-${index}`, generation: 1, conversationId: null,
      });
      await page.setContent(`<!doctype html>
        <textarea aria-label="Prompt"></textarea>
        <button onclick="document.querySelector('output').textContent =
          document.querySelector('textarea').value">Send</button>
        <output></output>
        <script>
          window.__probe = { timer: 0, raf: 0, mutation: 0 };
          const detached = document.createElement('div');
          new MutationObserver(() => window.__probe.mutation++)
            .observe(detached, { attributes: true });
          setInterval(() => {
            window.__probe.timer++;
            detached.setAttribute('data-tick', String(window.__probe.timer));
          }, 20);
          function tick() {
            window.__probe.raf++;
            requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        </script>`);
      return { page, targetId: binding.targetId, index };
    }));
    const sample = () => Promise.all(pages.map(({ page }) =>
      page.evaluate(() => {
        const v = (globalThis as any).__probe;
        return { timer: v.timer as number, raf: v.raf as number,
          mutation: v.mutation as number, visibility: document.visibilityState };
      })));
    const before = await sample();
    await new Promise(resolve => setTimeout(resolve, 350));
    const after = await sample();
    const measurements = pages.map((page, index) => ({
      targetId: page.targetId,
      timerDelta: after[index]!.timer - before[index]!.timer,
      rafDelta: after[index]!.raf - before[index]!.raf,
      mutationDelta: after[index]!.mutation - before[index]!.mutation,
      rendererVisibility: after[index]!.visibility,
    }));
    console.log('ISOLATED_BROWSER_L2 ' + JSON.stringify({
      mode: 'dedicated-chrome-cdp', headless: true, foregroundCalls,
      measurementWindowMs: 350, sustainedRafMinimumFrames: 3,
      pages: measurements,
    }));
    for (let index = 0; index < pages.length; index++) {
      const measured = measurements[index]!;
      assert.ok(measured.timerDelta > 0, `timer stalled in background page ${index}`);
      assert.ok(measured.mutationDelta > 0, `detached DOM mutation stalled in background page ${index}`);
      const page = pages[index]!.page;
      await page.getByRole('textbox', { name: 'Prompt' }).fill(`question-${index}`, { timeout: 5_000 });
      await page.getByRole('button', { name: 'Send' }).click({ timeout: 5_000 });
      assert.equal(await page.locator('output').innerText(), `question-${index}`);
    }
    // A second read-only controller reconnects to the same disposable Chrome.
    // The exact CDP targets must remain identifiable without URL/title guesses
    // or any tab activation. This is not yet proof of a full Core crash/restart.
    const debuggingPort = owner.status.debuggingPort;
    if (debuggingPort === null) throw new Error('Disposable Chrome has no CDP port');
    const observer = await chromium.connectOverCDP(
      `http://127.0.0.1:${debuggingPort}`, { timeout: 10_000, noDefaults: true },
    );
    let reboundCount = 0;
    try {
      const observedContext = observer.contexts()[0];
      assert.ok(observedContext, 'rebound observer needs the same dedicated context');
      const targetIds = new Set<string>();
      for (const observed of observedContext.pages()) {
        const session = await observedContext.newCDPSession(observed);
        try {
          const { targetInfo } = await session.send('Target.getTargetInfo');
          targetIds.add(targetInfo.targetId);
        } finally {
          await session.detach();
        }
      }
      reboundCount = pages.filter(p => targetIds.has(p.targetId)).length;
      assert.equal(reboundCount, 4, 'all four exact targets must reattach without focus');
    } finally {
      await observer.close();
    }
    assert.equal(await pages[0]!.page.evaluate(() => document.querySelectorAll('textarea').length), 1,
      'disconnecting a secondary controller must not close the owned browser');
    console.log('ISOLATED_BROWSER_RECONNECT_L2 ' + JSON.stringify({
      transport: 'CDP', exactTargetsRebound: reboundCount, foregroundCalls,
    }));
    if (process.env.SESSIONPLANE_REQUIRE_BACKGROUND_RAF === '1') {
      assert.ok(measurements.every(measurement => measurement.rafDelta >= 3),
        'sustained background rAF gate failed; do not infer liveness from one frame');
    }
    assert.equal(foregroundCalls, 0);
    assert.equal(new Set(pages.map(p => p.targetId)).size, 4);
    // Visibility is diagnostic only. It must never be projected as human focus.
    assert.equal(after.length, 4);
  } finally {
    await owner.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
