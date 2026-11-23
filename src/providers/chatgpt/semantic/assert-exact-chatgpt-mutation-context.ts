import type { ChatGptSemanticRuntime } from './semantic-runtime.ts';

import type { CachedAction, UiSnapshot } from "./semantic-types.ts";
import { conversationBindingProblem, captureUi } from "./chatgpt-page-access.ts";


import { inspectExactChatGptRetry } from "./retry-observer.ts";

import type { Page } from 'playwright-core';


import type { OwnedPageIdentity } from '../../../browser/owned-page-lifecycle.ts';
import type { SemanticActRequest } from '../../semantic-adapter.ts';


import { observeChatGptDialog } from '../dialog-observer.ts';

import { observeChatGptDom, observeChatGptAlerts } from '../dom-observer.ts';
import { hasMountedChatGptStream } from '../message-dom.ts';

import { inspectChatGptQuestion } from '../question.ts';
import { inspectChatGptFreeTextQuestion } from '../semantic-free-text-question.ts';
import { inspectSemanticHostSpanPermission } from '../semantic-hostspan-permission.ts';

import { observeChatGptSurface } from '../surface.ts';


export interface ChatGptMutationContext {
  readonly runtime: ChatGptSemanticRuntime;
  readonly request: SemanticActRequest;
  readonly lease: OwnedPageIdentity;
  readonly action: CachedAction;
  readonly page: Page;
  readonly fresh: UiSnapshot;
  readonly requireExactMutationIdentity: () => void;
}
export async function assertExactChatGptMutationContext(
  runtime: ChatGptSemanticRuntime, request: SemanticActRequest,
  lease: OwnedPageIdentity, action: CachedAction,
): Promise<ChatGptMutationContext | null> {
      const page = await runtime.options.resolvePage(lease);
      runtime.assertTrustedOrigin(page);
      if (conversationBindingProblem(page, request.context) !== null) return null;
      const requireExactMutationIdentity = () => {
        if (!runtime.options.isExactLease(lease)) {
          throw new Error('Page lease revoked before semantic mutation');
        }
        runtime.assertTrustedOrigin(page);
        if (conversationBindingProblem(page, request.context) !== null) {
          throw new Error('Conversation changed before semantic mutation');
        }
      };
      const surface = await observeChatGptSurface(page);
      if (surface.mode !== 'chat' || (await observeChatGptDialog(page)).kind !== null) {
        return null;
      }
      if (request.context.submittedUserMessageId === null &&
          request.context.submittedUserTurnId === null &&
          await hasMountedChatGptStream(page)) return null;
      // The composer may stay unchanged while its exact user anchor is
      // unmounted or followed by another user. Recheck before any mutation.
      if (request.context.submittedUserMessageId !== null ||
          request.context.submittedUserTurnId !== null) {
        const boundary = await observeChatGptDom(page, {
          submittedUserMessageId: request.context.submittedUserMessageId,
          submittedUserTurnId: request.context.submittedUserTurnId,
        });
        if (!boundary.submittedUserFound || boundary.laterUserFound ||
            (boundary.candidate?.streamingMarker === true && action.purpose !== 'answer_question')) {
          return null;
        }
      }
      // An intervening provider-owned question, permission card or exact retry
      // invalidates a prior draft/send/configuration action. Composer-only
      // fingerprints cannot detect these independent UI surfaces.
      if (request.context.submittedUserMessageId !== null ||
          request.context.submittedUserTurnId !== null) {
        const permissionAction = action.purpose === 'grant_permission' ||
          action.purpose === 'decline_permission';
        const alerts = await observeChatGptAlerts(page, {
          submittedUserMessageId: request.context.submittedUserMessageId,
          submittedUserTurnId: request.context.submittedUserTurnId,
        });
        const currentPermission = request.context.submittedUserMessageId === null ? null :
          await inspectSemanticHostSpanPermission(page, request.context.submittedUserMessageId);
        if (permissionAction) {
          const delegated = currentPermission?.toolName !== null &&
            request.context.permissionGrants?.some(grant =>
              grant.appName.toLowerCase() === currentPermission?.appName.toLowerCase() &&
              grant.toolName === currentPermission?.toolName && grant.allowMode === 'once') === true;
          if (currentPermission === null || currentPermission.evidenceHash !== action.permissionHash ||
              currentPermission.appName !== action.permissionApp ||
              currentPermission.toolName !== action.permissionTool ||
              action.permissionMode !== 'once' || !delegated ||
              currentPermission.detailState !== 'visible_unverified' ||
              currentPermission.argumentsSummary === null) return null;
        } else if (alerts.some(alert => /^hostspan(?:-[a-z0-9_-]+)?\b/i.test(alert)) ||
                   currentPermission !== null) {
          return null;
        }
      }
      if (action.purpose !== 'retry' &&
          (await inspectExactChatGptRetry(page, request.context)) !== null) return null;
      if (action.purpose !== 'answer_question' &&
          ((await inspectChatGptQuestion(page)) !== null ||
            (await inspectChatGptFreeTextQuestion(page)) !== null)) return null;
      const fresh = await captureUi(page);
      if (fresh.fingerprint !== action.uiFingerprint) return null;
    return { runtime, request, lease, action, page, fresh, requireExactMutationIdentity };
}
