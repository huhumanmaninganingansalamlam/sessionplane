import type { Page } from 'playwright-core';
import type { OwnedPageIdentity } from '../../../browser/owned-page-lifecycle.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../backend-recovery.ts';
import { ExactFinalTracker } from '../exact-final.ts';
import { observeChatGptDom } from '../dom-observer.ts';
import { observeChatGptActivity } from '../activity-observer.ts';
import { observeChatGptDialog } from '../dialog-observer.ts';
import { readChatGptMessages, matchesSubmittedChatGptUser } from '../message-dom.ts';
import type { ChatGptSemanticAdapterOptions } from './semantic-types.ts';
import type { SemanticDispatchEvidence, SemanticExactQuery, SemanticVerification, SemanticTaskContext, SemanticRootPostEvidence } from '../../semantic-adapter.ts';
import { sha } from './chatgpt-page-access.ts';

export interface ChatGptRecoveryRuntime {
  readonly providerKey: 'chatgpt';
  readonly options: ChatGptSemanticAdapterOptions;
  readonly backend: ChatGptBackendRecovery;
  readonly rendererRecoveryQuietWindowMs: number;
  readonly rendererFinalTrackers: Map<string, ExactFinalTracker>;
  readonly exactPage: (context: SemanticTaskContext) => Promise<{lease: OwnedPageIdentity; page: Page}>;
  readonly checkOrigin: (page: Page) => void;
  readonly pageBackendClient: (context: SemanticTaskContext) => Promise<BackendJsonClient>;
}
export async function recoverRenderedChatGptDispatch(runtime: ChatGptRecoveryRuntime, input: {
    readonly context: SemanticTaskContext; readonly prompt: string;
  }): Promise<SemanticDispatchEvidence | null> {
    const { context, prompt } = input;
    if (context.pageLease === null || context.providerConversationId === null ||
        context.submittedUserMessageId === null || context.submittedUserTurnId === null) return null;
    let page: Page;
    try { page = (await runtime.exactPage(context)).page; } catch { return null; }
    try {
      const url = new URL(page.url());
      if (url.pathname !== `/c/${encodeURIComponent(context.providerConversationId)}` ||
          url.search !== '' || url.hash !== '') return null;
      const messages = await readChatGptMessages(page);
      const anchors = messages.map((message, index) => ({ message, index })).filter(({ message }) =>
        matchesSubmittedChatGptUser(message, {
          submittedUserMessageId: context.submittedUserMessageId,
          submittedUserTurnId: context.submittedUserTurnId,
        }));
      if (anchors.length !== 1) return null;
      const laterUsers = messages.slice(anchors[0]!.index + 1).filter(message => message.role === 'user');
      const candidate = laterUsers.length === 1 ? laterUsers[0]! : null;
      if (candidate === null || candidate.messageId === null ||
          candidate.text.replaceAll('\r\n', '\n') !== prompt.replaceAll('\r\n', '\n') ||
          messages.filter(message => message.role === 'user').at(-1) !== candidate) return null;
      const client = runtime.options.backendClient ??
        (runtime.options.backendClientProvider
          ? await runtime.options.backendClientProvider() : await runtime.pageBackendClient(context));
      const origin = runtime.options.backendOrigin ??
        (runtime.options.backendClient || runtime.options.backendClientProvider
          ? 'https://chatgpt.com' : url.origin);
      return await runtime.backend.recoverRenderedDispatchEvidence(
        context.providerConversationId, prompt, candidate.messageId, client, origin);
    } catch { return null; }
  }

