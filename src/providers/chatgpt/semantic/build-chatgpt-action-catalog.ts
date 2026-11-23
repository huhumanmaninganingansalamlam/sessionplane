import { readProviderBlockers } from './read-provider-blockers.ts';


import { MAX_DRAFT, REF_TTL_MS } from "./semantic-types.ts";
import type { CachedAction } from "./semantic-types.ts";
import { sha, contextKey } from "./chatgpt-page-access.ts";

import type { OwnedPageIdentity } from '../../../browser/owned-page-lifecycle.ts';
import type { SemanticActionCandidate, SemanticActionPurpose, SemanticCapabilityIssue, SemanticTaskContext } from '../../semantic-adapter.ts';
import { semanticConfigurationIntent, semanticConfigurationMatches } from '../../semantic-adapter.ts';

import { type GenericChatGptControl } from '../semantic-generic-controls.ts';
import { inspectSemanticChatGptModelMenu } from '../semantic-model-menu.ts';

export interface ChatGptActionCatalogInput {
  readonly context: SemanticTaskContext;
  readonly lease: OwnedPageIdentity;
  readonly scan: Awaited<ReturnType<typeof readProviderBlockers>>;
  readonly model: Awaited<ReturnType<typeof inspectSemanticChatGptModelMenu>>;
  readonly providerKey: 'chatgpt';
  readonly observedAtMs: number;
  readonly newActionRef: () => string;
}

export function cacheChatGptActionLeases(
  catalogInput: ChatGptActionCatalogInput,
  actions: SemanticActionCandidate[], cached: Map<string, CachedAction>,
) {
  const { lease, context } = catalogInput;
  return (purpose: SemanticActionPurpose, effect: string,
      risk: SemanticActionCandidate['risk'], input: SemanticActionCandidate['input'],
      fingerprint: string, questionHash: string | null = null,
      modelHash: string | null = null, retryHash: string | null = null,
      permissionHash: string | null = null, permissionApp: string | null = null,
      permissionTool: string | null = null, permissionMode: 'once' | null = null,
      genericControl: GenericChatGptControl | null = null): void => {
      const evidenceHash = sha(JSON.stringify({
        identity: lease, context: contextKey(context), purpose, fingerprint,
      }));
      const actionRef = catalogInput.newActionRef();
      const expiresAtMs = catalogInput.observedAtMs + REF_TTL_MS;
      const option = {
        actionRef, purpose, effect, risk, input, evidenceHash,
        expiresAt: new Date(expiresAtMs).toISOString(),
        ...(genericControl ? { control: genericControl.descriptor } : {}),
      };
      actions.push(option);
      cached.set(actionRef, {
        purpose, evidenceHash, uiFingerprint: fingerprint,
        contextKey: contextKey(context), expiresAtMs, questionHash, modelHash, retryHash,
        permissionHash, permissionApp, permissionTool, permissionMode, genericControl,
      });
    };
}

