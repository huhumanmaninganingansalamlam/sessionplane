import type { Page } from 'playwright-core';

import type { ProviderDialogKind } from '../provider-adapter.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

export interface ChatGptDialogObservation {
  readonly kind: ProviderDialogKind | null;
  readonly reason: string | null;
}

const RATE_LIMIT_PATTERN =
  /rate\s*limit|too\s+many\s+requests|usage\s+limit|limit\s+reached|reached\s+your\s+.*limit|요청\s*한도|사용량\s*한도|한도에\s*도달/i;
const INTERSTITIAL_PATTERN =
  /verify\s+you\s+are\s+human|checking\s+your\s+browser|unusual\s+activity|temporarily\s+unavailable|sign\s+in\s+to\s+continue|log\s+in\s+to\s+continue|사람인지\s*확인|로그인.*계속/i;

export async function observeChatGptDialog(page: Page): Promise<ChatGptDialogObservation> {
  for (const selector of CHATGPT_SELECTORS.dialogs) {
    const dialogs = page.locator(selector);
    const count = await dialogs.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const dialog = dialogs.nth(index);
      if (!(await dialog.isVisible().catch(() => false))) {
        continue;
      }
      const text = (await dialog.innerText().catch(() => '')).trim();
      if (RATE_LIMIT_PATTERN.test(text)) {
        return { kind: 'rate_limit', reason: 'visible-rate-limit-dialog' };
      }
      const testId = (await dialog.getAttribute('data-testid').catch(() => null)) ?? '';
      if (testId.toLowerCase().includes('interstitial') || INTERSTITIAL_PATTERN.test(text)) {
        return { kind: 'interstitial', reason: 'visible-provider-interstitial' };
      }
    }
  }
  return { kind: null, reason: null };
}
