import type { Page } from 'playwright-core';

import type { ProviderAssistantCandidate, ProviderWakeReason } from '../provider-adapter.ts';
import { readChatGptMessageObservation } from './message-dom.ts';
import { CHATGPT_SELECTORS } from './selectors.ts';

export interface ChatGptDomObservation {
  readonly messageDiagnostics: Awaited<ReturnType<typeof readChatGptMessageObservation>>['diagnostics'];
  readonly actionableAlert: boolean;
  readonly providerAlerts: readonly string[];
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
  return { messageDiagnostics, submittedUserFound, laterUserFound, candidate, conversationSurfaceAvailable,
    actionableAlert: providerAlerts.length > 0, providerAlerts };
}

export async function observeChatGptAlerts(page: Page, identity: SubmittedUserIdentity, thinkingFailuresOnly = false): Promise<string[]> {
  return await page.locator('[data-message-id], [data-turn-id], [data-chatgpt-search-message-ids], [role=alert], [role=alertdialog], .text-token-text-error, .text-danger, [class~="group/activity-header"]').evaluateAll((elements, { identity, messagesSelector, userSelector, thinkingFailuresOnly }) => {
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
        if (!hasMessages) return !thinkingFailuresOnly;
        return anchor !== undefined && anchor.getRootNode() === alert.getRootNode() &&
          !alert.closest('[data-message-author-role="user"], [data-user-message-bubble]') &&
          Boolean(anchor.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING) &&
          (nextUser === undefined || Boolean(alert.compareDocumentPosition(nextUser) & Node.DOCUMENT_POSITION_FOLLOWING));
      }).map(alert => alert.innerText.trim().slice(0, 1_000));
  }, { identity, messagesSelector: CHATGPT_SELECTORS.messages, userSelector: CHATGPT_SELECTORS.userMessages, thinkingFailuresOnly });
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
