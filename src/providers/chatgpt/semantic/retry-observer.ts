import type { Page } from 'playwright-core';
import type { SemanticTaskContext } from '../../semantic-adapter.ts';
import { streamRetrySurface } from '../stream-retry.ts';
import { sha, contextKey } from './chatgpt-page-access.ts';

/** Read-only inspection of the exact owned stream-retry control. */
export async function inspectExactChatGptRetry(
  page: Page, context: SemanticTaskContext,
) {
  if (!context.providerConversationId || !context.submittedUserMessageId) return null;
  const observed = await page.evaluate(streamRetrySurface, {
    origin: new URL(page.url()).origin,
    conversationId: context.providerConversationId,
    anchor: context.submittedUserMessageId,
    click: false,
  });
  if (!observed.present) return null;
  return {
    available: observed.reason === 'exact-stream-retry',
    reason: observed.reason,
    evidenceHash: sha(JSON.stringify({
      url: page.url(), context: contextKey(context), reason: observed.reason,
      centerHit: observed.geometry?.centerHit ?? null,
    })),
  };
}
