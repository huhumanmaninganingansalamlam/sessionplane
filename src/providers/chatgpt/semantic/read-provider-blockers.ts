import { inspectExactChatGptRetry } from './retry-observer.ts';

import { sha, captureUi } from "./chatgpt-page-access.ts";

import type { Page } from 'playwright-core';

import type { SemanticControlDescriptor, SemanticObservation, SemanticTaskContext } from '../../semantic-adapter.ts';


import { observeChatGptDialog } from '../dialog-observer.ts';

import { observeChatGptDom, observeChatGptAlerts } from '../dom-observer.ts';
import { hasMountedChatGptStream } from '../message-dom.ts';

import { inspectChatGptQuestion } from '../question.ts';
import { inspectChatGptFreeTextQuestion } from '../semantic-free-text-question.ts';
import { inspectSemanticHostSpanPermission } from '../semantic-hostspan-permission.ts';

import { inspectGenericChatGptControls } from '../semantic-generic-controls.ts';

export async function readProviderBlockers(page: Page, context: SemanticTaskContext) {
    let blocker: SemanticObservation['blocker'] = 'none';
    let reason: string | null = null;
    let progress: SemanticObservation['progress'] = 'unknown';
    const unverifiedTurn: SemanticObservation['turn'] = {
      submittedUserFound: false, laterUserFound: false,
      submittedUserMessageId: context.submittedUserMessageId,
      answerMessageId: null, partialAnswer: null,
    };
    let turn = unverifiedTurn;
    const dialog = await observeChatGptDialog(page);
    const ui = await captureUi(page);
    const unboundStream = true &&
      context.submittedUserMessageId === null && context.submittedUserTurnId === null &&
      await hasMountedChatGptStream(page);
    if (unboundStream) progress = 'streaming';
    if (context.submittedUserMessageId !== null || context.submittedUserTurnId !== null) {
      const dom = await observeChatGptDom(page, {
        submittedUserMessageId: context.submittedUserMessageId,
        submittedUserTurnId: context.submittedUserTurnId,
      });
      turn = {
        ...turn,
        submittedUserFound: dom.submittedUserFound,
        laterUserFound: dom.laterUserFound,
        answerMessageId: dom.candidate?.responseMessageId ?? null,
        partialAnswer: dom.candidate?.answerText ?? null,
      };
      progress = dom.candidate?.streamingMarker ? 'streaming'
        : dom.candidate?.terminalMarker ? 'idle' : dom.submittedUserFound ? 'idle' : 'unknown';
    }
    if (dialog.kind !== null) {
      blocker = dialog.kind === 'rate_limit' ? 'rate_limit' : 'human_verification';
      reason = dialog.reason;
    } else if (unboundStream) {
      blocker = 'unsupported';
      reason = 'generation-active-preserve-current-turn';
    } else if (turn.laterUserFound) {
      blocker = 'unsupported';
      reason = 'later-user-boundary';
    } else if ((context.submittedUserMessageId !== null ||
      context.submittedUserTurnId !== null) && !turn.submittedUserFound) {
      blocker = 'unsupported';
      reason = 'submitted-user-boundary-unverified';
    }

    const alerts = blocker === 'none' && (context.submittedUserMessageId !== null ||
      context.submittedUserTurnId !== null)
      ? await observeChatGptAlerts(page, {
          submittedUserMessageId: context.submittedUserMessageId,
          submittedUserTurnId: context.submittedUserTurnId,
        }) : [];
    if (alerts.some(alert => /^hostspan(?:-[a-z0-9_-]+)?\b/i.test(alert))) {
      blocker = 'provider_permission';
      reason = 'scoped-tool-permission-requires-reviewed-effect-and-arguments';
    }
    const inspectedPermission = (blocker === 'none' || blocker === 'provider_permission') &&
      context.submittedUserMessageId !== null
      ? await inspectSemanticHostSpanPermission(page, context.submittedUserMessageId) : null;
    const permissionGrant = inspectedPermission?.toolName === null ? null :
      context.permissionGrants?.find(grant =>
        grant.appName.toLowerCase() === inspectedPermission?.appName.toLowerCase() &&
        grant.toolName === inspectedPermission?.toolName && grant.allowMode === 'once') ?? null;
    const permission = inspectedPermission === null ? null : {
      ...inspectedPermission,
      canGrant: permissionGrant !== null &&
        inspectedPermission.detailState === 'visible_unverified' &&
        inspectedPermission.argumentsSummary !== null,
    };
    if (permission !== null) {
      blocker = 'provider_permission';
      reason = permission.canGrant
        ? 'scoped-permission-within-agent-delegation'
        : permission.detailState === 'visible_unverified'
          ? 'scoped-permission-outside-agent-delegation'
          : 'scoped-permission-arguments-missing-or-protected';
    }
    const retry = blocker === 'none' ? await inspectExactChatGptRetry(page, context) : null;
    if (retry !== null) {
      blocker = retry.available ? 'provider_retry' : 'unsupported';
      reason = retry.available ? 'exact-stream-retry-requires-journaled-attempt'
        : `stream-retry-${retry.reason}`;
    }
    const radioQuestion = blocker === 'none' ? await inspectChatGptQuestion(page) : null;
    const freeTextQuestion = blocker === 'none' && radioQuestion === null
      ? await inspectChatGptFreeTextQuestion(page) : null;
    const question = radioQuestion ?? freeTextQuestion;
    if (question !== null) {
      blocker = turn.submittedUserFound ? 'provider_question' : 'unsupported';
      reason = !turn.submittedUserFound ? 'provider-question-turn-unverified'
        : question.available ? 'provider-question-requires-decision' : 'question-evidence-incomplete-or-draft';
    }
    const genericControls = question === null && permission === null && retry === null &&
        context.submittedUserMessageId !== null && turn.submittedUserFound &&
        !turn.laterUserFound && progress !== 'streaming' &&
        (blocker === 'none' || blocker === 'human_verification' || blocker === 'unsupported')
      ? await inspectGenericChatGptControls(page, context.submittedUserMessageId) : [];
    const submitControlObservations: SemanticControlDescriptor[] = ui.buttons.length > 1
      ? ui.buttons.map(button => ({
          controlRef: sha(JSON.stringify({
            taskId: context.taskId, fingerprint: ui.fingerprint,
            index: button.index, signature: button.signature,
          })),
          role: 'button', label: button.value || 'Submit control',
          contextSummary: 'Multiple visible composer submit controls require exact UI resolution. Message submission remains owned by the current Task Attempt.',
          operation: 'activate', enabled: button.enabled, selected: null,
          currentValue: null, options: [],
          expectedEffect: 'Submit the exact journaled Task draft through the Core-owned Attempt path',
          relevance: 'Visible composer submit candidate for the current exact Task',
          risk: 'requires_human', executable: false,
        })) : [];
    const observedControls = [
      ...genericControls.map(control => control.descriptor),
      ...submitControlObservations,
    ];
    if (ui.buttons.length > 1 && blocker === 'none') {
      blocker = 'provider_control';
      reason = 'multiple-submit-controls-require-exact-ui-resolution';
    } else if (genericControls.length > 0) {
      blocker = 'provider_control';
      reason = genericControls.some(control => control.descriptor.executable)
        ? 'provider-controls-require-decision'
        : 'provider-controls-require-human-or-additional-observation';
    } else if (blocker === 'none' && progress === 'streaming') {
      blocker = 'unsupported';
      reason = 'generation-active-preserve-current-turn';
    } else if (blocker === 'none' && ui.editors.length !== 1) {
      blocker = 'unsupported';
      reason = ui.editors.length === 0 ? 'composer-not-found' : 'composer-ambiguous';
    }

    return { blocker, reason, progress, turn, ui, permission, retry,
      radioQuestion, freeTextQuestion, question, genericControls, observedControls };
}
