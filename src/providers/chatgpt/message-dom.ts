import type { Page } from 'playwright-core';

import { CHATGPT_SELECTORS } from './selectors.ts';

export interface ChatGptMessage {
  readonly elementIndex?: number;
  readonly rootIndex: number;
  readonly role: 'user' | 'assistant';
  readonly messageId: string | null;
  readonly turnId: string | null;
  readonly text: string;
  readonly terminalMarker: boolean;
  readonly streamingMarker: boolean;
  readonly artifacts?: readonly { source: string; name: string; mediaType: string | null }[];
}

export async function readChatGptMessages(page: Page, includeArtifacts = false): Promise<ChatGptMessage[]> {
  return (await readChatGptMessageObservation(page, includeArtifacts)).messages;
}

/** Diagnostics and parsed messages come from one renderer task, never a second DOM sample. */
export async function readChatGptMessageObservation(page: Page, includeArtifacts = false, anchorIds: readonly string[] = []) {
  const identitySelector = '[data-message-id], [data-turn-id], [data-chatgpt-search-message-ids], [data-chatgpt-selection-message-id]';
  return await page.locator(`${CHATGPT_SELECTORS.messages}, ${identitySelector}`).evaluateAll((elements, { selector, artifactSelector, includeArtifacts, anchorIds }) => {
    const messages: ChatGptMessage[] = [];
    const seen = new Set<Element>();
    const nodes = elements.filter(element => element.matches(selector)) as HTMLElement[];
    const roots: Node[] = [];
    for (const [elementIndex, node] of nodes.entries()) {
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
      const root = node.getRootNode();
      if (!roots.includes(root)) roots.push(root);
      messages.push({
        rootIndex: roots.indexOf(root),
        ...(includeArtifacts ? { elementIndex } : {}),
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
    const anchorAttributeMatches = { messageId: 0, turnId: 0, searchMessageIds: 0, selectionMessageId: 0 };
    let anchorOutsideSelectorCount = 0;
    const attributes = [
      ['data-message-id', 'messageId'], ['data-turn-id', 'turnId'],
      ['data-chatgpt-search-message-ids', 'searchMessageIds'],
      ['data-chatgpt-selection-message-id', 'selectionMessageId'],
    ] as const;
    if (anchorIds.length > 0) {
      for (const node of elements) {
        let matched = false;
        for (const [attribute, key] of attributes) {
          const value = node.getAttribute(attribute);
          const values = key === 'searchMessageIds' ? (value ?? '').split(/\s+/) : [value];
          if (values.some(id => id !== null && anchorIds.includes(id))) {
            anchorAttributeMatches[key]++;
            matched = true;
          }
        }
        if (matched && !node.matches(selector) && node.closest(selector) === null && node.querySelector(selector) === null) {
          anchorOutsideSelectorCount++;
        }
      }
    }
    return { messages, diagnostics: {
      observedAt: new Date().toISOString(), scope: 'document-and-open-shadow-dom' as const,
      selectorMatchCount: nodes.length, parsedMessageCount: messages.length,
      // No text, URLs, titles, DOM HTML, composer contents or network data.
      parsedMessages: messages.slice(0, 100).map(({ role, messageId, turnId }) => ({ role, messageId, turnId })),
      parsedMessagesTruncated: messages.length > 100,
      anchorAttributeMatches, anchorOutsideSelectorCount,
    } };
  }, { selector: CHATGPT_SELECTORS.messages, artifactSelector: CHATGPT_SELECTORS.artifactLinks.join(', '), includeArtifacts, anchorIds });
}