export async function recoverExactChatGptTurn(runtime: ChatGptRecoveryRuntime, query: SemanticExactQuery): Promise<SemanticVerification> {
    const id = query.context;
    const rootAck = query.kind === 'ack' && id.providerConversationId === null;
    const conversationId = rootAck
      ? query.candidateConversationId ?? null : id.providerConversationId;
    if (conversationId === null || !/^[A-Za-z0-9_-]{1,160}$/.test(conversationId)) {
      return { kind: 'unavailable', reason: rootAck
        ? 'root-conversation-candidate-required' : 'exact-conversation-id-required' };
    }
    if (rootAck) {
      const root = query.rootPost;
      if (!query.prompt || !root || query.attempts !== undefined ||
          id.submittedUserMessageId !== null || id.submittedUserTurnId !== null ||
          root.textHash !== sha(query.prompt.replaceAll('\r\n', '\n')) ||
          (root.requestConversationId !== null &&
            root.requestConversationId !== conversationId)) {
        return { kind: 'unavailable', reason: 'exact-root-dispatch-correlation-required' };
      }
    } else if (query.kind === 'ack' && (!query.prompt || query.attempts?.length !== 1 ||
      query.attempts[0]!.conversationId !== conversationId)) {
      return { kind: 'unavailable', reason: 'exact-dispatch-correlation-required' };
    }
    if (!rootAck && query.kind === 'ack' &&
      query.attempts![0]!.textHash !== sha(query.prompt!.replaceAll('\r\n', '\n'))) {
      return { kind: 'unavailable', reason: 'canonical-ack-prompt-hash-mismatch' };
    }
    if (!rootAck && query.kind === 'ack' && id.submittedUserMessageId !== null &&
      id.submittedUserMessageId !== query.attempts![0]!.messageId) {
      return { kind: 'unavailable', reason: 'canonical-ack-bound-message-mismatch' };
    }
    if (query.kind === 'final' && !id.submittedUserTurnId) {
      return { kind: 'unavailable', reason: 'exact-submitted-user-turn-required' };
    }
    let client: BackendJsonClient;
    let origin: string;
    try {
      client = runtime.options.backendClient ??
        (runtime.options.backendClientProvider
          ? await runtime.options.backendClientProvider() : await runtime.pageBackendClient(id));
      origin = runtime.options.backendOrigin ??
        (runtime.options.backendClient || runtime.options.backendClientProvider ? 'https://chatgpt.com'
          : new URL((await runtime.exactPage(id)).page.url()).origin);
    } catch {
      return { kind: 'unavailable', reason: 'backend-transport-unavailable' };
    }
    if (query.kind === 'ack') {
      const root = rootAck ? query.rootPost! : null;
      const attempts = root === null ? query.attempts : [{
        conversationId,
        messageId: root.messageId,
        parentMessageId: root.parentMessageId,
        textHash: root.textHash,
        observedAt: root.observedAt,
      }];
      let latestReason: string | null = null;
      // Durable root POST evidence already carries the exact UUID and text hash.
      // Interactive selected-read priority is reserved for an explicit DOM choice;
      // otherwise root ACK recovery can starve an acknowledged turn's FINAL.
      const ack = await runtime.backend.recoverAcknowledgement(conversationId, query.prompt!,
        client, origin, attempts, evidence => { latestReason = evidence.reason; });
      if (ack !== null && id.submittedUserTurnId !== null &&
        ack.submittedUserTurnId !== id.submittedUserTurnId) {
        return { kind: 'unavailable', reason: 'canonical-ack-bound-turn-mismatch' };
      }
      if (ack === null) {
        if (root !== null) {
          const rendered = await recoverRenderedChatGptRootAck(runtime,
            id, conversationId, root, query.prompt!, latestReason);
          if (rendered !== null) return rendered;
        }
        return { kind: 'pending', reason: latestReason ?? 'canonical-ack-not-observed' };
      }
      if (root !== null) {
        if (ack.conversationId !== conversationId ||
            ack.submittedUserMessageId !== root.messageId ||
            ack.dispatchParent?.matches !== true) {
          return { kind: 'unavailable', reason: 'canonical-root-ack-identity-mismatch' };
        }
        return { kind: 'verified_root_ack', conversationId,
          externalTurnId: ack.submittedUserTurnId,
          messageId: ack.submittedUserMessageId };
      }
      return { kind: 'verified_ack', externalTurnId: ack.submittedUserTurnId,
        messageId: ack.submittedUserMessageId };
    }
    const final = await runtime.backend.recoverExactTurn({
      conversationId,
      submittedUserMessageId: id.submittedUserMessageId,
      submittedUserTurnId: id.submittedUserTurnId,
    }, client, origin, query.readPriority === 'due');
    if (final.kind === 'complete' && final.answerText !== null) {
      return {
        kind: 'exact_final',
        externalTurnId: id.submittedUserTurnId!,
        answerText: final.answerText,
      };
    }
    const renderedFinal = await recoverRenderedChatGptFinal(runtime,
      id, conversationId, final.reason);
    if (renderedFinal !== null) return renderedFinal;
    // A rate-limited canonical GET is deferred, not absent. Preserve its
    // nonterminal state and exact local read fence for both the first 429 and
    // a paced retry. The fence is scheduling evidence only; it never proves
    // no-FINAL and therefore never authorizes a continuation POST.
    const readFence = (final.reason === 'backend-http-429' ||
        final.reason === 'backend-conversation-probe-paced') &&
      final.nextCheckAt !== null ? { nextCheckAt: final.nextCheckAt } : {};
    return final.kind === 'pending' || final.kind === 'deferred'
      ? { kind: 'pending', reason: final.reason, ...readFence }
      : { kind: 'unavailable', reason: final.reason, ...readFence };
  }

