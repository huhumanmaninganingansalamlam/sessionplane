import assert from 'node:assert/strict';
import test from 'node:test';

import { chromium } from 'playwright-core';

import { findPlaywrightChromium } from '../../src/browser/browser-health.ts';

test('browser discovery resolves the exact Playwright-managed Chromium executable', () => {
  const browser = findPlaywrightChromium();
  assert.notEqual(browser, null, 'run `npm run browser:install` before tests');
  assert.equal(browser?.executable, chromium.executablePath());
  assert.equal(browser?.source, 'playwright');
  assert.equal(browser?.product, 'chromium');
  assert.match(browser?.version ?? '', /Chrom(?:e|ium)/i);
});

test('browser discovery does not fall back to an unrelated system executable', () => {
  assert.equal(findPlaywrightChromium('/definitely/missing/sessionplane-browser'), null);
});
