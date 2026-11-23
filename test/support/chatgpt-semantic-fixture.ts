import type { Page } from 'playwright-core';
import type { SemanticTaskContext } from '../../src/providers/semantic-adapter.ts';

/** An owned exact-turn fact is explicit. No fixture discovers the active tab,
 * fabricates an ACK or creates a browser just because a page is available.
 */
export function seedExactTurn(input: {
  taskId: string; conversationId: string; userMessageId: string;
  userTurnId: string; projectId?: string; slotId?: string;
}): SemanticTaskContext {
  return {
    projectId: input.projectId ?? 'p', slotId: input.slotId ?? 'main',
    slotRevision: 1, taskId: input.taskId,
    providerConversationId: input.conversationId,
    submittedUserMessageId: input.userMessageId,
    submittedUserTurnId: input.userTurnId,
    pageLease: null,
  };
}

export function seedProviderControl(input: {
  evidenceHash: string;
  purpose: 'answer_question' | 'grant_permission' | 'decline_permission';
  effect: string;
}) {
  return Object.freeze({ ...input });
}

export function createChatGptPageFixture(input: {
  page: Page; context: SemanticTaskContext;
}) {
  return Object.freeze({ page: input.page, context: input.context });
}
