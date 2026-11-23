import { recoverRenderedChatGptDispatch, recoverExactChatGptTurn } from './semantic/recover-exact-chatgpt-turn.ts';
import type { ChatGptRecoveryRuntime } from './semantic/recover-exact-chatgpt-turn.ts';
import { observeChatGptTask } from './semantic/observe-chatgpt-task.ts';
import { executeChatGptAction } from './semantic/execute-chatgpt-action.ts';
import type { ChatGptSemanticRuntime } from './semantic/semantic-runtime.ts';

import type { ActiveSnapshot, ChatGptSemanticAdapterOptions } from "./semantic/semantic-types.ts";
import { exactContext } from "./semantic/chatgpt-page-access.ts";

import { chatGptBackendJsonClient } from "./semantic/recover-chatgpt-turn.ts";
export type { ChatGptSemanticAdapterOptions } from './semantic/semantic-types.ts';
export { chatGptBackendJsonClient } from './semantic/recover-chatgpt-turn.ts';


import type { Page } from 'playwright-core';

import { PageOperationGate } from '../../browser/page-operation-gate.ts';

import type { OwnedPageIdentity } from '../../browser/owned-page-lifecycle.ts';
import type { SemanticActRequest, SemanticActResult, SemanticActionPurpose, SemanticDispatchEvidence, SemanticExactQuery, SemanticObservation, SemanticProviderAdapter, SemanticTaskContext, SemanticVerification } from '../semantic-adapter.ts';

import { ChatGptBackendRecovery, type BackendJsonClient } from './backend-recovery.ts';

import { ExactFinalTracker } from './exact-final.ts';

/** JSON byte count includes the width of its own evidenceBytes number. */

/**
 * B-first semantic port. All selectors and DOM fallbacks stay here; the
 * DurableTaskKernel sees only semantic choices. Existing canonical backend
 * parsers prove ACK/FINAL. Under backend 429 only, a unique provider-rendered
 * user+assistant turn may prove the same identity; an act receipt or optimistic user node never can.
 */
export class ChatGptSemanticAdapter implements SemanticProviderAdapter {
  readonly providerKey = 'chatgpt';
  readonly capabilities = Object.freeze({
    providerKey: 'chatgpt', browserRequired: true, contractVersion: 1 as const,
    supports: ['conversation', 'question', 'permission', 'continuation', 'model_choice'] as const,
  });
  readonly #options: ChatGptSemanticAdapterOptions;
  readonly #gate: PageOperationGate;
  readonly #backend: ChatGptBackendRecovery;
  readonly #rendererRecoveryQuietWindowMs: number;
  readonly #rendererFinalTrackers = new Map<string, ExactFinalTracker>();
  readonly #latest = new Map<string, ActiveSnapshot>();
  /** Monotonic identity token: a published+consumed snapshot cannot ABA to absent. */
  readonly #revision = new Map<string, object>();

