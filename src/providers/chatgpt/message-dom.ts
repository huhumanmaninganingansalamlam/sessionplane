import type { Page } from 'playwright-core';

import { CHATGPT_SELECTORS } from './selectors.ts';

export interface ChatGptMessage {
  readonly role: 'user' | 'assistant';
  readonly messageId: string | null;
  readonly turnId: string | null;
  readonly text: string;
  readonly terminalMarker: boolean;
  readonly streamingMarker: boolean;
  readonly artifacts?: readonly { source: string; name: string; mediaType: string | null }[];
}

export async function readChatGptMessages(page: Page, includeArtifacts = false): Promise<ChatGptMessage[]> {
  return await page.evaluate(({ selector, artifactSelector, includeArtifacts }) => {
    const messages: ChatGptMessage[] = [];
    const seen = new Set<Element>();
    const nodes = document.querySelectorAll<HTMLElement>(selector);
    for (const node of nodes) {
      const identityNode = node.closest<HTMLElement>('[data-message-id], [data-turn-id]') ?? node;
      const legacyRole = node.getAttribute('data-message-author-role');
      const userBubble = node.querySelector<HTMLElement>('[data-user-message-bubble]');
      const assistantContent = node.querySelector<HTMLElement>('[data-chatgpt-selection-message-id]');
      const role = legacyRole === 'user' || (legacyRole === null && userBubble !== null)
        ? 'user'
        : legacyRole === 'assistant' || (legacyRole === null && assistantContent !== null)
          ? 'assistant'
          : null;
      if (role === null) continue;
      if (seen.has(identityNode)) continue;
      seen.add(identityNode);

      const searchIds = (node.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/).filter(Boolean);
      const uniqueSearchIds = [...new Set(searchIds)];
      const searchId = uniqueSearchIds.length === 1 ? uniqueSearchIds[0]! : null;
      const messageId = identityNode.getAttribute('data-message-id') ??
        node.getAttribute('data-message-id') ?? searchId;
      const turnId = identityNode.getAttribute('data-turn-id') ??
        node.getAttribute('data-turn-id') ?? messageId;
      const status = (identityNode.getAttribute('data-message-status') ??
        node.getAttribute('data-message-status') ??
        identityNode.getAttribute('data-status') ?? '').toLowerCase();
      const endTurn = identityNode.getAttribute('data-end-turn');
      const isStreaming = identityNode.getAttribute('data-is-streaming');
      const ariaBusy = identityNode.getAttribute('aria-busy');
      const content = role === 'user'
        ? userBubble ?? identityNode.querySelector<HTMLElement>(
          '[data-message-content], [data-testid="message-content"], .markdown',
        ) ?? node
        : assistantContent ?? identityNode.querySelector<HTMLElement>(
          '[data-message-content], [data-testid="message-content"], .markdown',
        ) ?? node;
      messages.push({
        ...(includeArtifacts ? { artifacts: [...identityNode.querySelectorAll(artifactSelector)].map((element) => ({
          source: element instanceof HTMLAnchorElement ? element.href : element instanceof HTMLImageElement ? element.src : '',
          name: (element instanceof HTMLAnchorElement ? element.download : element instanceof HTMLImageElement ? element.alt : '') || element.textContent?.trim() || '',
          mediaType: element instanceof HTMLImageElement ? 'image/*' : null,
        })) } : {}),
        role,
        messageId,
        turnId,
        text: (content.innerText ?? content.textContent ?? '').replaceAll('\r\n', '\n'),
        terminalMarker: /^(complete|completed|finished|finished_successfully|success)$/.test(status) ||
          endTurn === 'true' || isStreaming === 'false',
        streamingMarker: /^(in_progress|streaming|generating|pending)$/.test(status) ||
          isStreaming === 'true' || ariaBusy === 'true',
      });
    }
    return messages;
  }, { selector: CHATGPT_SELECTORS.messages, artifactSelector: CHATGPT_SELECTORS.artifactLinks.join(', '), includeArtifacts });
}
