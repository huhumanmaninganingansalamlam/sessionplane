import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright-core';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';

import { findHostBrowser } from '../../src/browser/browser-health.ts';

type Variant = 'playwright-defaults' | 'without-background-throttle-flags';
const throttleFlags = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
] as const;

/**
 * Optional, disposable-profile comparison ONLY. BrowserOwner's CDP fixture is
 * test/browser/owned-page-liveness.benchmark.test.ts. Both use exact
 * Target.createTarget(background:true) plus per-page focus emulation.
 * Headless data cannot prove native focus or production ChatGPT streaming.
 */
test('compare Playwright-owned Chrome background scheduling with and without throttle overrides', {
  skip: process.env.SESSIONPLANE_COMPARE_BROWSER_TRANSPORT_L2 !== '1',
  timeout: 90_000,
}, async () => {
  const executable = findHostBrowser({ preference: 'auto' }).executable;
  for (const variant of ['playwright-defaults', 'without-background-throttle-flags'] as const) {
    const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-transport-compare-'));
    let context: BrowserContext | null = null;
    let control: CDPSession | null = null;
    const focusSessions: CDPSession[] = [];
    let foregroundCalls = 0;
    try {
      context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
        executablePath: executable,
        headless: true,
        timeout: 30_000,
        ...(variant === 'without-background-throttle-flags'
          ? { ignoreDefaultArgs: [...throttleFlags] }
          : {}),
      });
      const browser = context.browser();
      assert.ok(browser, 'persistent context must own an isolated browser');
      control = await browser.newBrowserCDPSession();

      const seen = new Set<Page>();
      const pages: Page[] = [];
      const targetIds: string[] = [];
      for (let index = 0; index < 4; index++) {
        const { targetId } = await control.send('Target.createTarget', {
          url: 'about:blank', background: true,
        });
        let page: Page | null = null;
        for (let attempt = 0; attempt < 100 && page === null; attempt++) {
          for (const candidate of context.pages()) {
            if (seen.has(candidate) || candidate.isClosed()) continue;
            const probe = await context.newCDPSession(candidate);
            try {
              const { targetInfo } = await probe.send('Target.getTargetInfo');
              if (targetInfo.targetId === targetId) {
                page = candidate;
                break;
              }
            } finally {
              await probe.detach();
            }
          }
          if (page === null) await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.ok(page, `Exact background target ${targetId} did not attach`);
        seen.add(page);
        targetIds.push(targetId);
        Object.defineProperty(page, 'bringToFront', {
          configurable: true,
          value: async () => { foregroundCalls++; throw new Error('Focus change forbidden'); },
        });
        const focus = await context.newCDPSession(page);
        await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        focusSessions.push(focus);
        await page.setContent(
          '<textarea aria-label="Prompt"></textarea><button>Send</button><output></output>',
        );
        await page.evaluate(() => {
          const probe = { timer: 0, raf: 0, mutation: 0 };
          (globalThis as any).__probe = probe;
          const detached = document.createElement('div');
          new MutationObserver(() => probe.mutation++)
            .observe(detached, { attributes: true });
          setInterval(() => {
            probe.timer++;
            detached.setAttribute('data-tick', String(probe.timer));
          }, 20);
          function tick() {
            probe.raf++;
            requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
          document.querySelector('button')?.addEventListener('click', () => {
            const output = document.querySelector('output');
            const input = document.querySelector('textarea');
            if (output && input) output.textContent = input.value;
          });
        });
        pages.push(page);
      }

      const sample = () => Promise.all(pages.map(page => page.evaluate(() => {
        const probe = (globalThis as any).__probe;
        return {
          timer: probe.timer as number,
          raf: probe.raf as number,
          mutation: probe.mutation as number,
          visibility: document.visibilityState,
        };
      })));
      const before = await sample();
      await new Promise(resolve => setTimeout(resolve, 350));
      const after = await sample();
      const measurements = pages.map((_, index) => ({
        timerDelta: after[index]!.timer - before[index]!.timer,
        rafDelta: after[index]!.raf - before[index]!.raf,
        mutationDelta: after[index]!.mutation - before[index]!.mutation,
        visibility: after[index]!.visibility,
      }));
      for (let index = 0; index < pages.length; index++) {
        assert.ok(measurements[index]!.timerDelta > 0);
        assert.ok(measurements[index]!.mutationDelta > 0);
        await pages[index]!.getByRole('textbox', { name: 'Prompt' })
          .fill(`compare-${index}`, { timeout: 5_000 });
        await pages[index]!.getByRole('button', { name: 'Send' })
          .click({ timeout: 5_000 });
        assert.equal(await pages[index]!.locator('output').innerText(), `compare-${index}`);
      }
      assert.equal(new Set(targetIds).size, 4);
      assert.equal(foregroundCalls, 0);
      console.log('ISOLATED_TRANSPORT_COMPARE_L2 ' + JSON.stringify({
        variant, transport: 'launchPersistentContext',
        pageCreation: 'Target.createTarget background true',
        headless: true, measurementWindowMs: 350, foregroundCalls,
        ignoredDefaultFlags: variant === 'without-background-throttle-flags' ? throttleFlags : [],
        pages: measurements,
      }));
    } finally {
      await Promise.all(focusSessions.map(session => session.detach().catch(() => undefined)));
      await control?.detach().catch(() => undefined);
      await context?.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
