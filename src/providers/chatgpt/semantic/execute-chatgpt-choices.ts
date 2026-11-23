
import { MAX_DRAFT } from "./semantic-types.ts";

import { inspectExactChatGptRetry } from "./retry-observer.ts";

import { observeChatGptDom } from '../dom-observer.ts';


import { inspectChatGptQuestion, answerChatGptQuestion } from '../question.ts';
import { inspectChatGptFreeTextQuestion, answerChatGptFreeTextQuestion } from '../semantic-free-text-question.ts';
import { inspectSemanticHostSpanPermission } from '../semantic-hostspan-permission.ts';
import { controlHostSpanPermission } from '../hostspan-permission.ts';
import { actGenericChatGptControl } from '../semantic-generic-controls.ts';
import { inspectSemanticChatGptModelMenu, openExactChatGptModelMenu, closeExactChatGptModelMenu, selectExactChatGptProReasoningLevel, selectExactChatGptModelMenu } from '../semantic-model-menu.ts';

import { streamRetrySurface } from '../stream-retry.ts';

import type { ChatGptMutationContext } from './assert-exact-chatgpt-mutation-context.ts';
export async function executeChatGptControlChoice(input: ChatGptMutationContext) {
    const { page, action, request, requireExactMutationIdentity } = input;
      if (action.purpose === 'activate_control' ||
          action.purpose === 'set_control_value') {
        if (request.context.submittedUserMessageId === null ||
            action.genericControl === null) return 'stale' as const;
        requireExactMutationIdentity();
        const result = await actGenericChatGptControl(page,
          request.context.submittedUserMessageId, action.genericControl, request.input);
        if (result === 'stale') return 'stale' as const;
        if (result === 'unverified') return 'control_effect_unverified' as const;
        return action.purpose === 'activate_control'
          ? 'control_activated' as const : 'control_value_set' as const;
      }
      if (action.purpose === 'grant_permission' ||
          action.purpose === 'decline_permission') {
        if (request.context.submittedUserMessageId === null ||
            action.permissionHash === null || action.permissionApp === null ||
            action.permissionTool === null || action.permissionMode !== 'once') return 'stale' as const;
        const current = await inspectSemanticHostSpanPermission(
          page, request.context.submittedUserMessageId);
        const delegated = request.context.permissionGrants?.some(grant =>
          grant.appName.toLowerCase() === action.permissionApp!.toLowerCase() &&
          grant.toolName === action.permissionTool && grant.allowMode === 'once') === true;
        if (current === null || current.evidenceHash !== action.permissionHash ||
            current.appName !== action.permissionApp || current.toolName !== action.permissionTool ||
            current.detailState !== 'visible_unverified' || current.argumentsSummary === null ||
            !delegated) return 'stale' as const;
        requireExactMutationIdentity();
        const inspected = await controlHostSpanPermission(page, {
          action: 'inspect', appName: action.permissionApp,
          toolName: action.permissionTool, allowMode: 'once',
        }, request.context.submittedUserMessageId);
        if (inspected.outcome !== 'inspected' ||
            inspected.appName.toLowerCase() !== action.permissionApp.toLowerCase() ||
            inspected.toolName !== action.permissionTool ||
            inspected.permissionUserMessageId === null) return 'stale' as const;
        requireExactMutationIdentity();
        const controlled = await controlHostSpanPermission(page, {
          action: action.purpose === 'grant_permission' ? 'allow' : 'decline',
          appName: action.permissionApp, toolName: action.permissionTool,
          allowMode: 'once', evidenceHash: inspected.evidenceHash,
        }, request.context.submittedUserMessageId);
        if ('permissionStillVisible' in controlled && controlled.permissionStillVisible) {
          return 'permission_effect_unverified' as const;
        }
        return action.purpose === 'grant_permission'
          ? 'permission_granted' as const : 'permission_declined' as const;
      }
    return null;
}

