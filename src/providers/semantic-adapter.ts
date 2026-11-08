import type { OwnedPageIdentity } from '../browser/owned-page-lifecycle.ts';

/**
 * Semantic provider contract. Core receives facts and opaque one-shot actions,
 * not DOM locators, browser handles, selectors, or provider-specific widgets.
 * Non-browser providers can set pageLease=null without inventing Chrome state.
 */
export type SemanticCapability =
  | 'conversation' | 'model_choice' | 'question' | 'permission'
  | 'continuation' | 'artifact_read' | 'artifact_write';
export type SemanticSurface = 'chat' | 'work' | 'unknown';
export type SemanticProgress = 'unknown' | 'idle' | 'streaming' | 'final';
export type SemanticActionPurpose =
  | 'compose' | 'submit' | 'open_model_chooser' | 'choose_model' | 'answer_question'
  | 'grant_permission' | 'retry' | 'continue';
export type SemanticActionRisk =
  | 'draft_only' | 'configuration_only' | 'send_once'
  | 'permission_grant' | 'retry_once';
export interface SemanticTaskContext {
  readonly projectId: string;
  readonly slotId: string;
  readonly slotRevision: number;
  readonly taskId: string;
  readonly providerConversationId: string | null;
  readonly submittedUserMessageId: string | null;
  readonly submittedUserTurnId: string | null;
  readonly pageLease: OwnedPageIdentity | null;
}
export interface SemanticCapabilityManifest {
  readonly providerKey: string;
  readonly browserRequired: boolean;
  readonly supports: readonly SemanticCapability[];
  readonly contractVersion: 1;
}
export type SemanticInput =
  | { readonly kind: 'none' }
  | { readonly kind: 'text'; readonly maxLength: number }
  | { readonly kind: 'option'; readonly options: readonly {
      readonly value: string; readonly enabled: boolean;
    }[] };
export interface SemanticActionCandidate {
  readonly actionRef: string;
  readonly purpose: SemanticActionPurpose;
  readonly effect: string;
  readonly risk: SemanticActionRisk;
  readonly evidenceHash: string;
  readonly expiresAt: string;
  readonly input: SemanticInput;
}
export interface SemanticTurn {
  readonly submittedUserFound: boolean;
  readonly laterUserFound: boolean;
  readonly submittedUserMessageId: string | null;
  readonly answerMessageId: string | null;
  readonly partialAnswer: string | null;
}
/** Provider-owned visible permission evidence is never authorization.
 * Missing/redacted material arguments must be expanded through a reviewed flow.
 */
export interface SemanticPermissionEvidence {
  readonly appName: string;
  readonly toolName: string | null;
  readonly visibleSummary: string;
  readonly argumentsSummary: string | null;
  readonly detailState: 'not_visible' | 'visible_unverified' | 'truncated' | 'redacted';
  readonly evidenceHash: string;
  readonly canGrant: false;
}
export interface SemanticObservation {
  readonly providerKey: string;
  readonly surface: SemanticSurface;
  readonly snapshotId: string;
  readonly observedAt: string;
  readonly capabilityManifest: SemanticCapabilityManifest;
  readonly progress: SemanticProgress;
  readonly blocker: 'none' | 'rate_limit' | 'human_verification' |
    'provider_question' | 'provider_permission' | 'provider_retry' | 'unsupported';
  readonly reason: string | null;
  readonly turn: SemanticTurn;
  readonly questionText: string | null;
  readonly permission?: SemanticPermissionEvidence | null;
  readonly actions: readonly SemanticActionCandidate[];
  readonly evidenceBytes: number;
}
export interface SemanticActRequest {
  readonly context: SemanticTaskContext;
  readonly snapshotId: string;
  readonly actionRef: string;
  readonly evidenceHash: string;
  readonly input?: string;
  /** Irreversible effects require a previously journaled exact attempt. */
  readonly authorizedAttemptId?: string;
  /** Configuration and other agent decisions are separately journaled. */
  readonly authorizedDecisionId?: string;
  /** SHA-256 of the exact durable attempt content, not a UI-visible guess. */
  readonly expectedContentSha256?: string;
}
export type SemanticActResult =
  | { readonly kind: 'performed'; readonly effect: 'draft_updated' | 'question_answered' |
      'model_menu_opened' | 'model_selected' }
  | { readonly kind: 'dispatched_unverified'; readonly effect: 'send';
      readonly attempts: readonly SemanticDispatchEvidence[] }
  | { readonly kind: 'stale' | 'busy' | 'unsupported' | 'authorization_required'; readonly reason: string }
  | { readonly kind: 'uncertain'; readonly reason: string;
      readonly attempts?: readonly SemanticDispatchEvidence[] };
export interface SemanticDispatchEvidence {
  readonly conversationId: string;
  readonly messageId: string;
  readonly parentMessageId: string;
  readonly textHash: string;
  readonly observedAt: string;
}
export interface SemanticExactQuery {
  readonly context: SemanticTaskContext;
  readonly kind: 'ack' | 'final';
  readonly prompt?: string;
  readonly attempts?: readonly SemanticDispatchEvidence[];
}
export type SemanticVerification =
  | { readonly kind: 'verified_ack'; readonly externalTurnId: string; readonly messageId: string }
  | { readonly kind: 'exact_final'; readonly externalTurnId: string; readonly answerText: string }
  | { readonly kind: 'pending' | 'unavailable'; readonly reason: string };
export interface SemanticProviderAdapter {
  readonly providerKey: string;
  readonly capabilities: SemanticCapabilityManifest;
  observe(context: SemanticTaskContext): Promise<SemanticObservation>;
  act(request: SemanticActRequest): Promise<SemanticActResult>;
  /** Read-only canonical evidence; a page draft or optimistic user node is never an ACK. */
  verify(query: SemanticExactQuery): Promise<SemanticVerification>;
  /** Always read-only, even when the page is missing or the Core restarted. */
  recover(query: SemanticExactQuery): Promise<SemanticVerification>;
}
