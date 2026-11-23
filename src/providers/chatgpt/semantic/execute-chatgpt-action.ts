import { mutateExactChatGptAction } from './execute-chatgpt-mutation.ts';
import type { ChatGptDispatchCapture } from './execute-chatgpt-composer.ts';
import type { ChatGptSemanticRuntime } from './semantic-runtime.ts';
import { MAX_DRAFT } from "./semantic-types.ts";

import { contextKey, exactContext } from "./chatgpt-page-access.ts";

import type { SemanticActRequest, SemanticActResult } from '../../semantic-adapter.ts';
import { semanticConfigurationIntent } from '../../semantic-adapter.ts';

export async function executeChatGptAction(runtime: ChatGptSemanticRuntime, request: SemanticActRequest): Promise<SemanticActResult> {
    const lease = request.context.pageLease;
    if (lease === null || !exactContext(request.context, lease) ||
      !runtime.options.isExactLease(lease)) return { kind: 'stale', reason: 'page-lease-unverified' };
    const snapshot = runtime.latest.get(lease.pageKey);
    const action = snapshot?.snapshotId === request.snapshotId
      ? snapshot.actions.get(request.actionRef) : undefined;
    if (!action || action.contextKey !== contextKey(request.context) ||
      action.evidenceHash !== request.evidenceHash || Date.now() > action.expiresAtMs) {
      return { kind: 'stale', reason: 'action-ref-stale-or-foreign' };
    }
    // Validate input before consuming a durable one-shot decision.
    if (action.purpose === 'compose' && (!request.input || request.input.length > MAX_DRAFT)) {
      return { kind: 'unsupported', reason: 'invalid-draft-input' };
    }
    if (action.purpose === 'choose_model' && request.context.requiredModel &&
        semanticConfigurationIntent(runtime.providerKey, request.context.requiredModel).kind ===
          'reasoning_effort') {
      return { kind: 'unsupported', reason: 'reasoning-effort-is-not-model-radio' };
    }
    if ((action.purpose === 'choose_reasoning_effort' ||
         action.purpose === 'close_model_chooser') &&
        (!request.context.requiredModel ||
         semanticConfigurationIntent(runtime.providerKey, request.context.requiredModel).kind !==
           'reasoning_effort' || request.input !== undefined)) {
      return { kind: 'unsupported', reason: 'exact-reasoning-effort-decision-required' };
    }
    if (action.purpose === 'choose_model' && (!request.input || request.input.length > 160)) {
      return { kind: 'unsupported', reason: 'exact-model-option-required' };
    }
    if (action.purpose === 'answer_question' && (!request.input || request.input.length > MAX_DRAFT)) {
      return { kind: 'unsupported', reason: 'question-option-required' };
    }
    if ((action.purpose === 'grant_permission' || action.purpose === 'decline_permission') &&
        request.input !== undefined) {
      return { kind: 'unsupported', reason: 'permission-decision-does-not-accept-input' };
    }
    if (action.purpose === 'activate_control' && request.input !== undefined) {
      return { kind: 'unsupported', reason: 'control-activation-does-not-accept-input' };
    }
    if (action.purpose === 'set_control_value' &&
        (typeof request.input !== 'string' || request.input.length > MAX_DRAFT)) {
      return { kind: 'unsupported', reason: 'control-value-required' };
    }
    if ((action.purpose === 'submit' || action.purpose === 'continue') &&
      (!request.expectedContentSha256 || !/^[a-f0-9]{64}$/.test(request.expectedContentSha256))) {
      return { kind: 'authorization_required', reason: 'exact-committed-content-hash-required' };
    }
    // A model/question decision is consumed once before the UI effect; a
    // stale or failed click never grants permission to replay the decision.
    if (action.purpose !== 'compose' && !(await runtime.authorizeAction(request, action.purpose))) {
      return { kind: 'authorization_required', reason: 'journaled-action-authorization-unverified' };
    }
    // Journal authorization can await I/O. Another caller or new observation
    // may have consumed/superseded this ref while that check was pending.
    if (runtime.latest.get(lease.pageKey) !== snapshot ||
      snapshot?.actions.get(request.actionRef) !== action) {
      return { kind: 'stale', reason: 'action-ref-stale-or-foreign' };
    }
    const capture: ChatGptDispatchCapture = { attempts: [], rootPosts: [], sinkFailed: false };
    // An action lease is consumed before any page mutation; never replay.
    snapshot!.actions.delete(request.actionRef);
    runtime.latest.delete(lease.pageKey);
    runtime.revision.set(lease.pageKey, {});
    const acceptRootDispatchTransition =
      request.context.providerConversationId === null && action.purpose === 'submit' &&
      request.authorizedAttemptId && runtime.options.isRootDispatchTransition
        ? () => runtime.options.isRootDispatchTransition!({
            context: request.context, attemptId: request.authorizedAttemptId!, lease,
          }) : undefined;
    const result = await runtime.gate.run(lease, 'mutate', async () =>
      await mutateExactChatGptAction(runtime, request, lease, action, capture),
      8_000, acceptRootDispatchTransition);
    if (result.kind === 'stale') return { kind: 'stale', reason: 'lease-revoked' };
    if (result.kind === 'busy') return { kind: 'busy', reason: 'page-operation-in-flight' };
    if (result.kind !== 'ok') return { kind: 'uncertain', reason: result.reason,
      attempts: capture.attempts };
    if (result.value === 'stale') return { kind: 'stale', reason: 'semantic-evidence-changed-before-action' };
    if (result.value === 'retry_clicked_unverified') return {
      kind: 'uncertain', reason: 'retry-clicked-provider-progress-unverified',
    };
    if (result.value === 'permission_effect_unverified') return {
      kind: 'uncertain', reason: 'permission-effect-unverified',
    };
    if (result.value === 'control_effect_unverified') return {
      kind: 'uncertain', reason: 'provider-control-effect-unverified',
    };
    if ((result.value === 'send' || result.value === 'root_send') &&
        capture.sinkFailed) return {
      kind: 'uncertain', reason: 'durable-dispatch-evidence-write-failed',
      attempts: capture.attempts,
    };
    if (result.value === 'root_send') return {
      kind: 'root_dispatched_unverified', effect: 'send', rootPosts: capture.rootPosts,
    };
    if (result.value === 'send') return { kind: 'dispatched_unverified', effect: 'send',
      attempts: capture.attempts };
    return { kind: 'performed', effect: result.value };
  }
