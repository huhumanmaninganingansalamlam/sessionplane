import type { Locator, Page } from 'playwright-core';

import type { ProviderActivityStrength } from '../provider-adapter.ts';
import type { ChatGptDomObservation } from './dom-observer.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

export interface ChatGptActivityObservation {
  readonly strength: ProviderActivityStrength;
  readonly reason: string | null;
}

export async function observeChatGptActivity(
  page: Page,
  dom: ChatGptDomObservation,
): Promise<ChatGptActivityObservation> {
  try {
    // This is provider chrome, not authored answer text or proof of a live
    // backend generation. A disconnected stream cannot establish quiet finality.
    const disconnected = await page.locator('[role="status"]').evaluateAll(nodes => nodes.some(node =>
      node.closest('[data-message-author-role], [data-chatgpt-search-message-ids], article, nav, aside, [aria-hidden="true"], [inert]') === null &&
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      /^(?:연결이 (?:해제|끊어)되었습니다\.\s*전체 답변을 기다리는 중입니다\.?|Disconnected\.\s*Waiting for (?:the )?(?:full|complete) (?:answer|response)\.?)$/i.test((node.textContent ?? '').trim())));
    if (disconnected) return { strength: 'unknown', reason: 'provider-stream-disconnected' };
    if (dom.candidate?.streamingMarker === true) {
      return { strength: 'strong', reason: 'assistant-streaming-marker' };
    }
    if (await anyVisible(page, CHATGPT_SELECTORS.thinkingIndicators)) {
      return { strength: 'weak', reason: 'thinking-indicator' };
    }
    if (await anyVisible(page, CHATGPT_SELECTORS.stopControls)) {
      return { strength: 'weak', reason: 'unverified-stop-control' };
    }
    return { strength: 'none', reason: null };
  } catch {
    return { strength: 'unknown', reason: 'activity-observation-failed' };
  }
}

async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    const candidates = page.locator(selector);
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      if (await isVisible(candidates.nth(index))) {
        return true;
      }
    }
  }
  return false;
}

async function isVisible(locator: Locator): Promise<boolean> {
  return await locator.isVisible().catch(() => false);
}