export async function executeChatGptModelChoice(input: ChatGptMutationContext) {
    const { page, action, request, requireExactMutationIdentity } = input;
      if (action.purpose === 'open_model_chooser' ||
          action.purpose === 'close_model_chooser' ||
          action.purpose === 'choose_reasoning_effort' ||
          action.purpose === 'choose_model') {
        const model = await inspectSemanticChatGptModelMenu(page);
        if (!model || model.evidenceHash !== action.modelHash) return 'stale' as const;
        const requireExactModelTurn = async () => {
          requireExactMutationIdentity();
          if (request.context.submittedUserMessageId !== null ||
              request.context.submittedUserTurnId !== null) {
            const boundary = await observeChatGptDom(page, {
              submittedUserMessageId: request.context.submittedUserMessageId,
              submittedUserTurnId: request.context.submittedUserTurnId,
            });
            if (!boundary.submittedUserFound || boundary.laterUserFound ||
                boundary.candidate?.streamingMarker === true) {
              throw new Error('Model decision turn changed before mutation');
            }
          }
          requireExactMutationIdentity();
        };
        try { await requireExactModelTurn(); }
        catch { return 'stale' as const; }
        if (action.purpose === 'open_model_chooser') {
          if (model.status !== 'closed' && model.status !== 'nested') return 'stale' as const;
          await openExactChatGptModelMenu(page, model.evidenceHash, requireExactModelTurn);
          return 'model_menu_opened' as const;
        }
        if (action.purpose === 'close_model_chooser') {
          if (model.strategy !== 'composer-radix' ||
              !['open', 'nested'].includes(model.status)) return 'stale' as const;
          await closeExactChatGptModelMenu(page, model.evidenceHash, requireExactModelTurn);
          return 'model_menu_closed' as const;
        }
        if (action.purpose === 'choose_reasoning_effort') {
          if (model.strategy !== 'composer-radix' || model.status !== 'nested' ||
              model.reasoningControlState !== 'enabled' ||
              !model.fiveLevelPowerScaleVerified) return 'stale' as const;
          await selectExactChatGptProReasoningLevel(
            page, model.evidenceHash, requireExactModelTurn);
          return 'reasoning_effort_selected' as const;
        }
        if (model.status !== 'open' ||
          !model.options.some(option => option.value === request.input && option.enabled)) {
          return 'stale' as const;
        }
        await selectExactChatGptModelMenu(page, model.evidenceHash, request.input!,
          requireExactModelTurn);
        return 'model_selected' as const;
      }
    return null;
}

export async function executeChatGptAnswerOrRetry(input: ChatGptMutationContext) {
    const { page, action, request, requireExactMutationIdentity } = input;
      if (action.purpose === 'retry') {
        const retry = await inspectExactChatGptRetry(page, request.context);
        if (!retry?.available || retry.evidenceHash !== action.retryHash) {
          return 'stale' as const;
        }
        requireExactMutationIdentity();
        const clicked = await page.evaluate(streamRetrySurface, {
          origin: new URL(page.url()).origin,
          conversationId: request.context.providerConversationId!,
          anchor: request.context.submittedUserMessageId!,
          click: true, expiresAt: Date.now() + 5_000,
        });
        return clicked.reason === 'exact-stream-retry' && clicked.clicked
          ? 'retry_clicked_unverified' as const : 'stale' as const;
      }
      if (action.purpose === 'answer_question') {
        const radio = await inspectChatGptQuestion(page);
        const freeText = radio === null ? await inspectChatGptFreeTextQuestion(page) : null;
        if (radio !== null) {
          if (!radio.available || radio.evidenceHash !== action.questionHash ||
            !radio.options.some(o => o.answer === request.input && !o.disabled)) {
            return 'stale' as const;
          }
        } else if (!freeText?.available || freeText.evidenceHash !== action.questionHash ||
          request.input!.length > MAX_DRAFT) {
          return 'stale' as const;
        }
        const requireExactQuestionTurn = async () => {
          requireExactMutationIdentity();
          const boundary = await observeChatGptDom(page, {
            submittedUserMessageId: request.context.submittedUserMessageId,
            submittedUserTurnId: request.context.submittedUserTurnId,
          });
          if (!boundary.submittedUserFound || boundary.laterUserFound) {
            throw new Error('Exact question user turn changed before mutation');
          }
          requireExactMutationIdentity();
        };
        try { await requireExactQuestionTurn(); }
        catch { return 'stale' as const; }
        if (radio !== null) {
          await answerChatGptQuestion(page, {
            answer: request.input!, evidenceHash: action.questionHash!,
          }, requireExactQuestionTurn);
        } else {
          await answerChatGptFreeTextQuestion(page, {
            answer: request.input!, evidenceHash: action.questionHash!,
          }, requireExactQuestionTurn);
        }
        return 'question_answered' as const;
      }
    return null;
}