export function rendererRecoveryReason(reason: string | null): boolean {
    return reason === 'backend-http-429' ||
      reason === 'backend-acknowledgement-probe-paced' ||
      reason === 'backend-acknowledgement-probe-queued' ||
      reason === 'backend-conversation-probe-paced';
  }

export async function recoverRenderedChatGptRootAck(runtime: ChatGptRecoveryRuntime,
    context: SemanticTaskContext,
    conversationId: string,
    root: SemanticRootPostEvidence,
    prompt: string,
    backendReason: string | null,
  ): Promise<SemanticVerification | null> {
    if (!rendererRecoveryReason(backendReason) ||
        root.textHash !== sha(prompt.replaceAll('\r\n', '\n'))) return null;
    let page: Page;
    try {
      if (context.pageLease !== null) {
        page = (await runtime.exactPage(context)).page;
      } else {
        const resolve = runtime.options.resolveRootRecoveryPage;
        if (!resolve) return null;
        const recovered = await resolve({ context, conversationId, root });
        if (recovered === null) return null;
        runtime.checkOrigin(recovered);
        page = recovered;
      }
    } catch { return null; }
    try {
      const url = new URL(page.url());
      if (url.pathname !== `/c/${encodeURIComponent(conversationId)}` ||
          url.search !== '' || url.hash !== '') return null;
      const dom = await observeChatGptDom(page, {
        submittedUserMessageId: root.messageId,
        submittedUserTurnId: root.messageId,
      });
      const exactUsers = dom.turnBoundary.filter(message =>
        message.role === 'user' && message.messageId === root.messageId &&
        message.turnId === root.messageId &&
        sha(message.text.replaceAll('\r\n', '\n')) === root.textHash);
      const assistant = dom.candidate;
      if (exactUsers.length !== 1 || !dom.submittedUserFound || dom.laterUserFound ||
          dom.actionableAlert || assistant === null || assistant.streamingMarker ||
          assistant.responseMessageId.startsWith('request-placeholder-') ||
          assistant.answerText.trim().length === 0) return null;
      return { kind: 'verified_root_ack', conversationId,
        externalTurnId: root.messageId, messageId: root.messageId };
    } catch { return null; }
  }

export async function recoverRenderedChatGptFinal(runtime: ChatGptRecoveryRuntime,
    context: SemanticTaskContext,
    conversationId: string,
    backendReason: string,
  ): Promise<SemanticVerification | null> {
    if (!rendererRecoveryReason(backendReason) || context.pageLease === null ||
        context.submittedUserMessageId === null ||
        context.submittedUserTurnId === null) return null;
    let exact: { lease: OwnedPageIdentity; page: Page };
    try { exact = await runtime.exactPage(context); } catch { return null; }
    try {
      const url = new URL(exact.page.url());
      if (url.pathname !== `/c/${encodeURIComponent(conversationId)}` ||
          url.search !== '' || url.hash !== '') return null;
      const dom = await observeChatGptDom(exact.page, {
        submittedUserMessageId: context.submittedUserMessageId,
        submittedUserTurnId: context.submittedUserTurnId,
      });
      const activity = await observeChatGptActivity(exact.page, dom);
      const dialog = await observeChatGptDialog(exact.page);
      const key = [exact.lease.pageKey, exact.lease.bindingEpoch, conversationId,
        context.submittedUserMessageId, context.submittedUserTurnId].join(':');
      let tracker = runtime.rendererFinalTrackers.get(key);
      if (!tracker) {
        if (runtime.rendererFinalTrackers.size >= 128) runtime.rendererFinalTrackers.clear();
        tracker = new ExactFinalTracker(runtime.rendererRecoveryQuietWindowMs);
        runtime.rendererFinalTrackers.set(key, tracker);
      }
      const decision = tracker.evaluate({
        provider: runtime.providerKey,
        pageKey: exact.lease.pageKey,
        bindingEpoch: exact.lease.bindingEpoch,
        observedAt: new Date().toISOString(),
        conversationId,
        submittedUserFound: dom.submittedUserFound,
        laterUserFound: dom.laterUserFound,
        candidate: dom.candidate,
        activity: activity.strength,
        dialogKind: dialog.kind,
        networkActivity: false,
        observationTransport: 'fresh',
        reason: dialog.reason ?? activity.reason,
      }, Date.now());
      if (decision.kind !== 'complete' || decision.answerText === null) return null;
      runtime.rendererFinalTrackers.delete(key);
      return { kind: 'exact_final', externalTurnId: context.submittedUserTurnId,
        answerText: decision.answerText };
    } catch { return null; }
  }
