import type { Page } from 'playwright-core';

import type { ProviderAssistantCandidate, ProviderWakeReason } from '../provider-adapter.ts';
import { readChatGptMessages } from './message-dom.ts';

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
  return { submittedUserFound, laterUserFound, candidate };
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