/** Build decision actions from a closed semantic snapshot: no DOM reads/clicks. */
export function buildChatGptActionCatalog(catalogInput: ChatGptActionCatalogInput) {
    const { context, lease, scan } = catalogInput;
    const { ui, permission, retry, radioQuestion, freeTextQuestion, question, genericControls } = scan;
    let { blocker, reason } = scan;
    let verifiedModel: string | null = null;
    let verifiedReasoningLevel: string | null = null;
    const actions: SemanticActionCandidate[] = [];
    const capabilityIssues: SemanticCapabilityIssue[] = [];
    const cached = new Map<string, CachedAction>();
    const issue = cacheChatGptActionLeases(catalogInput, actions, cached);

    if (blocker === 'provider_control') {
      for (const control of genericControls) {
        if (!control.descriptor.executable) continue;
        const input = control.descriptor.operation === 'set_text'
          ? { kind: 'text' as const, maxLength: MAX_DRAFT }
          : control.descriptor.operation === 'select_value'
            ? { kind: 'option' as const, options: control.descriptor.options }
            : { kind: 'none' as const };
        issue(control.descriptor.operation === 'activate'
          ? 'activate_control' : 'set_control_value',
        control.descriptor.expectedEffect, 'ui_control', input,
        ui.fingerprint, null, null, null, null, null, null, null, control);
      }
    } else if (blocker === 'provider_permission' && permission?.canGrant &&
        permission.toolName !== null) {
      issue('grant_permission',
        `Allow ${permission.appName}.${permission.toolName} once within the exact delegated scope`,
        'permission_grant', { kind: 'none' }, ui.fingerprint,
        null, null, null, permission.evidenceHash,
        permission.appName, permission.toolName, 'once');
      issue('decline_permission',
        `Decline ${permission.appName}.${permission.toolName} for this exact request`,
        'permission_decision', { kind: 'none' }, ui.fingerprint,
        null, null, null, permission.evidenceHash,
        permission.appName, permission.toolName, 'once');
    } else if (blocker === 'provider_retry' && retry?.available) {
      issue('retry', 'Retry one exact failed provider stream, with no prompt replay',
        'retry_once', { kind: 'none' }, ui.fingerprint, null, null, retry.evidenceHash);
    } else if (blocker === 'provider_question' && question?.available) {
      const input = radioQuestion !== null
        ? { kind: 'option' as const, options: radioQuestion.options.map(option => ({
          value: option.answer, enabled: !option.disabled,
        })) }
        : { kind: 'text' as const, maxLength: MAX_DRAFT };
      issue('answer_question', 'Answer the exact current provider question once',
        'send_once', input, ui.fingerprint, question.evidenceHash);
    } else if (blocker === 'none') {
      // A retained human/provider draft is not disposable. Only an empty
      // editor may be filled; an existing draft can be submitted solely when
      // the journaled exact content hash matches at dispatch time.
      if (context.providerConversationId !== null && ui.editors[0]!.value.length === 0) {
        issue('compose', 'Set the empty exact chat draft', 'draft_only',
          { kind: 'text', maxLength: MAX_DRAFT }, ui.fingerprint);
      }
      if (context.providerConversationId !== null &&
        ui.buttons.length === 1 && ui.buttons[0]!.enabled &&
        ui.editors[0]!.value.trim().length > 0) {
        // Draft text is not Task intent. An initial user prompt can itself be
        // exactly "계속"; only the durable attempt kind authorizes the click.
        issue('submit', 'Submit the existing exact chat draft once',
          'send_once', { kind: 'none' }, ui.fingerprint);
        if (ui.editors[0]!.value === '계속' &&
            context.submittedUserMessageId !== null &&
            context.submittedUserTurnId !== null) {
          issue('continue', 'Submit the existing exact continuation draft once',
            'send_once', { kind: 'none' }, ui.fingerprint);
        }
      }
      if (ui.buttons.length > 1) {
        blocker = 'provider_control';
        reason = 'multiple-submit-controls-require-exact-ui-resolution';
      }
      // Model/effort configuration is an explicit agent decision. Read-only
      // observe never opens either the root menu or a linked Pro submenu.
      if (blocker === 'none') {
        const model = catalogInput.model;
        const requiredEffort = context.requiredModel != null &&
          semanticConfigurationIntent(catalogInput.providerKey, context.requiredModel).kind === 'reasoning_effort';
        if (model?.status === 'closed' || model?.status === 'nested') {
          // A trusted closed composer label is an effort level, not a model
          // radio. Opening a menu is configuration-only, never send permission.
          verifiedReasoningLevel = model.status === 'closed'
            ? model.verifiedReasoningLevel : null;
          if (requiredEffort && model.status === 'nested') {
            if (model.strategy === 'composer-radix' &&
                model.verifiedReasoningLevel === 'Pro') {
              // No send while the chooser remains open, even after Pro proof.
              issue('close_model_chooser', 'Close verified Pro composer chooser',
                'configuration_only', { kind: 'none' }, ui.fingerprint,
                null, model.evidenceHash);
            } else if (model.strategy === 'composer-radix' &&
                       model.reasoningControlState === 'enabled' &&
                       model.fiveLevelPowerScaleVerified) {
              // One verified five-step pointer control; final proof is
              // the literal Pro trigger, never a guessed numeric thumb.
              issue('choose_reasoning_effort', 'Select and verify Pro effort',
                'configuration_only', { kind: 'none' }, ui.fingerprint,
                null, model.evidenceHash);
            } else {
              const why = model.reasoningControlState === 'disabled'
                ? 'reasoning-effort-control-disabled'
                : 'reasoning-effort-pro-target-unverified';
              capabilityIssues.push({ capability: 'model_choice', reason: why });
              reason = why;
            }
          } else if (!requiredEffort || verifiedReasoningLevel !== 'Pro') {
            issue('open_model_chooser', 'Inspect currently offered model controls',
              'configuration_only', { kind: 'none' }, ui.fingerprint,
              null, model.evidenceHash);
          }
        } else if (model?.status === 'open') {
          const checked = model.options.filter(option => option.selected && option.enabled);
          verifiedModel = checked.length === 1 ? checked[0]!.value : null;
          if (requiredEffort) {
            // The model-radio view must first close; radio names cannot
            // substitute for a Pro reasoning-level selection.
            if (model.strategy === 'composer-radix') {
              issue('close_model_chooser', 'Return to exact composer effort selector',
                'configuration_only', { kind: 'none' }, ui.fingerprint,
                null, model.evidenceHash);
            } else {
              capabilityIssues.push({ capability: 'model_choice',
                reason: 'reasoning-effort-pro-target-unverified' });
              reason = 'reasoning-effort-pro-target-unverified';
            }
          } else {
            issue('choose_model', 'Select one verified model menu option',
              'configuration_only', { kind: 'option', options: model.options.map(o => ({
                value: o.value, enabled: o.enabled,
              })) }, ui.fingerprint, null, model.evidenceHash);
          }
        } else if (model?.status === 'unsupported') {
          capabilityIssues.push({
            capability: 'model_choice', reason: model.reason ?? 'model-menu-unverified',
          });
        }
      }
      // First-root send is separately journaled and cannot be offered until
      // the exact project model is visibly selected. No unrelated Task may
      // borrow this root lease or mutate its draft.
      if (blocker === 'none' && context.providerConversationId === null &&
          context.requiredModel && semanticConfigurationMatches(
            catalogInput.providerKey, context.requiredModel,
            { verifiedModel, verifiedReasoningLevel })) {
        if (ui.editors[0]!.value.length === 0) {
          issue('compose', 'Prepare exact first public prompt on new chat root',
            'draft_only', { kind: 'text', maxLength: MAX_DRAFT }, ui.fingerprint);
        }
        if (ui.buttons.length === 1 && ui.buttons[0]!.enabled &&
            ui.editors[0]!.value.trim().length > 0) {
          issue('submit', 'Create one exact root conversation from committed Task prompt',
            'send_once', { kind: 'none' }, ui.fingerprint);
        }
      }
    }

    return { blocker, reason, verifiedModel, verifiedReasoningLevel, actions, capabilityIssues, cached };
}
