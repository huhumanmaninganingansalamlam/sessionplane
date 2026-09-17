import type { Page } from 'playwright-core';

import { ProviderSubmissionError } from './provider-adapter.ts';

export type HumanVerificationKind = 'cloudflare' | 'captcha' | 'browser-check';

export interface HumanVerificationEvidence {
  readonly kind: HumanVerificationKind;
  readonly marker: string;
  readonly title: string;
  readonly url: string;
}

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

export async function assertNoHumanVerification(input: {
  readonly page: Page;
  readonly provider: string;
  readonly pageKey: string;
}): Promise<void> {
  const evidence = await detectHumanVerification(input.page);
  if (evidence === null) return;
  throw new ProviderSubmissionError(
    'provider.human-action-required',
    `Visible ${input.provider} browser verification requires human completion before retry`,
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
