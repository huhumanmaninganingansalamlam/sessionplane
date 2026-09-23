import type { Page, Response } from 'playwright-core';

import { ProviderSubmissionError } from './provider-adapter.ts';

export type HumanVerificationKind = 'cloudflare' | 'captcha' | 'browser-check';

export interface HumanVerificationEvidence {
  readonly kind: HumanVerificationKind;
  readonly marker: string;
  readonly title: string;
  readonly url: string;
}

interface HumanVerificationContext {
  readonly page: Page;
  readonly provider: string;
  readonly pageKey: string;
}

const VERIFICATION_READ_TIMEOUT_MS = 750;
const NAVIGATION_SETTLE_MS = 100;

const MARKERS: ReadonlyArray<{
  readonly kind: HumanVerificationKind;
  readonly selector: string;
}> = [
  { kind: 'cloudflare', selector: '#challenge-stage' },
  { kind: 'cloudflare', selector: '#challenge-running' },
  { kind: 'cloudflare', selector: '.cf-challenge-running' },
  { kind: 'cloudflare', selector: 'iframe[src*="challenges.cloudflare.com"]' },
  { kind: 'captcha', selector: 'iframe[src*="recaptcha"]' },
  { kind: 'captcha', selector: 'iframe[src*="hcaptcha"]' },
  { kind: 'captcha', selector: '.g-recaptcha' },
  { kind: 'captcha', selector: '.h-captcha' },
  { kind: 'captcha', selector: '[data-testid*="captcha" i]' },
] as const;

const TITLE_PATTERNS: ReadonlyArray<{
  readonly kind: HumanVerificationKind;
  readonly pattern: string;
}> = [
  { kind: 'cloudflare', pattern: 'just a moment' },
  { kind: 'cloudflare', pattern: 'attention required' },
  { kind: 'browser-check', pattern: 'checking your browser' },
  { kind: 'browser-check', pattern: 'security verification' },
  { kind: 'browser-check', pattern: 'verify you are human' },
] as const;

export async function detectHumanVerification(
  page: Page,
): Promise<HumanVerificationEvidence | null> {
  return await page.evaluate(
    ({ markers, titlePatterns }) => {
      const visible = (element: Element): boolean => {
        const node = element as HTMLElement;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const bounds = node.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      };
      const title = document.title.trim();
      const normalizedTitle = title.toLowerCase();
      for (const candidate of markers) {
        const element = document.querySelector(candidate.selector);
        if (element !== null && visible(element)) {
          return {
            kind: candidate.kind,
            marker: candidate.selector,
            title,
            url: location.href,
          };
        }
      }
      for (const candidate of titlePatterns) {
        if (normalizedTitle.includes(candidate.pattern)) {
          return {
            kind: candidate.kind,
            marker: `title:${candidate.pattern}`,
            title,
            url: location.href,
          };
        }
      }
      return null;
    },
    {
      markers: [...MARKERS],
      titlePatterns: [...TITLE_PATTERNS],
    },
  );
}

export async function navigateProviderPage(
  input: HumanVerificationContext & {
    readonly url: string;
    readonly timeoutMs?: number;
  },
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  let response: Response | null;
  try {
    response = await input.page.goto(input.url, {
      waitUntil: 'commit',
      timeout: timeoutMs,
    });
  } catch (error) {
    const evidence = await detectHumanVerificationBounded(input.page);
    if (evidence !== null) {
      throwHumanVerification(input, evidence);
    }
    throw error;
  }

  const responseEvidence = detectResponseHumanVerification(response);
  if (responseEvidence !== null) {
    throwHumanVerification(input, responseEvidence);
  }
  await waitForProviderPageReady(input, timeoutMs);
}

export async function waitForProviderPageReady(
  input: HumanVerificationContext,
  timeoutMs = 30_000,
): Promise<void> {
  try {
    await input.page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  } catch (error) {
    const evidence = await detectHumanVerificationBounded(input.page);
    if (evidence !== null) {
      throwHumanVerification(input, evidence);
    }
    throw new ProviderSubmissionError(
      'browser.unavailable',
      input.provider + ' Page did not reach DOM readiness before the navigation deadline',
      { cause: error },
    );
  }

  await input.page.waitForTimeout(NAVIGATION_SETTLE_MS);
  const evidence = await detectHumanVerificationBounded(input.page);
  if (evidence !== null) {
    throwHumanVerification(input, evidence);
  }
}

function detectResponseHumanVerification(
  response: Response | null,
): HumanVerificationEvidence | null {
  if (response === null) return null;
  const mitigated = Object.entries(response.headers()).find(
    ([name]) => name.toLowerCase() === 'cf-mitigated',
  )?.[1];
  if (mitigated?.toLowerCase().includes('challenge') !== true) {
    return null;
  }
  return {
    kind: 'cloudflare',
    marker: 'response:cf-mitigated=challenge',
    title: '',
    url: response.url(),
  };
}

async function detectHumanVerificationBounded(
  page: Page,
  timeoutMs = VERIFICATION_READ_TIMEOUT_MS,
): Promise<HumanVerificationEvidence | null> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      detectHumanVerification(page).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export async function assertNoHumanVerification(
  input: HumanVerificationContext,
): Promise<void> {
  const evidence = await detectHumanVerification(input.page);
  if (evidence === null) return;
  throwHumanVerification(input, evidence);
}

function throwHumanVerification(
  input: HumanVerificationContext,
  evidence: HumanVerificationEvidence,
): never {
  throw new ProviderSubmissionError(
    'provider.human-action-required',
    'Visible ' + input.provider + ' browser verification requires human completion before retry',
    {
      details: {
        provider: input.provider,
        pageKey: input.pageKey,
        verificationKind: evidence.kind,
        marker: evidence.marker,
        url: evidence.url,
        title: evidence.title,
        requiresHumanAction: true,
        retryWithNewRequestId: true,
      },
    },
  );
}
