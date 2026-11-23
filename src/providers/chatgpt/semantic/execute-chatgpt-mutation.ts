import type { ChatGptSemanticRuntime } from './semantic-runtime.ts';
import type { CachedAction } from './semantic-types.ts';
import type { OwnedPageIdentity } from '../../../browser/owned-page-lifecycle.ts';
import type { SemanticActRequest } from '../../semantic-adapter.ts';
import { assertExactChatGptMutationContext } from './assert-exact-chatgpt-mutation-context.ts';
import { executeChatGptControlChoice, executeChatGptModelChoice, executeChatGptAnswerOrRetry } from './execute-chatgpt-choices.ts';
import { executeChatGptComposerAction } from './execute-chatgpt-composer.ts';
import type { ChatGptDispatchCapture } from './execute-chatgpt-composer.ts';

export async function mutateExactChatGptAction(runtime: ChatGptSemanticRuntime,
  request: SemanticActRequest, lease: OwnedPageIdentity,
  action: CachedAction, capture: ChatGptDispatchCapture,
) {
  const context = await assertExactChatGptMutationContext(runtime, request, lease, action);
  if (context === null) return 'stale' as const;
  const controls = await executeChatGptControlChoice(context);
  if (controls !== null) return controls;
  const model = await executeChatGptModelChoice(context);
  if (model !== null) return model;
  const answer = await executeChatGptAnswerOrRetry(context);
  if (answer !== null) return answer;
  return await executeChatGptComposerAction(context, capture);
}
