import type { Page } from 'playwright-core';

import type { ProviderAssistantCandidate, ProviderWakeReason } from '../provider-adapter.ts';
import { readChatGptMessageObservation, type ChatGptMessage } from './message-dom.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

// Capacity blocks a new turn, not read-only collection of an existing exact answer.
const CONVERSATION_CAPACITY_NOTICE = /^You['’]ve reached the maximum length for this conversation, but you can keep talking by starting a new chat\.(?: Start new chat)?$/i;
const MESSAGE_TIMEOUT = /^(?:메시지 전송 시간이 초과되었습니다\. 다시 시도하세요\.|Message (?:sending )?timed out\. Please try again\.)(?:\s*(?:다시 시도|Retry|Try again))?$/i;
export function isMessageTimeoutAlert(alert: string): boolean { return MESSAGE_TIMEOUT.test(alert.trim()); }

export interface ChatGptDomObservation {
  readonly messageDiagnostics: Awaited<ReturnType<typeof readChatGptMessageObservation>>['diagnostics'];
  readonly actionableAlert: boolean;
  readonly providerAlerts: readonly string[];
  readonly conversationSurfaceAvailable: boolean;
  readonly submittedUserFound: boolean;
  readonly laterUserFound: boolean;
  readonly candidate: ProviderAssistantCandidate | null;
  /** Read-only transcript evidence, never an exact-final decision or a replay authorization. */
  readonly turnBoundary: readonly ChatGptMessage[];
}

export interface SubmittedUserIdentity {
  readonly submittedUserMessageId: string | null;
  readonly submittedUserTurnId: string | null;
}

export async function observeChatGptDom(
  page: Page,
  identity: SubmittedUserIdentity,
): Promise<ChatGptDomObservation> {
  const { messages, diagnostics: messageDiagnostics } = await readChatGptMessageObservation(page, false,
    [identity.submittedUserMessageId, identity.submittedUserTurnId].filter((id): id is string => id !== null));
  let submittedUserFound = false;
  let laterUserFound = false;
  let candidate: ProviderAssistantCandidate | null = null;
  const anchors = messages.filter(message => message.role === 'user' &&
    ((identity.submittedUserMessageId !== null && message.messageId === identity.submittedUserMessageId) ||
      (identity.submittedUserTurnId !== null && message.turnId === identity.submittedUserTurnId)));
  // Roots have no common message order. Never splice an answer from another root,
  // or choose among duplicate exact anchors in different mounted transcripts.
  const anchor = anchors.length === 1 ? anchors[0] : undefined;
  const turnBoundary: ChatGptMessage[] = [];
  let userTurns = 0;
  for (const message of messages.slice(anchor === undefined ? messages.length : messages.indexOf(anchor))) {
    if (message.rootIndex !== anchor?.rootIndex) continue;
    if (message.role === 'user' && ++userTurns > 2) break;
    turnBoundary.push(message);
  }
  for (const message of messages) {
    if (anchor === undefined || message.rootIndex !== anchor.rootIndex) continue;
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
      // A later question cannot supply this request's answer or prove a partial final.
      if (!candidate?.terminalMarker || candidate.streamingMarker) candidate = null;
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
  const providerAlerts = await observeChatGptAlerts(page, identity);
  const canCollectExistingAnswer = submittedUserFound && !laterUserFound && candidate !== null &&
    !candidate.streamingMarker && candidate.answerText.trim().length > 0 &&
    !CONVERSATION_CAPACITY_NOTICE.test(candidate.answerText.replace(/\s+/g, ' ').trim());
  const actionableAlert = providerAlerts.some(alert => !canCollectExistingAnswer ||
    !CONVERSATION_CAPACITY_NOTICE.test(alert.replace(/\s+/g, ' ').trim()));
  // Retain all notices for diagnostics. Quiet/Stop/streaming and modal guards still
  // decide completion; this exception never permits another submission.
  return { messageDiagnostics, submittedUserFound, laterUserFound, candidate, turnBoundary, conversationSurfaceAvailable,
    actionableAlert, providerAlerts };
}

export async function observeChatGptAlerts(page: Page, identity: SubmittedUserIdentity, thinkingFailuresOnly = false): Promise<string[]> {
  return await page.locator('[data-message-id], [data-turn-id], [data-chatgpt-search-message-ids], [role=alert], [role=alertdialog], .text-token-text-error, .text-danger, [class~="group/activity-header"]').evaluateAll((elements, { identity, messagesSelector, userSelector, thinkingFailuresOnly, messageTimeoutPattern }) => {
    const roots = [...new Set<Document | ShadowRoot>([document, ...elements.map(element => element.getRootNode() as Document | ShadowRoot)])];
    const query = (selector: string) => roots.flatMap(root => [...root.querySelectorAll<HTMLElement>(selector)]);
    const ids = [identity.submittedUserMessageId, identity.submittedUserTurnId].filter(Boolean);
    const anchor = query('[data-message-id], [data-turn-id], [data-chatgpt-search-message-ids]')
      .find(node => [node.getAttribute('data-message-id'), node.getAttribute('data-turn-id'),
        ...(node.getAttribute('data-chatgpt-search-message-ids') ?? '').split(/\s+/)]
        .some(id => id !== null && ids.includes(id)));
    const nextUser = anchor === undefined ? undefined : query(userSelector)
      .find(user => !anchor.contains(user) && anchor.getRootNode() === user.getRootNode() &&
        Boolean(anchor.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING));
    const hasMessages = query(messagesSelector).length > 0;
    // Current reasoning failures use an activity disclosure, not an alert role.
    // Only its labelled provider header counts, never words quoted in a message.
    const thinkingFailures = anchor === undefined ? [] :
      query('[class~="group/activity-header"]').filter(header => {
        if (header.closest('[data-message-author-role="user"], [data-user-message-bubble], [data-chatgpt-selection-message-id], [data-message-content], .markdown') !== null) return false;
        const labelId = header.querySelector('button[aria-labelledby]')?.getAttribute('aria-labelledby');
        const label = labelId ? (header.getRootNode() as Document | ShadowRoot).getElementById(labelId) : null;
        return label !== null && header.contains(label) &&
          label.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
          /^(생각 실패|Thinking failed)$/i.test(label.innerText.trim());
      });
    return [...(thinkingFailuresOnly ? [] : query('[role="alert"], [role="alertdialog"], .text-token-text-error, .text-danger')), ...thinkingFailures]
      .filter(alert => {
        if (alert.closest('nav, [role="navigation"], #app-shell-sidebar, [aria-hidden="true"], [inert]') !== null ||
            !alert.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || !alert.innerText.trim()) return false;
        // Global alerts do not depend on a readable transcript. Turn-local errors
        // belong only between the exact submitted user and the next user.
        if (!alert.closest('main, article, [data-message-id], [data-turn-id], [data-chatgpt-search-message-ids]')) return !thinkingFailuresOnly;
        // The composer timeout aside belongs to the conversation, even when a
        // failed optimistic user turn has disappeared. Never read quoted errors
        // or a different message's local error as this conversation-level alert.
        if (!thinkingFailuresOnly && alert.matches('[role="alert"]') &&
            !alert.closest('[data-message-id], [data-turn-id], [data-message-author-role], [data-message-content], .markdown') &&
            new RegExp(messageTimeoutPattern, 'i').test(alert.innerText.trim())) return true;
        if (!hasMessages) return !thinkingFailuresOnly;
        return anchor !== undefined && anchor.getRootNode() === alert.getRootNode() &&
          !alert.closest('[data-message-author-role="user"], [data-user-message-bubble]') &&
          Boolean(anchor.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          (nextUser === undefined || Boolean(alert.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING));
      }).map(alert => alert.innerText.trim().slice(0, 1_000));
  }, { identity, messagesSelector: CHATGPT_SELECTORS.messages, userSelector: CHATGPT_SELECTORS.userMessages, thinkingFailuresOnly, messageTimeoutPattern: MESSAGE_TIMEOUT.source });
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