  constructor(options: ChatGptSemanticAdapterOptions) {
    this.#options = options;
    this.#gate = new PageOperationGate(options.isExactLease, options.pageMutationMutex);
    this.#backend = options.backendRecovery ?? new ChatGptBackendRecovery({
      requestTimeoutMs: 15_000, tokenCacheTtlMs: 60_000,
    });
    this.#rendererRecoveryQuietWindowMs = options.rendererRecoveryQuietWindowMs ?? 1_500;
    if (!Number.isSafeInteger(this.#rendererRecoveryQuietWindowMs) ||
        this.#rendererRecoveryQuietWindowMs <= 0) {
      throw new Error('rendererRecoveryQuietWindowMs must be a positive integer');
    }
  }

  #semanticRuntime(): ChatGptSemanticRuntime {
    return { providerKey: this.providerKey, capabilities: this.capabilities,
      options: this.#options, gate: this.#gate, latest: this.#latest,
      revision: this.#revision,
      resolveExactPage: context => this.#exactPage(context),
      assertTrustedOrigin: page => this.#checkOrigin(page),
      authorizeAction: (request,purpose) => this.#authorized(request,purpose),
    };
  }

  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    return await observeChatGptTask(this.#semanticRuntime(), context);
  }

  async act(request: SemanticActRequest): Promise<SemanticActResult> {
    return await executeChatGptAction(this.#semanticRuntime(), request);
  }

  async #authorized(request: SemanticActRequest, purpose: SemanticActionPurpose): Promise<boolean> {
    if (purpose === 'compose') return true;
    if (purpose === 'open_model_chooser' || purpose === 'close_model_chooser' ||
        purpose === 'choose_model' || purpose === 'choose_reasoning_effort' ||
        purpose === 'answer_question' || purpose === 'grant_permission' ||
        purpose === 'decline_permission' || purpose === 'activate_control' ||
        purpose === 'set_control_value' || purpose === 'retry') {
      if (!request.authorizedDecisionId || !this.#options.isAuthorizedDecision) return false;
      try {
        return await this.#options.isAuthorizedDecision({
          context: request.context, purpose, decisionId: request.authorizedDecisionId,
          snapshotId: request.snapshotId, actionRef: request.actionRef, evidenceHash: request.evidenceHash,
          input: request.input ?? null,
        });
      } catch { return false; }
    }
    if (!request.authorizedAttemptId || !this.#options.isAuthorizedAttempt) return false;
    try {
      return await this.#options.isAuthorizedAttempt({
        context: request.context, purpose, attemptId: request.authorizedAttemptId,
        contentSha256: request.expectedContentSha256 ?? null, input: request.input ?? null,
      });
    } catch { return false; }
  }

  #recoveryRuntime(): ChatGptRecoveryRuntime {
    return { providerKey: this.providerKey, options: this.#options, backend: this.#backend,
      rendererFinalTrackers: this.#rendererFinalTrackers,
      rendererRecoveryQuietWindowMs: this.#rendererRecoveryQuietWindowMs,
      exactPage: context => this.#exactPage(context),
      checkOrigin: page => this.#checkOrigin(page),
      pageBackendClient: context => this.#pageBackendClient(context),
    };
  }
  async recoverDispatch(input: { readonly context: SemanticTaskContext; readonly prompt: string; }): Promise<SemanticDispatchEvidence | null> {
    return await recoverRenderedChatGptDispatch(this.#recoveryRuntime(), input);
  }

  async verify(query: SemanticExactQuery): Promise<SemanticVerification> {
    return await this.recover(query);
  }

  async reserveFinalRead(input: {
    readonly context: SemanticTaskContext; readonly notBefore: string;
  }): Promise<void> {
    const conversationId = input.context.providerConversationId;
    if (conversationId === null || input.context.submittedUserMessageId === null ||
        input.context.submittedUserTurnId === null) return;
    this.#backend.reserveExactTurn(conversationId, input.notBefore);
  }

  async recover(query: SemanticExactQuery): Promise<SemanticVerification> {
    return await recoverExactChatGptTurn(this.#recoveryRuntime(), query);
  }

  async #exactPage(context: SemanticTaskContext): Promise<{ lease: OwnedPageIdentity; page: Page }> {
    const lease = context.pageLease;
    if (lease === null || !exactContext(context, lease) ||
      !this.#options.isExactLease(lease)) throw new Error('Stale exact Task/page lease');
    const page = await this.#options.resolvePage(lease);
    this.#checkOrigin(page);
    if (!this.#options.isExactLease(lease)) throw new Error('Lease changed during page resolution');
    return { lease, page };
  }

  #checkOrigin(page: Page): void {
    const allowed = this.#options.allowedPageOrigins ?? [
      'https://chatgpt.com', 'https://chat.openai.com',
    ];
    let origin: string;
    try { origin = new URL(page.url()).origin; }
    catch { throw new Error('ChatGPT page URL unavailable'); }
    if (!allowed.includes(origin)) throw new Error('Foreign or unverified ChatGPT page origin');
  }

  async #pageBackendClient(context: SemanticTaskContext): Promise<BackendJsonClient> {
    const { page } = await this.#exactPage(context);
    return chatGptBackendJsonClient(page.context().request);
  }
}
