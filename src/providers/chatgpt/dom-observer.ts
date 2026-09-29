import type { Page } from 'playwright-core';

import type { ProviderAssistantCandidate, ProviderWakeReason } from '../provider-adapter.ts';
import { readChatGptMessages } from './message-dom.ts';

export interface ChatGptDomObservation {
  readonly actionableAlert: boolean;
  readonly conversationSurfaceAvailable: boolean;
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
  const messages = await readChatGptMessages(page);
  let submittedUserFound = false;
  let laterUserFound = false;
  let candidate: ProviderAssistantCandidate | null = null;
  for (const message of messages) {
    if (!submittedUserFound) {
      if (message.role === 'user' &&
        ((identity.submittedUserMessageId !== null && message.messageId === identity.submittedUserMessageId) ||
          (identity.submittedUserTurnId !== null && message.turnId === identity.submittedUserTurnId))) {
        submittedUserFound = true;
      }
      continue;
    }
    if (message.role === 'user') {
      laterUserFound = true;
      break;
    }
    const responseMessageId = message.messageId ?? message.turnId;
    if (responseMessageId === null || responseMessageId.startsWith('request-placeholder-')) continue;
    candidate = {
      responseMessageId,
      answerText: message.text,
      terminalMarker: message.terminalMarker,
      streamingMarker: message.streamingMarker,
    };
  }
  // DOM availability is independent of backend transport and provider progress.
  // An absent surface cannot prove generation, failure, or non-submission.
  const conversationSurfaceAvailable = messages.length > 0 || await page.evaluate(() => {
    const main = document.querySelector('main');
    return main !== null && [...main.querySelectorAll<HTMLElement>('[contenteditable="true"], [role="textbox"], textarea')]
      .some(element => element.closest('[aria-hidden="true"], [inert]') === null &&
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  });
  const actionableAlert = submittedUserFound && !laterUserFound &&
    await page.evaluate((identity) => {
      const main = document.querySelector('main');
      if (main === null) return false;
      const ids = [identity.submittedUserMessageId, identity.submittedUserTurnId].filter(Boolean);
      const anchor = [...main.querySelectorAll('[data-message-id], [data-turn-id], [data-chatgpt-search-message-ids]')]
        .find((node) => [node.getAttribute('data-message-id'), node.getAttribute('data-turn-id'),
          ...(node.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/)]
          .some((id) => id !== null && ids.includes(id)));
      if (anchor === undefined) return false;
      return [...main.querySelectorAll<HTMLElement>('[role="alert"]')].some((alert) =>
        Boolean(anchor.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        alert.getClientRects().length > 0 && Boolean(alert.innerText.trim()) &&
        [...alert.querySelectorAll<HTMLElement>('button, [role="button"]')]
          .some((button) => button.getClientRects().length > 0));
    }, identity);
  return { submittedUserFound, laterUserFound, candidate, conversationSurfaceAvailable, actionableAlert };
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
