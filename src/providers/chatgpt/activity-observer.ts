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
