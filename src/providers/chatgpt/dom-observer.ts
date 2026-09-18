import type { Page } from 'playwright-core';

import type { ProviderAssistantCandidate, ProviderWakeReason } from '../provider-adapter.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

export interface ChatGptDomObservation {
  readonly submittedUserFound: boolean;
  readonly laterUserFound: boolean;
  readonly candidate: ProviderAssistantCandidate | null;
}

export interface SubmittedUserIdentity {
  readonly submittedUserMessageId: string | null;
  readonly submittedUserTurnId: string | null;
}

export async function observeChatGptDom(
  page: Page,
  identity: SubmittedUserIdentity,
): Promise<ChatGptDomObservation> {
  return await page.evaluate(
    ({ messageSelector, submittedUserMessageId, submittedUserTurnId }) => {
      interface ExtractedMessage {
        readonly role: string;
        readonly messageId: string | null;
        readonly turnId: string | null;
        readonly text: string;
        readonly terminalMarker: boolean;
        readonly streamingMarker: boolean;
      }

      const extracted: ExtractedMessage[] = [];
      const seen = new Set<Element>();
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(messageSelector));
      for (const node of nodes) {
        const identityNode =
          node.closest<HTMLElement>('[data-message-id], [data-turn-id]') ??
          node.closest<HTMLElement>('article[data-testid^="conversation-turn-"]') ??
          node;
        if (seen.has(identityNode)) {
          continue;
        }
        seen.add(identityNode);

        const attribute = (name: string): string | null =>
          identityNode.getAttribute(name) ?? node.getAttribute(name);
        const role = (attribute('data-message-author-role') ?? '').trim().toLowerCase();
        if (role.length === 0) {
          continue;
        }
        const messageId = attribute('data-message-id');
        const turnId = attribute('data-turn-id');
        const status = (
          attribute('data-message-status') ??
          attribute('data-status') ??
          ''
        ).toLowerCase();
        const endTurn = (attribute('data-end-turn') ?? '').toLowerCase();
        const isStreaming = (attribute('data-is-streaming') ?? '').toLowerCase();
        const ariaBusy = (attribute('aria-busy') ?? '').toLowerCase();
        const content =
          identityNode.querySelector<HTMLElement>(
            '[data-message-content], [data-testid="message-content"], .markdown',
          ) ?? node;
        const text = (content.innerText ?? content.textContent ?? '').replaceAll('\r\n', '\n');

        extracted.push({
          role,
          messageId,
          turnId,
          text,
          terminalMarker:
            /^(complete|completed|finished|finished_successfully|success)$/.test(status) ||
            endTurn === 'true' ||
            isStreaming === 'false',
          streamingMarker:
            /^(in_progress|streaming|generating|pending)$/.test(status) ||
            isStreaming === 'true' ||
            ariaBusy === 'true',
        });
      }

      const matchesSubmittedUser = (message: ExtractedMessage): boolean =>
        message.role === 'user' &&
        ((submittedUserMessageId !== null && message.messageId === submittedUserMessageId) ||
          (submittedUserTurnId !== null && message.turnId === submittedUserTurnId));

      let submittedUserFound = false;
      let laterUserFound = false;
      let candidate: ProviderAssistantCandidate | null = null;
      for (const message of extracted) {
        if (!submittedUserFound) {
          if (matchesSubmittedUser(message)) {
            submittedUserFound = true;
          }
          continue;
        }
        if (message.role === 'user') {
          laterUserFound = true;
          break;
        }
        if (message.role !== 'assistant') {
          continue;
        }
        const responseMessageId = message.messageId ?? message.turnId;
        if (
          responseMessageId === null ||
          responseMessageId.startsWith('request-placeholder-')
        ) {
          continue;
        }
        candidate = {
          responseMessageId,
          answerText: message.text,
          terminalMarker: message.terminalMarker,
          streamingMarker: message.streamingMarker,
        };
      }

      return { submittedUserFound, laterUserFound, candidate };
    },
    {
      messageSelector: CHATGPT_SELECTORS.messages,
      submittedUserMessageId: identity.submittedUserMessageId,
      submittedUserTurnId: identity.submittedUserTurnId,
    },
  );
}

export async function waitForChatGptDomMutation(
  page: Page,
  timeoutMs: number,
): Promise<ProviderWakeReason> {
  return await page.evaluate(async (waitMs) => {
    const root = document.body;
    if (root === null) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      return 'timer' as const;
    }

    return await new Promise<'dom' | 'timer'>((resolve) => {
      let settled = false;
      const finish = (reason: 'dom' | 'timer'): void => {
        if (settled) {
          return;
        }
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(reason);
      };
      const observer = new MutationObserver(() => finish('dom'));
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          'data-message-status',
          'data-is-streaming',
          'data-end-turn',
          'aria-busy',
          'hidden',
        ],
      });
      const timer = setTimeout(() => finish('timer'), waitMs);
    });
  }, timeoutMs);
}
