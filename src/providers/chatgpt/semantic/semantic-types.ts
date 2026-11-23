import type { Page } from "playwright-core";
import type { PageMutationMutex } from "../../../browser/page-mutex.ts";
import type { OwnedPageIdentity } from "../../../browser/owned-page-lifecycle.ts";
import type { SemanticActionPurpose, SemanticDispatchEvidence, SemanticRootPostEvidence, SemanticObservation, SemanticTaskContext } from "../../semantic-adapter.ts";
import { ChatGptBackendRecovery } from "../backend-recovery.ts";
import type { BackendJsonClient } from "../backend-recovery.ts";
import type { GenericChatGptControl } from "../semantic-generic-controls.ts";
import { contextKey } from "./chatgpt-page-access.ts";

export const EDITORS = 'main :is(#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"], textarea, [role="textbox"])';

export const BUTTONS = 'main :is(button, [role="button"])';

export const EMPTY_PROSEMIRROR_MARKER = ':scope > p.placeholder:only-child > br.ProseMirror-trailingBreak:only-child';

export const MAX_DRAFT = 200_000;

export const REF_TTL_MS = 30_000;

export const SEND_LABEL = /^(send|send message|submit|전송|보내기|메시지 전송)$/i;

export function observationBytes(packet: SemanticObservation): number {
  let bytes = Buffer.byteLength(JSON.stringify(packet));
  while (true) {
    const actual = Buffer.byteLength(JSON.stringify({ ...packet, evidenceBytes: bytes }));
    if (actual === bytes) return bytes;
    bytes = actual;
  }
}

export interface Control {
  readonly index: number;
  readonly signature: string;
  readonly value: string;
  readonly enabled: boolean;
}

export interface UiSnapshot {
  readonly editors: readonly Control[];
  readonly buttons: readonly Control[];
  readonly draftSha256: string | null;
  readonly fingerprint: string;
}

export interface CachedAction {
  readonly purpose: SemanticActionPurpose;
  readonly evidenceHash: string;
  readonly uiFingerprint: string;
  readonly contextKey: string;
  readonly expiresAtMs: number;
  readonly questionHash: string | null;
  readonly modelHash: string | null;
  readonly retryHash: string | null;
  readonly permissionHash: string | null;
  readonly permissionApp: string | null;
  readonly permissionTool: string | null;
  readonly permissionMode: 'once' | null;
  readonly genericControl: GenericChatGptControl | null;
}

export interface ActiveSnapshot {
  readonly snapshotId: string;
  readonly actions: Map<string, CachedAction>;
}

export interface ChatGptSemanticAdapterOptions {
  /** Exact Task/slot/page lease from the Core, including binding epoch. */
  readonly isExactLease: (identity: OwnedPageIdentity) => boolean;
  readonly resolvePage: (identity: OwnedPageIdentity) => Promise<Page> | Page;
  /** Share the single Core-owned page mutation mutex across every Task action. */
  readonly pageMutationMutex?: PageMutationMutex;
  /** Production accepts only ChatGPT's trusted HTTPS origins. Test overrides are isolated fixtures. */
  readonly allowedPageOrigins?: readonly string[];
  readonly backendOrigin?: string;
  readonly backendClient?: BackendJsonClient;
  /** Rebind to the current Core-owned auth context when a page is missing. */
  readonly backendClientProvider?: () => BackendJsonClient | Promise<BackendJsonClient>;
  readonly backendRecovery?: ChatGptBackendRecovery;
  /** Read-only exact root target after the first POST changed an owned root into
   * an identity-lost conversation candidate. This can never authorize an act. */
  readonly resolveRootRecoveryPage?: (input: {
    readonly context: SemanticTaskContext;
    readonly conversationId: string;
    readonly root: SemanticRootPostEvidence;
  }) => Page | null | Promise<Page | null>;
  /** Quiet stability required before a rate-limited backend FINAL may use exact provider-rendered evidence. */
  readonly rendererRecoveryQuietWindowMs?: number;
  /** Synchronous durable callback on the exact page POST, before an ACK probe.
   * It must never send, modify the UI, or log the message content.
   */
  readonly onDispatchObserved?: (input: {
    context: SemanticTaskContext; attemptId: string;
    evidence: SemanticDispatchEvidence;
  }) => void;
  /** Root POST identity is durable before a canonical conversation is known. */
  readonly onRootDispatchObserved?: (input: {
    context: SemanticTaskContext; attemptId: string;
    evidence: SemanticRootPostEvidence;
  }) => void;
  /** Accept the root page's one expected identity transition only after the
   * exact observed POST has been committed durably by the Core.
   */
  readonly isRootDispatchTransition?: (input: {
    context: SemanticTaskContext; attemptId: string; lease: OwnedPageIdentity;
  }) => boolean;
  /** Consume one exact journaled model/question/stream-retry decision before its effect. */
  readonly isAuthorizedDecision?: (input: {
    context: SemanticTaskContext;
    purpose: 'open_model_chooser' | 'close_model_chooser' |
      'choose_model' | 'choose_reasoning_effort' | 'answer_question' |
      'grant_permission' | 'decline_permission' | 'activate_control' |
      'set_control_value' | 'retry';
    decisionId: string; snapshotId: string; actionRef: string; evidenceHash: string; input: string | null;
  }) => boolean | Promise<boolean>;
  readonly isAuthorizedAttempt?: (input: {
    context: SemanticTaskContext; purpose: SemanticActionPurpose;
    attemptId: string; contentSha256: string | null; input: string | null;
  }) => boolean | Promise<boolean>;
}
