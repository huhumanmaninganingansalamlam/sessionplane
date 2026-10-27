import type { ConversationLoadRecoveryRepository } from '../storage/conversation-load-recovery-repository.ts';
import { streamRetrySurface } from '../providers/chatgpt/stream-retry.ts';
import type { ReceiptRepository } from '../storage/receipt-repository.ts';
import { observeChatGptSurface, type ChatGptSurface } from '../providers/chatgpt/surface.ts';
import { controlHostSpanPermission, inspectHostSpanActivity, revealHostSpanActivity, type HostSpanPermissionInput } from '../providers/chatgpt/hostspan-permission.ts';
import { createHash } from 'node:crypto';
import { requireIdleConversationPage } from './conversation-cleanup-service.ts';
import { conversationLoadSurface } from '../providers/chatgpt/conversation-load-recovery.ts';
import { ChatGptConfigurationMenu, type ConfigurationCatalog } from '../providers/chatgpt/configuration-catalog.ts';
import { errors, type ElementHandle, type Page } from 'playwright-core';

import type { BrowserOwner } from '../browser/browser-owner.ts';
import type { PageBindingSnapshot } from '../browser/page-binding.ts';
import { PageRegistry, PageRegistryError } from '../browser/page-registry.ts';
import { BrowserRefSnapshotStore, BrowserSnapshotError, hasPreparationSelectionEvidence, isPreparationSummary, matchesPreparationTarget, sameSnapshotSemantics, type BrowserSnapshot, type BrowserSnapshotNode } from '../browser/ref-snapshot.ts';
import type { SessionSnapshot } from '../domain/session.ts';
import { SessionPlaneDomainError } from '../domain/errors.ts';
import { ProviderSubmissionError, type ProviderObservationEvidence, type PreparationPurpose, type PreparationTarget } from '../providers/provider-adapter.ts';
import { assertNoHumanVerification } from '../providers/human-verification.ts';
import { CHATGPT_PREPARATION_SNAPSHOT, CHATGPT_COMPOSER_SELECTOR } from '../providers/chatgpt/selectors.ts';
import { ChatGptSubmission, writeExactComposerValue, composerHasExactValue, inspectChatGptSubmissionCandidates, inspectChatGptPageReady, prepareChatGptObservation } from '../providers/chatgpt/submission.ts';
import { observeChatGptDialog } from '../providers/chatgpt/dialog-observer.ts';
import { ExactFinalTracker } from '../providers/chatgpt/exact-final.ts';
import { observeChatGptActivity } from '../providers/chatgpt/activity-observer.ts';
import { restoreLatestPosition } from '../providers/chatgpt/latest-position-recovery.ts';
import { readChatGptMessages } from '../providers/chatgpt/message-dom.ts';
import { observeChatGptDom, observeChatGptAlerts, isMessageTimeoutAlert } from '../providers/chatgpt/dom-observer.ts';
import type { SubmissionService, UserConfirmedInterruption } from './submission-service.ts';

export class SessionUiService {
  readonly #submissions: SubmissionService;
  readonly #registry: PageRegistry;
  readonly #browserOwner: BrowserOwner | null;
  readonly #chatgptOrigin: string;
  readonly #quietWindowMs: number;
  readonly #refs = new BrowserRefSnapshotStore();
  #catalog: ConfigurationCatalog | null = null;
  readonly #discoveryFailures = new Map<string, ConfigurationCatalog>();
  readonly #configurationRefs = new Map<string, { snapshotId: string; ids: readonly string[] }>();

  get configurationCatalog() { return this.#catalog; }

  async discover(input: PreparationOwner & { decisionId: string }) {
    const result = await this.#submissions.decidePreparation({ ...input, decision: 'discover', purpose: 'model' }, async session => {
      try {
        return { choice: null, result: await new ChatGptConfigurationMenu(await this.#interactionPage(session), session.pageKey!).discover() };
      } catch (error) {
        const result: ConfigurationCatalog = { status: 'unavailable', observedAt: new Date().toISOString(), options: [], unavailableVersions: [],
          message: error instanceof Error ? error.message : String(error) };
        return { choice: null, result };
      }
    });
    // A receipt replay restores the observation without repeating UI mutations.
    if ('options' in result) {
      const key = `${input.sessionId}:${input.generation}`;
      if (result.status === 'available') {
        this.#catalog = result;
        this.#discoveryFailures.delete(key);
      } else this.#discoveryFailures.set(key, result);
    }
    return result;
  }

  async configure(input: PreparationOwner & { decisionId: string; configurationId: string }) {
    return await this.#submissions.decidePreparation({ ...input, decision: 'configure', purpose: 'model' },
      session => this.#selectConfiguration(session, input.configurationId));
  }

  async #selectConfiguration(session: SessionSnapshot, configurationId: string) {
      const current = await this.#capture(session, 5_000);
      if (!current.nodes.some(node => node.role === 'textbox' && node.editable && !node.disabled)) {
        throw new SessionPlaneDomainError('provider.preparation-unavailable',
          'The exact page has no usable composer; configuration selection was not attempted');
      }
      const option = this.#catalog?.options.find(option => option.id === configurationId);
      if (!option) throw new SessionPlaneDomainError('provider.configuration-stale', 'Discover current configurations and choose an observed configurationId');
      try {
        const summary = await new ChatGptConfigurationMenu(await this.#interactionPage(session), session.pageKey!).select(option);
        return { choice: { ...toPreparationTarget('model', summary), configurationVersion: option.version },
          result: { configurationId: option.id, label: option.label } };
      } catch (error) {
        if (error instanceof SessionPlaneDomainError &&
            ['provider.configuration-stale', 'provider.model-unavailable'].includes(error.errorCode)) this.#catalog = null;
        throw typedUiError(error);
      }
  }

  constructor(input: { submissions: SubmissionService; registry: PageRegistry; chatgptUrl: string; quietWindowMs?: number; browserOwner?: BrowserOwner | null }) {
    this.#submissions = input.submissions;
    this.#registry = input.registry;
    this.#browserOwner = input.browserOwner ?? null;
    this.#chatgptOrigin = new URL(input.chatgptUrl).origin;
    this.#quietWindowMs = input.quietWindowMs ?? 1_500;
  }

  isSubmissionPageLost(session: SessionSnapshot): boolean {
    if (session.terminal || session.submissionState !== 'submission_unknown' || session.conversationId !== null) return false;
    if (session.pageKey === null) return true;
    try {
      this.#registry.requireSessionPage(session.pageKey, session);
      return false;
    } catch (error) {
      if (error instanceof PageRegistryError) return error.errorCode === 'browser.unavailable';
      throw error;
    }
  }

  async inspect(input: PreparationOwner & { readonly maxNodes?: number | undefined; readonly recoverBrowserFailure?: true }) {
    return await this.#submissions.withPendingPreparation(input,
      async (session) => {
        // A service deferral can precede openSubmission's same-session reservation.
        // withPendingPreparation holds the exact current request's actor/page locks.
        if (session.pageKey !== null) {
          let binding;
          try { binding = this.#registry.refreshPage(session.pageKey); }
          catch (error) { throw typedUiError(error); }
          if (binding.state === 'owned' && binding.sessionId === session.sessionId &&
              binding.generation !== null && binding.generation < session.generation) {
            this.#requirePage({ ...session, generation: binding.generation });
            this.#registry.reservePage(session.pageKey, session);
          }
        }
        await inspectChatGptPageReady(this.#requirePage(session), session.pageKey!);
        const snapshot = await this.#capture(session, input.maxNodes);
        const composerAvailable = snapshot.nodes.some(node => node.role === 'textbox' && node.editable && !node.disabled);
        if (session.submissionState === 'failed_pre_submit') {
          const page = this.#requirePage(session);
          const dom = await observeChatGptDom(page, session);
          const activity = await observeChatGptActivity(page, dom);
          if (!composerAvailable || activity.strength !== 'none' || dom.actionableAlert) {
            throw new SessionPlaneDomainError('provider.preparation-unavailable',
              'Preserve the failed request until its exact page has an idle usable composer');
          }
          this.#requirePage(session);
        }
        const catalog = this.#discoveryFailures.get(`${session.sessionId}:${session.generation}`) ?? this.#catalog;
        const menuIds = new Set(snapshot.nodes.filter((node) => node.role === 'menu' && node.id !== '').map((node) => node.id));
        this.#configurationRefs.set(snapshot.pageKey, { snapshotId: snapshot.snapshotId,
          ids: composerAvailable ? catalog?.options.map(option => option.id) ?? [] : [] });
        return { ...snapshot, nodes: snapshot.nodes.map((node) => ({ ...node, actions: preparationActions(node, menuIds) })),
          preparationAvailability: { available: composerAvailable,
            ...(composerAvailable ? {} : { reason: 'composer-unavailable' as const }) },
          configurationCatalog: catalog === null ? null : { ...catalog,
            selectionAvailable: composerAvailable,
            instruction: composerAvailable
              ? 'Select the desired combined label. Call sessionplane_decide with option.selection plus teamId, requestRef and a new requestId. No menu exploration is required.'
              : 'These cached model options are not selectable on this page. Read the same request again after the exact provider page has a usable composer; no configuration or submit action is available.',
            options: catalog.options.map((option, index) => ({ ...option,
              // DOM snapshots contain at most 5000 refs. Configuration refs use
              // the existing decision shape without pretending to be DOM nodes.
              ...(composerAvailable ? { selection: { decision: 'choose' as const, purpose: 'model' as const,
                snapshotId: snapshot.snapshotId, ref: `@e${5001 + index}` } } : {}) })) } };
      });
  }

  async inspectSubmission(input: PreparationOwner & { readonly maxNodes?: number | undefined; readonly readOnly?: boolean }) {
    return await this.#submissions.inspectSubmission(input,
      async (session, submittedMessageIds) => {
        if (input.readOnly && this.#submissions.isObservationHeld(session.conversationId) && session.conversationId !== null) {
          try { this.#registry.requireSessionPage(session.pageKey!, session); }
          catch (error) {
            if (!(error instanceof PageRegistryError) || error.errorCode !== 'browser.unavailable') throw typedUiError(error);
            const matches = this.#registry.findByConversation(session.conversationId);
            if (matches.length !== 1 || matches[0]!.state !== 'unbound') throw typedUiError(error);
            // Observe a reopened conversation without rebinding the original
            // request, adopting its messages or changing the human hold.
            session = { ...session, pageKey: matches[0]!.pageKey };
          }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const evidence = await Promise.race([
            (async () => {
              if (session.submissionState === 'submission_unknown' && session.conversationId === null && session.pageKey !== null) {
                const binding = this.#registry.refreshPage(session.pageKey);
                if (binding.conversationId !== null) {
                  const candidate = this.#registry.unknownConversationCandidate(session.pageKey, session);
                  if (new URL(candidate.page.url()).origin !== this.#chatgptOrigin) throw new SessionPlaneDomainError(
                    'session.page-identity-unverified', 'Recovery candidate left the ChatGPT origin');
                  const available = (await inspectChatGptSubmissionCandidates(candidate.page, binding.conversationId))
                    .filter(candidate => !submittedMessageIds.has(candidate.messageId));
                  // Multiple unclaimed users cannot identify this request's response.
                  // Observe the transcript once, only for an unambiguous candidate.
                  const response = available.length === 1 ? await observeChatGptDom(candidate.page, {
                    submittedUserMessageId: available[0]!.messageId, submittedUserTurnId: null,
                  }) : null;
                  const submissionCandidates = available.map(message => ({ ...message,
                    responseCandidate: response?.candidate == null ? null : {
                      ...response.candidate, submissionVerified: false as const,
                      scope: 'mounted-dom-unverified-submission' as const,
                      observedAt: response.messageDiagnostics.observedAt,
                    } }));
                  const snapshot = await this.#refs.capture({ pageKey: session.pageKey, bindingEpoch: binding.bindingEpoch,
                    page: candidate.page, ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: input.maxNodes ?? 1000 });
                  const observedSession = { ...session, conversationId: binding.conversationId };
                  const dom = await observeChatGptDom(candidate.page, observedSession);
                  const activity = await observeChatGptActivity(candidate.page, dom);
                  const providerAlerts = await observeChatGptAlerts(candidate.page, observedSession);
                  if (this.#registry.refreshPage(session.pageKey).bindingEpoch !== binding.bindingEpoch) throw new SessionPlaneDomainError(
                    'browser.snapshot-stale', 'Conversation recovery page changed during inspection');
                  return { ...snapshot, providerAlerts,
                    conversationRecovery: { conversationId: binding.conversationId, requiresExplicitAcknowledgement: true,
                      observedAt: dom.messageDiagnostics.observedAt, activity: activity.strength, activityReason: activity.reason },
                    submissionCandidates };
                }
              }
              const controls = await this.#capture(session, input.maxNodes, input.readOnly);
              const composers = this.#requirePage(session, input.readOnly).locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
              const composerCount = await composers.count();
              return {
              ...controls,
              submissionControls: { composerCount,
                enabledSubmitCount: controls.nodes.filter(node => node.submitControl && !node.disabled).length,
                draft: composerCount !== 1 ? null : await composers.first().evaluate(element => {
                  const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                    ? element.value : (element as HTMLElement).innerText;
                  return { text: text.slice(0, 200_000), textLength: text.length, truncated: text.length > 200_000 };
                }),
                continuationDraftPresent: composerCount === 1 && await composerHasExactValue(composers.first(), '계속') },
              providerAlerts: await observeChatGptAlerts(this.#requirePage(session, input.readOnly), session),
              ...(session.submissionState !== 'submitted' ? {} : {
                submissionVerification: await (async () => {
                  const dom = await observeChatGptDom(this.#requirePage(session, input.readOnly), session);
                  const activity = await observeChatGptActivity(this.#requirePage(session, input.readOnly), dom);
                  return {
                    observedAt: dom.messageDiagnostics.observedAt, pageKey: session.pageKey,
                    conversationId: session.conversationId,
                    submittedUserMessageId: session.submittedUserMessageId,
                    submittedUserTurnId: session.submittedUserTurnId,
                    anchorPresent: dom.submittedUserFound,
                    laterUserFound: dom.laterUserFound,
                    activity: activity.strength, activityReason: activity.reason,
                    messageTimeout: dom.providerAlerts.some(isMessageTimeoutAlert),
                    hostspanActivity: session.submittedUserMessageId === null ? null :
                      await inspectHostSpanActivity(this.#requirePage(session, input.readOnly), session.submittedUserMessageId, submittedMessageIds),
                    // Passive evidence is not a completed answer or permission to submit.
                    responseCandidate: dom.candidate,
                    turnBoundary: dom.turnBoundary,
                    // Preserve later human work without adopting it as this request's answer.
                    conversationContext: await (async () => {
                      const messages = await readChatGptMessages(this.#requirePage(session, input.readOnly));
                      const anchors = messages.filter(message => message.role === 'user' &&
                        ((session.submittedUserMessageId !== null && message.messageId === session.submittedUserMessageId) ||
                          (session.submittedUserTurnId !== null && message.turnId === session.submittedUserTurnId)));
                      const anchor = anchors.length === 1 ? anchors[0] : undefined;
                      // An owned conversation can virtualize its old ACK. Reading its
                      // mounted text does not verify that ACK or authorize replacement.
                      const following = anchors.length > 1 ? [] : anchor === undefined ? messages
                        : messages.slice(messages.indexOf(anchor)).filter(message => message.rootIndex === anchor.rootIndex);
                      let remaining = 200_000;
                      return { scope: anchor === undefined ? 'mounted-owned-conversation' as const : 'mounted-dom-from-original-ack' as const,
                        originalAnchorPresent: anchor !== undefined, originalAnchorAmbiguous: anchors.length > 1,
                        observedMessageCount: following.length,
                        truncated: following.length > 100 || following.reduce((size, message) => size + message.text.length, 0) > remaining,
                        messages: following.slice(0, 100).map(message => {
                          const text = message.text.slice(0, remaining);
                          remaining -= text.length;
                          return { ...message, text };
                        }) };
                    })(),
                    messageDiagnostics: dom.messageDiagnostics,
                    scope: 'mounted-dom' as const,
                  };
                })(),
              }),
              ...(session.submissionState !== 'submission_unknown' || session.conversationId === null ? {} : {
                submissionCandidates: await Promise.all((await inspectChatGptSubmissionCandidates(this.#requirePage(session, input.readOnly), session.conversationId))
                  .filter((candidate) => !submittedMessageIds.has(candidate.messageId)).map(async message => {
                    const dom = await observeChatGptDom(this.#requirePage(session, input.readOnly), {
                      submittedUserMessageId: message.messageId, submittedUserTurnId: null,
                    });
                    return { ...message, responseCandidate: dom.candidate === null ? null : {
                      ...dom.candidate, submissionVerified: false as const,
                      scope: 'mounted-dom-unverified-submission' as const,
                      observedAt: dom.messageDiagnostics.observedAt,
                    } };
                  })),
              }),
              };
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new BrowserSnapshotError('browser.snapshot-timeout',
                'The provider page did not respond to request inspection; submission and stop outcomes remain unchanged.')), 5_000);
            }),
          ]);
          if (!('conversationRecovery' in evidence)) this.#requirePage(session, input.readOnly);
          return evidence;
        } catch (error) { throw typedUiError(error); }
        finally { clearTimeout(timer); }
      });
  }

  async observeFollowup(input: PreparationOwner, followupUserMessageId?: string, review = false): Promise<(ProviderObservationEvidence & {
    followupUserMessageId: string; serverRecovery?: import('../providers/provider-adapter.ts').ProviderRecoveryResult }) | null> {
    const read = await this.#submissions.inspectSubmission({ ...input, followupInspection: true }, async (session, _submittedIds, owner, adapter) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([(async () => {
      const page = this.#requirePage(owner);
      const original = await observeChatGptDom(page, session);
      const nextUser = original.turnBoundary.find(message => message.role === 'user' &&
        message.messageId !== session.submittedUserMessageId);
      const followupId = followupUserMessageId ?? (nextUser?.text.trim() === '계속' ? nextUser.messageId : null);
      if (!followupId) return null;
      const transcript = followupUserMessageId === undefined ? original.turnBoundary : await readChatGptMessages(page);
      const anchor = transcript.findIndex(message => message.role === 'user' && message.messageId === session.submittedUserMessageId);
      const followups = transcript.filter(message => message.role === 'user' && message.messageId === followupId);
      if (!original.submittedUserFound || anchor < 0 || followups.length !== 1 ||
          followups[0]!.rootIndex !== transcript[anchor]!.rootIndex || transcript.indexOf(followups[0]!) <= anchor) {
        throw new SessionPlaneDomainError('session.page-identity-unverified', 'Follow-up is not after the exact original ACK on this transcript');
      }
      const dom = await observeChatGptDom(page, { submittedUserMessageId: followupId, submittedUserTurnId: null });
      const activity = await observeChatGptActivity(page, dom);
      const dialog = await observeChatGptDialog(page);
      const binding = this.#registry.refreshPage(session.pageKey!);
      const serverRecovery = review && dom.submittedUserFound && !dom.laterUserFound && activity.strength === 'none' && !dialog.kind
        ? await adapter.recover({ session: { ...session, submittedUserMessageId: followupId, submittedUserTurnId: followupId,
          answerText: null, responseMessageId: null }, generation: session.generation, bindingGeneration: owner.generation }) : undefined;
      return { followupUserMessageId: followupId, provider: 'chatgpt' as const, pageKey: session.pageKey!, bindingEpoch: binding.bindingEpoch,
        observedAt: new Date().toISOString(), conversationId: session.conversationId,
        submittedUserFound: dom.submittedUserFound, laterUserFound: dom.laterUserFound,
        candidate: dom.candidate, activity: activity.strength, dialogKind: dialog.kind, networkActivity: false,
        ...(serverRecovery ? { serverRecovery } : {}),
        observationTransport: 'fresh' as const, reason: dom.actionableAlert ? 'provider-actionable-alert' : activity.reason,
        ...(dom.actionableAlert ? { errorCode: 'provider.actionable-alert' } : {}) };
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SessionPlaneDomainError(
        'browser.snapshot-timeout', 'Follow-up observation delayed; preserve the original and later turn')), review ? 20000 : 5000); })]);
      } finally { clearTimeout(timer); }
    });
    if (read.evidence === undefined) throw new SessionPlaneDomainError('browser.unavailable', 'Original follow-up page is unavailable');
    return read.evidence;
  }

  async continueFollowup(input: PreparationOwner & { decisionId: string; originalRequestRef: string;
    followupUserMessageId: string; preparedGeneration: number; preparedPrompt: string; model: PreparationTarget;
    reviewedEmptyAt?: string; signal?: AbortSignal }, receipts: ReceiptRepository) {
    const read = await this.#submissions.inspectSubmission({ ...input, followupInspection: true }, async (original, _ids, owner) => {
      const key = `followup-continue:${input.originalRequestRef}:${input.followupUserMessageId}`;
      const method = 'session.followup-continue';
      const requestHash = createHash('sha256').update(JSON.stringify({ originalRequestRef: input.originalRequestRef,
        followupUserMessageId: input.followupUserMessageId, generation: input.preparedGeneration,
        promptHash: createHash('sha256').update(input.preparedPrompt).digest('hex') })).digest('hex');
      const receipt = { clientId: input.clientId, requestId: key, method, requestHash };
      const previous = receipts.get(input.clientId, key);
      if (previous && (previous.method !== method || previous.requestHash !== requestHash)) throw new SessionPlaneDomainError(
        'input.idempotency-conflict', 'The exact follow-up recovery belongs to a different prepared request');
      if (previous?.status === 'complete') return JSON.parse(previous.resultJson).outcome;
      if (owner.generation !== input.preparedGeneration || owner.generation !== original.generation + 1 ||
          owner.submissionState !== 'prepared' || owner.promptSubmitted || owner.submittedUserMessageId || owner.responseMessageId)
        throw new SessionPlaneDomainError('session.generation-superseded', 'Preserving follow-up recovery requires its never-submitted preparation');
      const page = this.#requirePage(owner);
      await inspectChatGptPageReady(page, owner.pageKey!);
      const composer = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
      if (await composer.count() !== 1 || !await composer.isEditable()) throw new SessionPlaneDomainError(
        'provider.preparation-required', 'No unique editable original composer');
      const verify = async () => {
        const transcript = await readChatGptMessages(page);
        const anchors = transcript.filter(m => m.role === 'user' && m.messageId === original.submittedUserMessageId);
        const followups = transcript.filter(m => m.role === 'user' && m.messageId === input.followupUserMessageId);
        if (anchors.length !== 1 || followups.length !== 1 || anchors[0]!.rootIndex !== followups[0]!.rootIndex ||
            transcript.indexOf(followups[0]!) <= transcript.indexOf(anchors[0]!) ||
            transcript.filter(m => m.role === 'user').at(-1)?.messageId !== input.followupUserMessageId)
          throw new SessionPlaneDomainError('session.page-identity-unverified', 'Recovery requires the exact latest follow-up after the original ACK');
        const dom = await observeChatGptDom(page, { submittedUserMessageId: input.followupUserMessageId, submittedUserTurnId: null });
        const activity = await observeChatGptActivity(page, dom);
        const disconnected = activity.reason === 'provider-stream-disconnected' && !dom.candidate?.streamingMarker;
        const timeout = dom.providerAlerts.length > 0 && dom.providerAlerts.every(isMessageTimeoutAlert);
        const reviewedEmpty = !!input.reviewedEmptyAt && Date.now() - Date.parse(input.reviewedEmptyAt) <= 180000 &&
          activity.strength === 'none' && dom.candidate === null && dom.providerAlerts.length === 0;
        const snapshot = await this.#capture(owner, 5000);
        if (!dom.submittedUserFound || dom.laterUserFound || dom.candidate?.terminalMarker || dom.candidate?.streamingMarker ||
            (!disconnected && activity.strength !== 'none') || (!disconnected && !timeout && !reviewedEmpty) ||
            dom.providerAlerts.some(a => !isMessageTimeoutAlert(a)) || snapshot.nodesTruncated ||
            snapshot.nodes.some(n => ['dialog', 'alertdialog'].includes(n.role) || n.role === 'button' &&
              /^(?:allow|always allow|allow once|deny|한 번만 허용|항상 허용|허용|거부)$/i.test(n.name.trim())) ||
            !hasPreparationSelectionEvidence(snapshot.nodes, input.model)) throw new SessionPlaneDomainError(
          'provider.preparation-required', 'Preserve active work, final answers, permissions and configuration; no exact interrupted follow-up');
        const submits = snapshot.nodes.filter(n => n.submitControl && !n.disabled);
        const composers = snapshot.nodes.filter(n => n.role === 'textbox' && n.editable && !n.disabled);
        if (submits.length !== 1 || composers.length !== 1) throw new SessionPlaneDomainError(
          'provider.preparation-required', 'The exact composer has no unique enabled send control');
        return { composers, submits, disconnected };
      };
      const ready = previous ? null : await verify();
      const state = previous ? JSON.parse(previous.resultJson).backup : {
        draft: await composer.evaluate(e => e instanceof HTMLTextAreaElement ? e.value : (e as HTMLElement).innerText),
        dispatched: false, acknowledgement: null, attempt: null,
      } as { draft: string; dispatched: boolean;
        acknowledgement: import('../providers/provider-adapter.ts').ProviderSubmissionAcknowledgement | null;
        attempt: import('../providers/provider-adapter.ts').ProviderSubmissionAttempt | null };
      if (!previous && !await composerHasExactValue(composer, input.preparedPrompt)) throw new SessionPlaneDomainError(
        'provider.preparation-required', 'The current draft differs from its retained prepared prompt; preserve it');
      if (!previous) await requireIdleConversationPage(page, state.draft, ready!.disconnected);
      const save = () => receipts.record({ ...receipt, status: 'attempted', result: { backup: state, decisionId: input.decisionId } });
      // The existing receipt retains the draft before the first editor mutation.
      // A lost response can restore it, but can never replay a possibly issued send.
      save();
      const submission = new ChatGptSubmission({ page, pageKey: owner.pageKey!, pageRegistry: this.#registry,
        acknowledgementTimeoutMs: 5000, request: { session: owner, generation: owner.generation,
          prompt: '계속', model: null, onSubmissionAttempt: attempt => { state.attempt = attempt; save(); } } });
      const abandon = () => submission.abandon();
      input.signal?.addEventListener('abort', abandon, { once: true });
      if (input.signal?.aborted) abandon();
      let error: SessionPlaneDomainError | undefined;
      let restored = false;
      try {
        if (!previous) {
          await submission.prepare({ model: input.model, composer: toPreparationTarget('composer', ready!.composers[0]!),
            submit: toPreparationTarget('submit', ready!.submits[0]!) });
          const current = await verify();
          await requireIdleConversationPage(page, '계속', current.disconnected);
          this.#requirePage(owner);
          if (input.signal?.aborted) throw new SessionPlaneDomainError('provider.preparation-required', 'Collector stopped; preserve the draft');
          state.dispatched = true; save();
          await submission.submitOnce();
          state.acknowledgement = await submission.captureAcknowledgement(); save();
        }
      } catch (failure) { error = typedUiError(failure); }
      finally {
        input.signal?.removeEventListener('abort', abandon);
        submission.abandon();
        this.#requirePage(owner);
        // Never overwrite a human edit made while the operation was in flight.
        if (await composerHasExactValue(composer, state.draft)) restored = true;
        else if (await composerHasExactValue(composer, '') || await composerHasExactValue(composer, '계속'))
          restored = await writeExactComposerValue(page, composer, state.draft, () => composer.elementHandle(), () => { this.#requirePage(owner); });
      }
      const acknowledged = state.acknowledgement;
      const outcome = { requestOk: restored && acknowledged !== null, requestRef: input.originalRequestRef,
        sessionId: owner.sessionId, generation: original.generation, terminal: false, promptSubmitted: state.dispatched,
        ...(acknowledged ? { followupUserMessageId: acknowledged.submittedUserMessageId } : {}),
        recoveredFromUserMessageId: input.followupUserMessageId, acknowledgement: acknowledged,
        ...(input.reviewedEmptyAt ? { reviewedEmptyAt: input.reviewedEmptyAt } : {}),
        draftPreservation: { requestGeneration: owner.generation, restored, characters: state.draft.length,
          sha256: createHash('sha256').update(state.draft).digest('hex') }, receiptId: key,
        errorCode: !restored ? 'provider.preparation-required' : !acknowledged ? state.dispatched
          ? 'session.submission-unknown' : error?.errorCode ?? 'provider.preparation-required' : null,
        reason: !restored ? 'preserved-draft-restoration-required' : acknowledged ? 'followup-continuation-acknowledged'
          : state.dispatched ? 'followup-continuation-acknowledgement-unverified' : error?.message ?? 'followup-continuation-not-dispatched' };
      receipts.record({ ...receipt, status: 'complete', result: { backup: state, outcome } });
      return outcome;
    });
    return read.evidence;
  }

  async retryStream(input: PreparationOwner & { decisionId: string }, receipts: ReceiptRepository, budgets: ConversationLoadRecoveryRepository) {
    const read = await this.#submissions.inspectSubmission(input, async session => {
      const unknown = session.submissionState === 'submission_unknown';
      if (session.terminal || (session.submissionState !== 'submitted' && !unknown) || !session.promptSubmitted ||
          (!unknown && !session.submittedUserMessageId) || !session.conversationId || session.answerText !== null || session.responseMessageId !== null)
        return null;
      if (!this.#registry.listBindings({ includeClosed: false }).some(binding => binding.pageKey === session.pageKey)) return null;
      const page = this.#requirePage(session);
      // Retry acts on the provider's existing conversation turn, not the uncertain
      // outgoing Continue. This observed identity must never become its ACK.
      const anchor = session.submittedUserMessageId ?? (unknown
        ? (await readChatGptMessages(page)).filter(message => message.role === 'user').at(-1)?.messageId : null);
      if (!anchor) return null;
      const target = { origin: this.#chatgptOrigin, conversationId: session.conversationId,
        anchor, click: false, preserveContinuationDraft: unknown };
      const surface = await page.evaluate(streamRetrySurface, target);
      if (!surface.present) return null;
      const dom = await observeChatGptDom(page, { submittedUserMessageId: anchor, submittedUserTurnId: null });
      const activity = await observeChatGptActivity(page, dom);
      // Exact enabled Retry chrome already rejects live Stop/thinking controls.
      // A weak generic label (including the Thinking model menu) is not a live stream.
      if (!dom.submittedUserFound || dom.laterUserFound || dom.candidate?.terminalMarker || dom.candidate?.streamingMarker ||
          activity.strength === 'strong' || activity.strength === 'unknown' ||
          surface.reason !== 'exact-stream-retry') throw new SessionPlaneDomainError('provider.preparation-required',
        `Preserve the original turn before stream Retry: ${surface.reason}`, {
          anchorPresent: dom.submittedUserFound, laterUserFound: dom.laterUserFound,
          responseCandidatePresent: dom.candidate !== null, observedUserMessageId: anchor, responseCandidate: dom.candidate,
          activity: activity.strength, activityReason: activity.reason,
        });
      await assertNoHumanVerification({ page, provider: 'chatgpt', pageKey: session.pageKey! });
      const requestId = `stream-retry:${session.sessionId}:${session.generation}`;
      const previous = receipts.get(input.clientId, requestId);
      if (previous !== null) throw new SessionPlaneDomainError('provider.action-unknown',
        'Stream Retry was already attempted for this request; inspect its result without repeating the click');
      const receipt = { clientId: input.clientId, requestId, method: 'session.stream-retry',
        requestHash: createHash('sha256').update(JSON.stringify(target)).digest('hex') };
      if (!budgets.reserveRefresh(new Date().toISOString(), 60_000, session.conversationId))
        throw new SessionPlaneDomainError('provider.preparation-required', 'Stream Retry is paced by the existing provider/UI cooldown; preserve this request');
      receipts.record({ ...receipt, status: 'attempted', result: { decisionId: input.decisionId, anchor: target.anchor } });
      this.#requirePage(session);
      const retried = await page.evaluate(streamRetrySurface, { ...target, click: true });
      receipts.record({ ...receipt, status: 'complete', result: { ...retried, anchor: target.anchor } });
      if (!retried.clicked) throw new SessionPlaneDomainError('provider.preparation-required',
        `Stream Retry was not dispatched: ${retried.reason}`);
      return { ...retried, observedUserMessageId: target.anchor,
        ...(unknown ? {} : { submittedUserMessageId: target.anchor }),
        requestAcknowledgementVerified: !unknown, generation: session.generation };
    });
    return read.evidence ?? null;
  }

  async prepareContinuation(input: PreparationOwner & { readonly decisionId: string; readonly userConfirmedInterruption?: UserConfirmedInterruption | undefined }) {
    return await this.#submissions.prepareContinuation(input, session => this.verifyContinuation(session, session, input.userConfirmedInterruption));
  }

  async verifyContinuation(session: SessionSnapshot, original: SessionSnapshot, confirmation?: UserConfirmedInterruption) {
      if (original.reason === 'message-timeout-reconciled') return await this.#failureEvidence(session, original, true, '계속');
      const page = this.#requirePage(session);
      const binding = this.#registry.refreshPage(session.pageKey!);
      const missing = this.#submissions.missingContinuationAnchor(original);
      const dom = await observeChatGptDom(page, original);
      const retained = missing && !dom.submittedUserFound ? await observeChatGptDom(page, missing) : null;
      const anchor = retained ?? dom;
      const activity = await observeChatGptActivity(page, anchor);
      // The submission owner verifies the exact successful server tool turn.
      // Disconnected provider chrome can retain Stop; streaming/thinking and
      // draft guards still apply, and no Stop gesture is issued.
      const disconnected = activity.reason === 'provider-stream-disconnected' && !anchor.candidate?.streamingMarker;
      const confirmedInterruption = confirmation !== undefined && confirmation.conversationId === original.conversationId &&
        confirmation.submittedUserMessageId === original.submittedUserMessageId &&
        ((activity.reason === 'provider-stream-disconnected' && !anchor.candidate?.streamingMarker && !anchor.candidate?.terminalMarker) ||
          (activity.strength === 'none' && anchor.candidate === null));
      if (confirmation && !confirmedInterruption) throw new SessionPlaneDomainError('provider.preparation-required',
        'User-confirmed interruption requires the exact nonstreaming disconnected page or idle original turn without a response');
      try { await requireIdleConversationPage(page, '계속', disconnected); }
      catch (error) {
        if (!(error instanceof SessionPlaneDomainError) || error.errorCode !== 'session.cleanup-not-ready') throw error;
        throw new SessionPlaneDomainError('provider.preparation-required',
          'Preserve the current draft, attachment or active generation before continuation');
      }
      const controls = await this.#capture(session);
      const resolvedAlert = confirmation?.resolvedToolAlert;
      let recoveredToolAlert = false;
      if (resolvedAlert && (resolvedAlert.originalOperationOutcome !== 'unknown' || resolvedAlert.readOnlyOperationInactive === true) &&
          confirmedInterruption && activity.strength === 'none' && anchor.candidate === null &&
          anchor.providerAlerts.length === 1 && retained === null) {
        const alert = anchor.providerAlerts[0]!;
        // An exact retained tool error may survive successful account recovery.
        // Explicit caller evidence is not a new grant or proof of tool success.
        const expected = `${resolvedAlert.appName} ${resolvedAlert.appName} 다시 연결 ${resolvedAlert.appName} 연결이 만료되었습니다. ChatGPT가 이 요청을 처리하는 데 사용할 수 있도록 먼저 다시 연결하세요.`;
        if (alert.replace(/\s+/g, ' ').trim() === expected &&
            createHash('sha256').update(alert).digest('hex') === resolvedAlert.alertSha256) {
          const work = await inspectHostSpanActivity(page, original.submittedUserMessageId!);
          const compact = (text: string) => text.replace(/\s+/g, '');
          const warning = compact(expected);
          recoveredToolAlert = work.available && !work.truncated && work.cards.length > 0 && work.cards.every(card =>
            card.association === 'current-work' && card.owningUserMessageId === original.submittedUserMessageId &&
            !card.textTruncated && (card.role === null || card.role === 'alert') &&
            [warning, warning + '나중에Esc다시연결⏎'].includes(compact(card.text)) &&
            card.controls.every(control => control.href === null &&
              /^(?:나중에(?:\s*Esc)?|다시 연결(?:\s*⏎)?)$/.test(control.name.trim())));
        }
      }
      if (resolvedAlert && !recoveredToolAlert) throw new SessionPlaneDomainError('provider.preparation-required',
        'The exact recovered tool expiration alert is no longer verified; preserve current alerts and work');
      const after = this.#registry.refreshPage(session.pageKey!);
      if (binding.bindingEpoch !== after.bindingEpoch || !anchor.conversationSurfaceAvailable ||
          !anchor.submittedUserFound || anchor.laterUserFound ||
          (!confirmedInterruption && anchor.candidate !== null && !(disconnected && !anchor.candidate.terminalMarker)) || (anchor.actionableAlert && !recoveredToolAlert) ||
          (!confirmedInterruption && !disconnected && activity.strength !== 'none') || controls.nodesTruncated ||
          controls.nodes.some(node => ['dialog', 'alertdialog'].includes(node.role)) ||
          !controls.nodes.some(node => node.role === 'textbox' && node.editable && !node.disabled)) {
        throw new SessionPlaneDomainError('provider.preparation-required',
          'Continuation requires the exact idle original turn with no answer, later user, alert or separate draft',
          !(binding.bindingEpoch === after.bindingEpoch && retained === null &&
            anchor.submittedUserFound && !anchor.laterUserFound && anchor.actionableAlert) ? undefined : { kind: 'provider-alert', source: 'dom',
            observedAt: anchor.messageDiagnostics.observedAt, pageKey: session.pageKey,
            conversationId: original.conversationId, submittedUserMessageId: original.submittedUserMessageId,
            providerAlerts: anchor.providerAlerts, actionVerified: false, requiredUserAction: null });
      }
      return { pageKey: session.pageKey!, conversationId: session.conversationId!, bindingEpoch: after.bindingEpoch,
        observedAt: controls.capturedAt, continuationPrompt: '계속',
        disconnectedRecovery: disconnected && !anchor.candidate?.terminalMarker,
        ...(recoveredToolAlert ? { recoveredToolAlert: { ...resolvedAlert, alertRetained: true, callerAttestedRecovery: true } } : {}),
        ...(retained ? { missingContinuationAcknowledgement: original.submittedUserMessageId,
          retainedPredecessorAcknowledgement: missing!.submittedUserMessageId } : {}),
        ...(confirmedInterruption ? { userConfirmedInterruption: confirmation,
          ...(dom.candidate ? { interruptedResponseMessageId: dom.candidate.responseMessageId,
            interruptedResponseSha256: createHash('sha256').update(dom.candidate.answerText).digest('hex') } : {}) } : {}) };
  }

  async verifyPreservingReplacement(session: SessionSnapshot) {
    if (session.provider !== 'chatgpt') throw new SessionPlaneDomainError(
      'capability.unsupported', 'Acknowledged preserving renewal requires supported exact-page verification');
    const page = this.#requirePage(session);
    const binding = this.#registry.refreshPage(session.pageKey!);
    await inspectChatGptPageReady(page, session.pageKey!);
    await requireIdleConversationPage(page);
    const dom = await observeChatGptDom(page, session);
    const activity = await observeChatGptActivity(page, dom);
    const controls = await this.#capture(session);
    const dialog = await observeChatGptDialog(page);
    if (!dom.submittedUserFound || dom.laterUserFound || !dom.conversationSurfaceAvailable ||
        activity.strength !== 'none' || dialog.kind || controls.nodesTruncated ||
        controls.nodes.some(n => ['dialog', 'alertdialog'].includes(n.role) ||
          (n.role === 'button' && /^(?:allow|always allow|allow once|deny|한 번만 허용|항상 허용|허용|거부)$/i.test(n.name.trim())))) {
      throw new SessionPlaneDomainError('session.preservation-not-ready',
        'Preserve active, ambiguous or permission-held work on its original conversation',
        { anchorPresent: dom.submittedUserFound, laterUserFound: dom.laterUserFound,
          activity: activity.strength, activityReason: activity.reason, dialog, providerMutation: false });
    }
    this.#requirePage(session);
    if (this.#registry.refreshPage(session.pageKey!).bindingEpoch !== binding.bindingEpoch) throw new SessionPlaneDomainError(
      'session.page-identity-unverified', 'Page changed during preserving replacement verification');
    return { pageKey: session.pageKey, conversationId: session.conversationId,
      submittedUserMessageId: session.submittedUserMessageId, bindingEpoch: binding.bindingEpoch,
      observedAt: controls.capturedAt, activity: activity.strength };
  }

  async reconcileFollowup(input: PreparationOwner & { readonly decisionId: string; readonly followupUserMessageId: string;
    readonly responseMessageId: string; readonly responseSha256: string; readonly followupCompleted: true; readonly answerText?: string }) {
    return await this.#submissions.reconcileFollowup(input, async (session, owner) => {
      const page = this.#requirePage(owner);
      const binding = this.#registry.refreshPage(session.pageKey!);
      const transcript = await readChatGptMessages(page);
      const originals = transcript.filter(m => m.role === 'user' && m.messageId === session.submittedUserMessageId);
      const followups = transcript.filter(m => m.role === 'user' && m.messageId === input.followupUserMessageId);
      const messages = transcript.filter(m => m.rootIndex === originals[0]?.rootIndex);
      const original = messages.findIndex(m => m.role === 'user' && m.messageId === session.submittedUserMessageId);
      const user = messages.findIndex(m => m.role === 'user' && m.messageId === input.followupUserMessageId);
      const answer = messages.at(-1);
      const recoveryTracking = owner.generation > session.generation && owner.promptSubmitted;
      const completedOriginal = session.terminal && session.reason === 'dom-quiet-stable-final' && session.errorCode === null &&
        session.responseMessageId !== null && session.answerText !== null;
      // The durable ancestry already proves these successors are literal Continue.
      // Retire only their tracking; preserve an unsent Continue draft unchanged.
      if (recoveryTracking) await requireIdleConversationPage(page, '계속');
      // An interrupted checkpoint is evidence to retain, not a completed answer to discard.
      const partials = messages.slice(original + 1, user);
      const controls = await this.#capture(owner);
      const dom = await observeChatGptDom(page, { submittedUserMessageId: input.followupUserMessageId, submittedUserTurnId: null });
      const activity = await observeChatGptActivity(page, dom);
      this.#requirePage(owner);
      const after = this.#registry.refreshPage(session.pageKey!);
      if (originals.length !== 1 || followups.length !== 1 || originals[0]?.rootIndex !== followups[0]?.rootIndex ||
          original < 0 || (recoveryTracking ? user < original : user <= original) || user >= messages.length - 1 || messages.slice(user + 1, -1).some(message => message.role !== 'assistant' || message.terminalMarker) || answer?.role !== 'assistant' ||
          answer.messageId !== input.responseMessageId || !answer.text.trim() || answer.streamingMarker ||
          createHash('sha256').update(answer.text).digest('hex') !== input.responseSha256 ||
          partials.some(m => completedOriginal ? !m.messageId
            : recoveryTracking && m.role === 'user' ? m.text.trim() !== '계속' : m.role !== 'assistant' || !m.messageId || m.terminalMarker) ||
          transcript.some(m => m.streamingMarker) || activity.strength !== 'none' || dom.actionableAlert ||
          !dom.conversationSurfaceAvailable || !dom.submittedUserFound || dom.laterUserFound ||
          dom.candidate?.responseMessageId !== input.responseMessageId || dom.candidate.streamingMarker ||
          createHash('sha256').update(dom.candidate.answerText).digest('hex') !== input.responseSha256 ||
          controls.nodesTruncated || controls.nodes.some(n => ['dialog', 'alertdialog'].includes(n.role)) ||
          !controls.nodes.some(n => n.role === 'textbox' && n.editable && !n.disabled) ||
          binding.bindingEpoch !== after.bindingEpoch) {
        throw new SessionPlaneDomainError('provider.failure-unverified',
          'Exact idle manual follow-up and unchanged answer are not verified; original tracking remains unchanged');
      }
      return { pageKey: session.pageKey!, conversationId: session.conversationId!,
        bindingEpoch: after.bindingEpoch, observedAt: controls.capturedAt,
        followupPartialResponses: messages.slice(user + 1, -1).map(m => ({ responseMessageId: m.messageId!,
          responseSha256: createHash('sha256').update(m.text).digest('hex') })),
        originalPartialResponses: partials.filter(m => m.role === 'assistant').map(m => ({ responseMessageId: m.messageId!,
          responseSha256: createHash('sha256').update(m.text).digest('hex') })) };
    });
  }

  async reconcileFailure(input: PreparationOwner & { readonly decisionId: string; readonly allowMessageTimeout?: boolean; readonly continuationPrompt?: '계속' | undefined }) {
    return await this.#submissions.reconcileFailure(input, (owner, anchor) => this.#failureEvidence(owner, anchor, input.allowMessageTimeout, input.continuationPrompt));
  }

  /** Exact-owner checks; explicit follow-up may focus its composer, never clear a draft or dispatch. */
  async verifyAuthorizedResend(current: SessionSnapshot, original: SessionSnapshot, prompt: string, allowPreparedDraft: boolean, followup?: true, userTranscriptHash?: string) {
    const page = this.#requirePage(current);
    await inspectChatGptPageReady(page, current.pageKey!);
    const binding = this.#registry.refreshPage(current.pageKey!);
    const dom = await observeChatGptDom(page, original);
    const activity = await observeChatGptActivity(page, dom);
    if (followup) {
      // This is a new user message, not proof that the UNKNOWN attempt failed.
      // Send-error notices are not access controls. The ordinary submission path
      // still verifies authentication, Chat selection and provider acceptance.
      const controls = await this.#capture(current);
      const dialog = await observeChatGptDialog(page);
      if (dialog.kind || controls.nodes.some(n => ['dialog', 'alertdialog'].includes(n.role) ||
          (n.role === 'button' && /^(?:allow|always allow|allow once|deny|한 번만 허용|항상 허용|허용|거부)$/i.test(n.name.trim())))) {
        throw new SessionPlaneDomainError('provider.preparation-required',
          'A current verification or permission control requires resolution before the explicit follow-up',
          { dialog, providerAlerts: dom.providerAlerts, providerMutation: false });
      }
      await requireIdleConversationPage(page, '계속');
    }
    const messages = await readChatGptMessages(page);
    const transcriptHash = createHash('sha256').update(JSON.stringify(messages.filter(m => m.role === 'user')
      .map(m => ({ messageId: m.messageId, turnId: m.turnId, text: m.text })))).digest('hex');
    if (followup && userTranscriptHash && transcriptHash !== userTranscriptHash) throw new SessionPlaneDomainError(
      'provider.preparation-required', 'The user transcript changed after follow-up preparation; inspect and collect the new turn without sending');
    const matchingPromptFound = messages.some(message => message.role === 'user' &&
      message.text.replaceAll('\r\n', '\n') === prompt.replaceAll('\r\n', '\n'));
    const state = await page.evaluate((composerSelector) => {
      const editors = [...document.querySelectorAll(composerSelector)]
        .map((element, index) => ({ element, index }))
        .filter(({ element }) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      const selection = window.getSelection();
      return { drafts: editors.map(({ element, index }) => ({ index,
        text: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
          ? element.value : (element as HTMLElement).innerText })), selection: selection?.isCollapsed === false,
        editorSelection: editors.some(({ element }) => element.contains(selection?.anchorNode ?? null) ||
          element.contains(selection?.focusNode ?? null)) };
    }, CHATGPT_COMPOSER_SELECTOR);
    // The same exact-text contract as preparation: ProseMirror innerText can
    // contain layout-only newlines absent from the authored paragraph text.
    // An approved unacknowledged attempt may still have its exact original prompt
    // in the composer. Keep it; a changed or unrelated draft still blocks recovery.
    const separateDraft = (await Promise.all(state.drafts.map(async draft => draft.text.trim() !== '' &&
      ((!followup && !allowPreparedDraft && current.generation === original.generation && original.submissionState !== 'submission_unknown') ||
        !await composerHasExactValue(page.locator(CHATGPT_COMPOSER_SELECTOR).nth(draft.index), prompt))))).some(Boolean);
    const blockingReasons = [
      dom.submittedUserFound && 'original-anchor', dom.candidate !== null && 'original-answer',
      activity.strength !== 'none' && 'provider-activity', !followup && dom.actionableAlert && 'provider-alert',
      !dom.conversationSurfaceAvailable && 'conversation-surface-unavailable', state.selection && 'user-selection',
      state.drafts.length !== 1 && 'composer-count', separateDraft && 'separate-draft',
      !followup && matchingPromptFound && 'matching-user-message',
    ].filter((reason): reason is string => typeof reason === 'string');
    if (followup && blockingReasons.length === 1 && blockingReasons[0] === 'user-selection' && !state.editorSelection) {
      // Normal preparation of the explicitly requested new input. Preserve an
      // editor selection/draft; never remove ranges or force a provider control.
      await page.locator(CHATGPT_COMPOSER_SELECTOR).nth(state.drafts[0]!.index).focus();
      if (await page.evaluate(() => window.getSelection()?.isCollapsed !== false)) blockingReasons.pop();
    }
    if (blockingReasons.length > 0) {
      throw new SessionPlaneDomainError('provider.preparation-required',
        `Approved resend paused: ${blockingReasons.join(', ')}; do not send`,
        { originalGeneration: original.generation, originalAnchorFound: dom.submittedUserFound,
          responseMessageId: dom.candidate?.responseMessageId ?? null, matchingPromptFound, activity: activity.strength,
          activityReason: activity.reason, actionableAlert: dom.actionableAlert,
          conversationSurfaceAvailable: dom.conversationSurfaceAvailable, selectionPresent: state.selection,
          composerCount: state.drafts.length, separateDraft, blockingReasons });
    }
    this.#requirePage(current);
    if (this.#registry.refreshPage(current.pageKey!).bindingEpoch !== binding.bindingEpoch) throw new SessionPlaneDomainError(
      'session.page-identity-unverified', 'Page changed during approved resend validation');
    return followup ? transcriptHash : undefined;
  }

  reserveResendPage(original: SessionSnapshot, successor: SessionSnapshot) {
    this.#requirePage(original);
    if (original.sessionId !== successor.sessionId || original.pageKey !== successor.pageKey ||
        original.conversationId !== successor.conversationId || successor.generation !== original.generation + 1) {
      throw new SessionPlaneDomainError('session.page-identity-unverified', 'Resend must retain the exact original session and page');
    }
    // Ordinary same-session generation ownership advance; no browser action.
    this.#registry.reservePage(original.pageKey!, { sessionId: original.sessionId,
      generation: successor.generation, conversationId: original.conversationId });
  }

  async #failureEvidence(session: SessionSnapshot, anchor: SessionSnapshot, allowMessageTimeout = false, continuationPrompt?: '계속') {
    const page = this.#requirePage(session);
    const binding = this.#registry.refreshPage(session.pageKey!);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const evidence = await Promise.race([
        (async () => {
          const controls = await this.#capture(session);
          const dom = await observeChatGptDom(page, anchor);
          const activity = await observeChatGptActivity(page, dom);
          if (allowMessageTimeout) {
            try { await requireIdleConversationPage(page, continuationPrompt); }
            catch { throw new SessionPlaneDomainError('provider.failure-unverified', 'Preserve the current draft, attachment or active generation; failure is unverified'); }
          }
          const thinkingAlerts = await observeChatGptAlerts(page, anchor, true);
          // Only an explicit owner reconciliation can close this exact idle stream
          // error. Automatic Thinking-failure recovery never accepts message timeouts.
          const timeoutAlerts = allowMessageTimeout ? dom.providerAlerts.filter(isMessageTimeoutAlert) : [];
          const knownUsers = this.#submissions.submittedMessageIds(anchor.sessionId);
          const missingTimeoutAnchor = timeoutAlerts.length > 0 && !dom.submittedUserFound &&
            !dom.messageDiagnostics.parsedMessagesTruncated &&
            dom.messageDiagnostics.parsedMessages.filter(message => message.role === 'user')
              .every(message => message.messageId !== null && knownUsers.has(message.messageId));
          const alerts = [...thinkingAlerts, ...timeoutAlerts];
          if (continuationPrompt !== undefined && timeoutAlerts.length === 0) throw new SessionPlaneDomainError(
            'provider.failure-unverified', 'A preserved continuation draft requires the exact idle message-timeout surface');
          this.#requirePage(session);
          const after = this.#registry.refreshPage(session.pageKey!);
          if (binding.bindingEpoch !== after.bindingEpoch || (!dom.submittedUserFound && !missingTimeoutAnchor) || dom.laterUserFound ||
              (dom.candidate !== null && (timeoutAlerts.length === 0 || dom.candidate.streamingMarker)) || activity.strength !== 'none' || alerts.length === 0 ||
              dom.providerAlerts.some(alert => !alerts.includes(alert)) ||
              controls.nodes.some(node => node.role === 'dialog' || node.role === 'alertdialog') ||
              !controls.nodes.some(node => node.role === 'textbox' && node.editable && !node.disabled)) {
            throw new SessionPlaneDomainError('provider.failure-unverified',
              'No exact idle current-turn Thinking failed or explicitly accepted message-timeout surface; preserve this submitted request and observe it');
          }
          return { kind: timeoutAlerts.length > 0 ? 'message-timeout' as const : 'thinking-failed' as const, pageKey: session.pageKey!, bindingEpoch: after.bindingEpoch,
            conversationId: session.conversationId!, anchorPresent: dom.submittedUserFound, submittedUserMessageId: anchor.submittedUserMessageId,
            submittedUserTurnId: anchor.submittedUserTurnId, observedAt: controls.capturedAt, providerAlerts: alerts,
            ...(dom.candidate === null ? {} : { interruptedResponse: dom.candidate }),
            ...(continuationPrompt === undefined ? {} : { continuationPrompt }) };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SessionPlaneDomainError('provider.failure-unverified',
            'Failure inspection timed out; this submitted request remains unchanged')), 5_000);
        }),
      ]);
      return evidence;
    } finally { clearTimeout(timer); }
  }

  async verifyFailureContinuation(session: SessionSnapshot, failed: SessionSnapshot, model: PreparationTarget) {
    await this.#failureEvidence(session, failed);
    if (model.configurationVerification) {
      const proof = model.configurationVerification;
      const verified = await new ChatGptConfigurationMenu(this.#requirePage(session), session.pageKey!)
        .reobserveSelection(proof.version, proof.effort, true);
      if (verified.configurationVerification?.version !== proof.version ||
          verified.configurationVerification.effort !== proof.effort ||
          verified.configurationVerification.surface !== proof.surface) throw new SessionPlaneDomainError(
        'provider.failure-unverified', 'Current verified model, effort or Chat mode changed');
      this.#requirePage(session);
      model = { ...toPreparationTarget('model', verified), configurationVersion: proof.version,
        configurationVerification: verified.configurationVerification };
    }
    const snapshot = await this.#capture(session, 5_000);
    const composers = snapshot.nodes.filter(node => node.role === 'textbox' && node.editable && !node.disabled);
    const combinedSummary = model.configurationVerification !== undefined ||
      (model.role === 'menuitem' && model.name.trim() !== '' &&
        model.text.trim() !== '' && model.text.trim() !== model.name.trim());
    if (!combinedSummary || snapshot.nodesTruncated || composers.length !== 1 || !hasPreparationSelectionEvidence(snapshot.nodes, model)) {
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Exact configured model/effort or sole composer is unavailable');
    }
    const element = await this.#refs.resolve({ pageKey: session.pageKey!, bindingEpoch: snapshot.bindingEpoch,
      page: this.#requirePage(session), snapshotId: snapshot.snapshotId, ref: composers[0]!.ref });
    try {
      const draft = await element.evaluate(node => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.value : node.textContent ?? '');
      if (draft.trim() !== '' && (session.generation === failed.generation || draft !== '계속')) throw new SessionPlaneDomainError(
        'provider.failure-unverified', 'A separate composer draft is present; automatic continuation is paused');
    } finally { await element.dispose(); }
  }

  async prepareFailureContinuation(input: PreparationOwner, model: PreparationTarget, intended?: { model?: string; effort?: string }) {
    // These are ordinary durable preparation choices; provider mutation stays in resumePreparation.
    const inspected = await this.inspect(input);
    const preparationId = inspected.snapshotId;
    for (const purpose of ['model', 'composer'] as const) {
      await this.#submissions.decidePreparation({ ...input, decisionId: `thinking-failure-${purpose}:${input.requestId}:${preparationId}`,
        decision: 'configure', purpose }, async session => {
        let snapshot = await this.#capture(session, 5_000);
        const version = model.configurationVersion ?? intended?.model;
        const effort = intended?.effort ?? model.configurationVerification?.effort;
        if (purpose === 'model' && !snapshot.nodesTruncated &&
            (model.configurationVersion !== undefined || !hasPreparationSelectionEvidence(snapshot.nodes, model)) &&
            version && effort) {
          const summary = await new ChatGptConfigurationMenu(this.#requirePage(session), session.pageKey!)
            .reobserveSelection(version, effort, model.configurationVerification !== undefined);
          if (model.configurationVerification && !summary.configurationVerification) throw new SessionPlaneDomainError(
            'provider.failure-unverified', 'Current full selection verification is unavailable');
          model = { ...toPreparationTarget('model', summary),
            ...(summary.configurationVerification ? { configurationVerification: summary.configurationVerification } : {}),
            ...(model.configurationVersion === undefined ? {} : { configurationVersion: model.configurationVersion }) };
          snapshot = await this.#capture(session, 5_000);
        }
        if (snapshot.nodesTruncated || !hasPreparationSelectionEvidence(snapshot.nodes, model)) throw new SessionPlaneDomainError(
          'provider.failure-unverified', 'Fresh configured model/version/effort evidence is missing');
        const composers = snapshot.nodes.filter(node => node.role === 'textbox' && node.editable && !node.disabled);
        if (composers.length !== 1) throw new SessionPlaneDomainError('provider.failure-unverified', 'No unique usable composer');
        return { choice: purpose === 'model' ? { ...model, purpose } : toPreparationTarget(purpose, composers[0]!), result: { purpose } };
      });
    }
    try {
      const result = await this.#submissions.resumePreparation(input);
      if (result.submissionState === 'submitted') return result;
      if (result.submissionState !== 'prepared') throw new SessionPlaneDomainError(
        result.errorCode ?? 'provider.failure-unverified', 'Continuation is not confirmed; inspect the saved request without resending');
    } catch (error) {
      if (!(error instanceof SessionPlaneDomainError) || error.errorCode !== 'provider.preparation-required') throw error;
    }
    await this.#submissions.decidePreparation<Readonly<Record<string, unknown>>>({ ...input, decisionId: `thinking-failure-submit:${input.requestId}:${preparationId}`,
      decision: 'configure', purpose: 'submit' }, async session => {
      const snapshot = await this.#capture(session, 5_000);
      const submits = snapshot.nodes.filter(node => node.submitControl === true && !node.disabled);
      if (snapshot.nodesTruncated || !hasPreparationSelectionEvidence(snapshot.nodes, model)) throw new SessionPlaneDomainError(
        'provider.failure-unverified', 'Fresh configuration evidence is missing');
      if (submits.length === 1) return { choice: toPreparationTarget('submit', submits[0]!), result: { purpose: 'submit' } };
      const continuation = this.#submissions.continuationContext(input);
      if (submits.length === 0 && continuation) {
        const { original, confirmation } = continuation;
        const evidence = await this.verifyContinuation(session, original, confirmation);
        const composers = snapshot.nodes.filter(node => node.role === 'textbox' && node.editable && !node.disabled);
        // Disconnection/Stop does not advertise a working keyboard submit.
        // Retain this explicit gesture only for the exact user-confirmed turn.
        if (confirmation && 'userConfirmedInterruption' in evidence && composers.length === 1) return { choice: { ...toPreparationTarget('submit', composers[0]!), submitGesture: 'enter' as const },
          result: { purpose: 'submit', gesture: 'enter', userConfirmedInterruption: confirmation } };
        throw new SessionPlaneDomainError('provider.submit-unavailable',
          'The prepared continuation has no enabled Send control. Preserve its draft and inspect the same request when the original page can submit; do not infer Enter support from disconnection or Stop.');
      }
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Unique enabled submit evidence is missing');
    });
    const result = await this.#submissions.resumePreparation(input);
    if (result.submissionState !== 'submitted') throw new SessionPlaneDomainError(
      result.errorCode ?? 'provider.failure-unverified', 'Continuation is not confirmed; inspect the saved request without resending');
    return result;
  }

  async inspectSurface(session: SessionSnapshot, readOnly = false): Promise<ChatGptSurface> {
    try {
      if (session.provider !== 'chatgpt') throw new Error('Not ChatGPT');
      const page = this.#requirePage(session, readOnly);
      const observed = await observeChatGptSurface(page);
      this.#requirePage(session, readOnly);
      return observed;
    } catch {
      return { mode: 'unknown', source: 'unavailable', observedAt: new Date().toISOString() };
    }
  }

  async #capture(session: SessionSnapshot, maxNodes?: number, readOnly = false) {
    const page = this.#requirePage(session, readOnly);
    const binding = this.#registry.refreshPage(session.pageKey!);
    try {
      return { ...await this.#refs.capture({
        pageKey: session.pageKey!, bindingEpoch: binding.bindingEpoch, page,
        ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: Math.max(1, Math.min(5_000, maxNodes ?? 1_000)),
      }), observedSurface: await this.inspectSurface(session, readOnly) };
    } catch (error) {
      throw typedUiError(error);
    }
  }

  async decide(input: PreparationOwner & {
    readonly decisionId: string;
    readonly decision: 'choose' | 'reveal' | 'cancel';
    readonly purpose?: PreparationPurpose;
    readonly snapshotId?: string;
    readonly ref?: string;
    readonly value?: number | undefined;
  }) {
      return await this.#submissions.decidePreparation<(BrowserSnapshot & {
        configurationVerification?: PreparationTarget['configurationVerification'];
      }) | { configurationId: string; label: string }>(input, async (session, requested) => {
      const purpose = input.purpose;
      const snapshotId = input.snapshotId;
      const ref = input.ref;
      if (purpose === undefined || snapshotId === undefined || ref === undefined || session.pageKey === null) {
        throw new SessionPlaneDomainError('input.invalid', 'A choice needs purpose, snapshotId, and ref');
      }
      if (Number(ref.slice(2)) > 5000) {
        const catalog = this.#configurationRefs.get(session.pageKey);
        const configurationId = catalog?.ids[Number(ref.slice(2)) - 5001];
        if (catalog?.snapshotId !== snapshotId || configurationId === undefined) {
          throw new BrowserSnapshotError('browser.snapshot-stale', 'Inspect the current configuration catalog before choosing');
        }
        if (input.decision !== 'choose' || purpose !== 'model' || input.value !== undefined) {
          throw new SessionPlaneDomainError('input.invalid', 'Use the configuration option selection exactly as returned');
        }
        return await this.#selectConfiguration(session, configurationId);
      }
      const page = await this.#interactionPage(session);
      const binding = this.#registry.refreshPage(session.pageKey);
      let element: ElementHandle<Element> | null = null;
      try {
        const node = this.#refs.node({ pageKey: session.pageKey, snapshotId, ref });
        element = await this.#refs.resolve({ pageKey: session.pageKey, bindingEpoch: binding.bindingEpoch, page, ref, snapshotId });
        const reveal = input.decision === 'reveal';
        const currentObservation = await this.#refs.capture({
          pageKey: session.pageKey, bindingEpoch: this.#registry.refreshPage(session.pageKey).bindingEpoch,
          page, ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: 5_000,
        });
        const currentNode = await this.#refs.nodeForElement({
          pageKey: session.pageKey, snapshotId: currentObservation.snapshotId, element,
        });
        if (!sameSnapshotSemantics(node, currentNode)) {
          throw new BrowserSnapshotError('browser.snapshot-stale', 'Selected control changed since it was inspected');
        }
        const menuIds = new Set(currentObservation.nodes.filter((node) => node.role === 'menu' && node.id !== '').map((node) => node.id));
        const actions = preparationActions(currentNode, menuIds);
        if (!actions[reveal ? 'reveal' : 'choose'].includes(purpose)) {
          throw new SessionPlaneDomainError('input.invalid', `The observed control does not support ${input.decision} for ${purpose}`);
        }
        if (input.value !== undefined && currentNode.role !== 'slider') {
          throw new SessionPlaneDomainError('input.invalid', 'A numeric value is only valid for a model or effort slider');
        }
        const existingSelection = !reveal && ['model', 'effort'].includes(purpose) &&
          ((currentNode.role === 'button' && currentNode.hasPopup !== null) ||
            isPreparationSummary(currentNode, currentNode.ancestorIds.some(id => menuIds.has(id))) ||
            currentNode.checked === true || currentNode.selected === true);
        if (existingSelection && requested.model && requested.effort) {
          if (requested.surface && !['chat', 'normal'].includes(requested.surface.trim().toLowerCase())) {
            throw new SessionPlaneDomainError('capability.unsupported', 'Existing-selection verification supports Chat only');
          }
          const verified = await new ChatGptConfigurationMenu(page, session.pageKey)
            .reobserveSelection(requested.model, requested.effort, true);
          this.#requirePage(session);
          const after = await this.#capture(session, 5_000);
          const choice = { ...toPreparationTarget(purpose, verified),
            configurationVersion: verified.configurationVerification!.version,
            configurationVerification: verified.configurationVerification! };
          if (after.nodesTruncated || !hasPreparationSelectionEvidence(after.nodes, choice)) throw new SessionPlaneDomainError(
            'provider.configuration-stale', 'Verified selection no longer matches the current chooser');
          return { choice, result: { ...after, configurationVerification: choice.configurationVerification } };
        }
        let actionTimeout: Error | undefined;
        try {
          if (reveal && ['button', 'menuitem'].includes(currentNode.role)) {
            await element.evaluate((target) => {
              if ((target instanceof HTMLButtonElement && target.type === 'submit') ||
                  (target instanceof HTMLInputElement && target.type === 'submit') ||
                  target.getAttribute('aria-disabled') === 'true' || ('disabled' in target && Boolean(target.disabled))) {
                throw new Error('Only an enabled non-submit chooser can reveal choices');
              }
            });
            await element.click({ timeout: 5_000 });
          }
          if ((purpose === 'model' || purpose === 'effort') && !['slider', 'button', 'menuitem'].includes(currentNode.role) && currentNode.selected !== true && currentNode.checked !== true) {
            if (input.value !== undefined) throw new SessionPlaneDomainError('input.invalid', 'A value is only valid when choosing a slider value');
            await element.click({ timeout: 5_000 });
          }
          if (currentNode.role === 'slider') {
            const value = input.value;
            if (!['model', 'effort'].includes(purpose) || value === undefined || !Number.isFinite(value) || currentNode.ariaValueMin === null || currentNode.ariaValueMax === null || value < Number(currentNode.ariaValueMin) || value > Number(currentNode.ariaValueMax)) {
              throw new SessionPlaneDomainError('input.invalid', 'A model or effort slider choice needs an explicit value within its observed range');
            }
            const adjustment = await element.evaluate((target, { requested, min, max, current }) => {
              const nativeRange = target instanceof HTMLInputElement && target.type === 'range';
              const step = nativeRange ? (target.step === '' ? 1 : Number(target.step)) : 1;
              const count = (requested - current) / step;
              if (!Number.isFinite(step) || step <= 0 || requested < min || requested > max ||
                  !Number.isFinite(current) || Math.abs(count - Math.round(count)) > 1e-7 || Math.abs(count) > 1_000) return null;
              return { key: count < 0 ? 'ArrowLeft' as const : 'ArrowRight' as const, count: Math.abs(count) };
            }, { requested: value, min: Number(currentNode.ariaValueMin), max: Number(currentNode.ariaValueMax),
              current: Number(currentNode.ariaValueNow ?? currentNode.value ?? NaN) });
            if (adjustment === null) throw new SessionPlaneDomainError('input.invalid', 'Slider value must match a supported native range step');
            await element.focus();
            for (let step = 0; step < adjustment.count; step += 1) await element.press(adjustment.key);
          }
        } catch (error) {
          if (!(error instanceof errors.TimeoutError)) throw error;
          actionTimeout = error;
        }
        let after: BrowserSnapshot;
        const target = toPreparationTarget(purpose, currentNode, input.value);
        const evidenceDeadline = performance.now() + 5_000;
        // Mutate once; wait for observable UI evidence rather than an animation delay.
        while (true) {
          after = await this.#refs.capture({
            pageKey: session.pageKey, bindingEpoch: this.#registry.refreshPage(session.pageKey).bindingEpoch,
            page, ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: 5_000,
          });
          if (purpose !== 'model' && purpose !== 'effort') break;
          const transitioned = ['menuitemradio', 'option', 'radio'].includes(currentNode.role) &&
            !after.nodes.some((node) => matchesPreparationTarget(node, target)) &&
            hasRevealedChoices(after.nodes, currentNode, currentObservation.nodes);
          const verified = reveal && ['button', 'menuitem'].includes(currentNode.role)
            ? hasNavigationEvidence(after.nodes, currentNode, currentObservation.nodes)
            : hasPreparationSelectionEvidence(after.nodes, target) || transitioned;
          if (verified) break;
          if (performance.now() >= evidenceDeadline) {
            throw actionTimeout ?? new SessionPlaneDomainError('provider.action-unknown', 'The chosen control did not show a verified selection or related choice list');
          }
          await page.waitForTimeout(100);
        }
        let choice = reveal ? null : target;
        if (currentNode.role === 'slider') {
          const openers = after.nodes.filter((node) => node.role === 'button' && node.expanded === true &&
            node.controls.some((id) => currentNode.ancestorIds.includes(id)));
          if (openers.length === 1 && after.nodes.some((node) => node.role === 'menu' && currentNode.ancestorIds.includes(node.id))) {
            await element.press('Escape');
            after = await this.#refs.capture({ pageKey: session.pageKey, bindingEpoch: binding.bindingEpoch, page, ...CHATGPT_PREPARATION_SNAPSHOT, maxNodes: 5_000 });
            const summary = after.nodes.find((node) => node.id === openers[0]!.id && node.role === 'button' && node.expanded === false);
            if (!reveal && summary !== undefined && summary.id !== '') choice = toPreparationTarget(purpose, summary);
          }
        }
        return { choice, result: after };
      } catch (error) {
        throw typedUiError(error);
      } finally {
        await element?.dispose();
      }
    });
  }

  /** Caller holds the exact current request actor and page mutation lock. */
  async hostspanPermission(session: SessionSnapshot, input: HostSpanPermissionInput, original = session,
    passiveInspection = false, workOriginal?: SessionSnapshot,
    exactFollowup?: { sourceUserMessageId: string; userMessageId: string }, retainedAcknowledgements: ReadonlySet<string> = new Set()) {
    if (session.provider !== 'chatgpt' ||
        (original.submissionState !== 'submitted' && original.submissionState !== 'submission_unknown') ||
        original.sessionId !== session.sessionId || original.conversationId !== session.conversationId ||
        !session.conversationId) throw new SessionPlaneDomainError(
      'provider.permission-unverified', 'Recover the original ACK before controlling its tool permission');
    if (input.action !== 'inspect' && session.terminal) throw new SessionPlaneDomainError(
      'provider.permission-unverified', 'A completed turn permits inspection only, not permission control');
    if (passiveInspection && input.action === 'inspect' && original.generation < session.generation && original.terminal) {
      const page = this.#requirePage(session, true);
      const users = (await readChatGptMessages(page)).filter(message => message.role === 'user');
      const anchors = users.filter(message => message.messageId === original.submittedUserMessageId &&
        (original.submittedUserTurnId === null || message.turnId === original.submittedUserTurnId));
      if (anchors.length !== 1) throw new SessionPlaneDomainError(
        'provider.permission-unverified', 'The completed original ACK is not uniquely mounted');
      // Later work owns the controls. Reading its predecessor must neither reveal nor grant an old card.
      return { outcome: 'not-current', appName: input.appName,
        originalUserMessageId: anchors[0]!.messageId, currentUserMessageId: users.at(-1)?.messageId ?? null,
        requestAcknowledgementVerified: true, permissionControlAvailable: false,
        reason: 'completed-original-has-successor', providerMutation: false };
    }
    try {
      const page = await this.#interactionPage(session);
      await assertNoHumanVerification({ page, provider: 'chatgpt', pageKey: session.pageKey! });
      const messages = (await readChatGptMessages(page)).filter(message => message.role === 'user');
      // A visible exact grant belongs to this owned conversation independently of
      // an uncertain outgoing message. Never turn controlling that grant into ACK.
      let anchor = original.submittedUserMessageId ??
        (original.submissionState === 'submission_unknown' ? messages.at(-1)?.messageId : null);
      const acknowledgementVerified = original.submissionState === 'submitted' &&
        messages.filter(message => message.messageId === original.submittedUserMessageId).length === 1;
      let association;
      if (exactFollowup) {
        const roots = messages.filter(m => m.messageId === original.submittedUserMessageId);
        const sources = messages.filter(m => m.messageId === exactFollowup.sourceUserMessageId);
        const current = messages.filter(m => m.messageId === exactFollowup.userMessageId);
        const source = sources[0], last = current[0], root = roots[0];
        if (roots.length !== 1 || sources.length !== 1 || current.length !== 1 || !root || !source || !last ||
            root.rootIndex !== source.rootIndex || source.rootIndex !== last.rootIndex ||
            messages.indexOf(source) <= messages.indexOf(root) || messages.indexOf(last) < messages.indexOf(source) ||
            messages.at(-1) !== last || messages.slice(messages.indexOf(source) + 1).some(m => m.text.trim() !== '계속'))
          throw new SessionPlaneDomainError('provider.permission-unverified', 'Verify the original, source follow-up and acknowledged latest recovery on the same transcript');
        anchor = last.messageId;
        association = { association: 'acknowledged-exact-followup-chain', originalUserMessageId: root.messageId,
          sourceFollowupUserMessageId: source.messageId, currentUserMessageId: last.messageId, followupAcknowledgementVerified: true };
      }
      if (!anchor || messages.at(-1)?.messageId !== anchor) {
        // A recovery Continue's missing ACK must not hide a card belonging to
        // its exact retained work. This associates controls, never rewrites ACKs.
        const roots = workOriginal && messages.filter(message => message.messageId === workOriginal.submittedUserMessageId);
        const root = roots?.length === 1 ? roots[0] : undefined;
        const following = root && messages.slice(messages.indexOf(root) + 1);
        const currentAnchor = messages.at(-1)?.messageId;
        if (!root || !following?.length || following.some(message =>
            message.rootIndex !== root.rootIndex || message.text.trim() !== '계속') ||
            messages.filter(message => message.messageId === original.submittedUserMessageId).length > 1 ||
            !currentAnchor) throw new SessionPlaneDomainError(
          'provider.permission-unverified', 'The original user anchor must be the current turn or a verified same-work continuation');
        anchor = currentAnchor;
        association = { association: 'exact-original-question-and-literal-continuations',
          workUserMessageId: root.messageId, currentUserMessageId: anchor, workAcknowledgementVerified: true };
      }
      if (input.action === 'inspect' && input.toolName === undefined && input.evidenceHash !== undefined) {
        if (!acknowledgementVerified) throw new SessionPlaneDomainError('provider.permission-unverified', 'Recover the current ACK before revealing its retained activity');
        const result = await revealHostSpanActivity(page, anchor, retainedAcknowledgements, input.appName, input.evidenceHash);
        this.#requirePage(session);
        return { ...result, requestAcknowledgementVerified: true };
      }
      const result = await controlHostSpanPermission(page, input, anchor);
      this.#requirePage(session);
      return { ...result, ...association, requestAcknowledgementVerified: acknowledgementVerified };
    } catch (error) { throw typedUiError(error); }
  }

  async focus(session: SessionSnapshot) {
    if (session.pageKey === null) throw new SessionPlaneDomainError('browser.unavailable', 'No connected tab exists for this request');
    try {
      // Explicit viewing of the unique retained target does not adopt its
      // conversation or authorize content actions while acceptance is unknown.
      const unknown = session.submissionState === 'submission_unknown' && session.conversationId === null;
      const page = unknown ? this.#registry.unknownConversationCandidate(session.pageKey, session).page
        : this.#registry.requireSessionPage(session.pageKey, session);
      if (new URL(page.url()).origin !== this.#chatgptOrigin) throw new SessionPlaneDomainError(
        'session.page-identity-unverified', 'The request page left the provider origin');
      await page.bringToFront();
      return { pageKey: session.pageKey, url: page.url(), ...(unknown ? { conversationVerified: false } : {}) };
    } catch (error) {
      throw typedUiError(error);
    }
  }

  /** Caller holds the current request actor and exact page mutation lock. */
  async latest(session: SessionSnapshot, pageOwner = session) {
    const target = latestDisplayTarget(session);
    if (target === null) throw new SessionPlaneDomainError('session.recovery-unavailable',
      'Latest display requires the current exact completed answer or unresolved submitted anchor');
    const page = this.#requirePage(pageOwner);
    const mounted = async () => (await readChatGptMessages(page)).some(message =>
      message.role === target.role && [message.messageId, message.turnId].some(id => id !== null && target.ids.includes(id)));
    let outcome: 'already-present' | 'clicked' | 'scrolled' | 'not-dispatched' = 'already-present';
    const targetMounted = await mounted();
    if (!targetMounted || target.role === 'user') {
      const dom = await observeChatGptDom(page, session);
      const activity = await observeChatGptActivity(page, dom);
      const scrollMounted = !session.terminal && targetMounted && dom.candidate === null && !dom.laterUserFound;
      const clicked = (!targetMounted || scrollMounted) && activity.strength === 'none' && !dom.actionableAlert && await page.evaluate(restoreLatestPosition, {
        origin: this.#chatgptOrigin, conversationId: session.conversationId!,
        anchorIds: target.ids, expiresAt: Date.now() + 5_000, explicit: true, scrollMounted,
      });
      if (clicked) outcome = scrollMounted ? 'scrolled' : 'clicked';
      else if (!targetMounted || scrollMounted) outcome = 'not-dispatched';
    }
    this.#requirePage(pageOwner);
    return { pageKey: session.pageKey, conversationId: session.conversationId,
      responseMessageId: session.responseMessageId, displayOutcome: outcome,
      displayTarget: target.role === 'user' ? 'submitted-anchor' : 'completed-answer',
      ...(target.role === 'user' ? { anchorPresent: await mounted() } : { responseMounted: await mounted() }),
      ...(outcome !== 'not-dispatched' ? {} : { reason: 'display-guard-or-latest-control-unavailable',
        message: 'No display movement: preserve draft, selection, active generation and alerts; the exact turn needs a usable scroll surface or latest-position control.' }) };
  }

  /** Read the original turn under the current prepared generation's ownership.
   * Return separate evidence; never rewrite either generation or its stored answer.
   */
  async recoverHistoricalAnswer(original: SessionSnapshot, owner: SessionSnapshot, restorePosition = true) {
    const display = restorePosition ? await this.latest({ ...original, terminal: false, responseMessageId: null }, owner) : {};
    const page = this.#requirePage(owner);
    const binding = this.#registry.refreshPage(owner.pageKey!);
    const tracker = new ExactFinalTracker(this.#quietWindowMs);
    let currentActivity: { activity: string; activityReason: string | null; laterUserFound: boolean; providerAlerts: readonly string[]; errorCode: string | null } | undefined;
    const observe = async () => {
      this.#requirePage(owner);
      const dom = await observeChatGptDom(page, original);
      const activity = await observeChatGptActivity(page, dom);
      currentActivity = { activity: activity.strength, activityReason: activity.reason, laterUserFound: dom.laterUserFound,
        providerAlerts: dom.providerAlerts, errorCode: dom.actionableAlert ? 'provider.actionable-alert' : null };
      const dialog = await observeChatGptDialog(page);
      this.#requirePage(owner);
      const after = this.#registry.refreshPage(owner.pageKey!);
      const idleExact = binding.bindingEpoch === after.bindingEpoch && dom.submittedUserFound &&
        !dom.laterUserFound && !dom.actionableAlert && activity.strength === 'none';
      return tracker.evaluate({ provider: 'chatgpt', pageKey: owner.pageKey!, bindingEpoch: after.bindingEpoch,
        observedAt: new Date().toISOString(), conversationId: original.conversationId,
        submittedUserFound: dom.submittedUserFound, laterUserFound: dom.laterUserFound,
        candidate: dom.candidate, activity: activity.strength, dialogKind: dialog.kind, networkActivity: false,
        observationTransport: idleExact ? 'fresh' : 'unavailable', reason: 'historical-turn-not-idle-exact' }, performance.now());
    };
    let recovered = await observe();
    if (recovered.kind === 'progress' && recovered.reason === 'assistant-candidate-stabilizing') {
      await page.waitForTimeout(this.#quietWindowMs);
      recovered = await observe();
    }
    if (recovered.kind === 'complete' && recovered.responseMessageId === original.responseMessageId &&
        recovered.answerText === original.answerText?.trim()) {
      recovered = { kind: 'unverified', responseMessageId: null, answerText: null,
        reason: 'historical-answer-unchanged', freshExactProgress: false };
    }
    return { ...display, historical: true, bindingGeneration: owner.generation,
      storedResult: { responseMessageId: original.responseMessageId, answerText: original.answerText, reason: original.reason },
      answerRecovery: { observedAt: new Date().toISOString(), conversationId: original.conversationId,
        submittedUserMessageId: original.submittedUserMessageId, submittedUserTurnId: original.submittedUserTurnId,
        responseMessageId: recovered.responseMessageId, answerText: recovered.answerText,
        terminal: recovered.kind === 'complete', reason: recovered.reason, ...currentActivity } };
  }

  /** Reading an exact work turn is independent of later recovery-message ACKs. */
  async readOriginalWork(original: SessionSnapshot, owner: SessionSnapshot) {
    const page = this.#requirePage(owner);
    const binding = this.#registry.refreshPage(owner.pageKey!);
    const messages = await readChatGptMessages(page);
    const anchors = messages.filter(message => message.role === 'user' &&
      ((original.submittedUserMessageId !== null && message.messageId === original.submittedUserMessageId) ||
        (original.submittedUserTurnId !== null && message.turnId === original.submittedUserTurnId)));
    if (anchors.length !== 1) return { originalAnchorPresent: false, terminal: false, reason: 'original-work-anchor-unverified' };
    const anchor = anchors[0]!;
    const following = [];
    let lastUser = anchor;
    for (const message of messages.slice(messages.indexOf(anchor) + 1)) {
      if (message.rootIndex !== anchor.rootIndex) continue;
      if (message.role === 'user') {
        if (message.text.trim() !== '계속') break;
        lastUser = message;
      }
      following.push(message);
    }
    const response = await this.recoverHistoricalAnswer({ ...original,
      submittedUserMessageId: lastUser.messageId, submittedUserTurnId: lastUser.turnId }, owner, false);
    const after = this.#registry.refreshPage(owner.pageKey!);
    if (after.bindingEpoch !== binding.bindingEpoch) throw new SessionPlaneDomainError('browser.snapshot-stale', 'Work result page changed during read');
    return { originalAnchorPresent: true, originalUserMessageId: anchor.messageId,
      responseUserMessageId: lastUser.messageId, ...response.answerRecovery,
      observedMessages: following.slice(-12), providerMutation: false,
      association: 'exact-original-question-and-literal-continuations' };
  }

  /** Passive registry evidence only; no renderer access or recovery side effects. */
  pageHealth(session: SessionSnapshot) {
    if (session.pageKey === null) return null;
    try {
      const binding = this.#registry.getBinding(session.pageKey);
      const identityMatches = binding.sessionId === session.sessionId && binding.generation === session.generation &&
        binding.conversationId === session.conversationId;
      return { pageKey: session.pageKey, targetId: binding.targetId ?? null, bindingEpoch: binding.bindingEpoch,
        bindingState: binding.state, identityMatches,
        crashObservedAt: identityMatches ? this.#registry.observedCrash(session.pageKey) : null,
        scope: 'core-observed-page-events' as const };
    } catch { return null; }
  }

  async refresh(input: PreparationOwner & { readonly decisionId: string }): Promise<void> {
    let crashedBinding: PageBindingSnapshot | null = null;
    let incompleteDocument = false;
    try {
      await this.#submissions.refreshPage(input, async (session) => {
        const page = this.#requirePage(session);
        if (crashedBinding !== null) {
          await this.#browserOwner!.recoverCrashedPage(session.pageKey!, crashedBinding);
          await prepareChatGptObservation(this.#requirePage(session), session.pageKey!);
        } else {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
          if (incompleteDocument) await prepareChatGptObservation(page, session.pageKey!);
        }
        this.#requirePage(session);
        this.#refs.clear(session.pageKey!);
      }, async (session) => {
        const page = this.#requirePage(session);
        const crashObservedAt = this.#registry.observedCrash(session.pageKey!);
        if (crashObservedAt !== null) {
          if (this.#browserOwner === null || !session.terminal || session.submissionState !== 'failed_pre_submit' ||
              session.promptSubmitted || session.errorCode !== 'browser.unavailable' || session.conversationId === null ||
              session.submittedUserMessageId !== null || session.submittedUserTurnId !== null || session.responseMessageId !== null) {
            throw new SessionPlaneDomainError('browser.page-crashed',
              'Crashed-page refresh requires the exact unsubmitted failure; preserve active or uncertain requests',
              { ...this.pageHealth(session), dispatch: 'not-dispatched', automaticRetry: false });
          }
          crashedBinding = this.#registry.getBinding(session.pageKey!);
          return { loadError: false, rendererCrash: { observedAt: crashObservedAt, targetId: crashedBinding.targetId ?? null,
            bindingEpoch: crashedBinding.bindingEpoch, draftPreservation: 'provider-persisted-only' as const } };
        }
        const surface = session.conversationId ? await page.evaluate(conversationLoadSurface, {
          origin: this.#chatgptOrigin, conversationId: session.conversationId, click: false }) : null;
        // An explicitly refreshed pre-submit failure may still be parsing an
        // empty document. Requiring DOM readiness here prevents the reload that
        // recovers it. Keep the failed request unchanged and validate after reload.
        if (session.terminal && session.submissionState === 'failed_pre_submit' && !session.promptSubmitted &&
            session.errorCode === 'browser.unavailable' && session.conversationId !== null &&
            session.submittedUserMessageId === null && session.submittedUserTurnId === null &&
            session.responseMessageId === null && session.answerText === null &&
            await page.evaluate(() => document.readyState === 'loading' && document.body === null)) {
          await assertNoHumanVerification({ page, provider: 'chatgpt', pageKey: session.pageKey! });
          incompleteDocument = true;
          return { loadError: false, targetId: this.#registry.getBinding(session.pageKey!).targetId ?? null };
        }
        await prepareChatGptObservation(page, session.pageKey!);
        return { loadError: surface?.loadError === true, targetId: this.#registry.getBinding(session.pageKey!).targetId ?? null };
      });
    } catch (error) {
      throw typedUiError(error);
    }
  }

  async resume(input: PreparationOwner) {
    return await this.#submissions.resumePreparation(input);
  }

  async #interactionPage(session: SessionSnapshot): Promise<Page> {
    const page = this.#requirePage(session);
    return this.#browserOwner === null ? page : await this.#browserOwner.preparePageInteraction(session.pageKey!, session);
  }

  #requirePage(session: { readonly sessionId: string; readonly generation: number; readonly pageKey: string | null; readonly conversationId: string | null }, readOnly = false): Page {
    if (!readOnly && this.#submissions.isObservationHeld(session.conversationId))
      throw new SessionPlaneDomainError('provider.preparation-required', 'The user is reviewing this conversation; observation and controls are paused');
    if (session.pageKey === null) throw new SessionPlaneDomainError('browser.unavailable', 'Exact preparation page is unavailable');
    try {
      const binding = this.#registry.getBinding(session.pageKey);
      const passiveConversation = readOnly && this.#submissions.isObservationHeld(session.conversationId) &&
        session.conversationId !== null && binding.state === 'unbound' && binding.sessionId === null &&
        binding.conversationId === session.conversationId && this.#registry.findByConversation(session.conversationId).length === 1;
      const page = passiveConversation ? this.#registry.pageForObservation(session.pageKey) : this.#registry.requireSessionPage(session.pageKey, {
        sessionId: session.sessionId, generation: session.generation, conversationId: session.conversationId,
      });
      if (new URL(page.url()).origin !== this.#chatgptOrigin) {
        throw new SessionPlaneDomainError('session.page-identity-unverified', 'Page left the ChatGPT origin');
      }
      return page;
    } catch (error) {
      throw typedUiError(error);
    }
  }
}

export interface PreparationOwner {
  readonly clientId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly generation: number;
}

function preparationActions(node: BrowserSnapshotNode, menuIds: ReadonlySet<string>) {
  const choose: PreparationPurpose[] = [];
  const reveal: PreparationPurpose[] = [];
  if (node.disabled) return { choose, reveal };
  if (node.editable && node.role === 'textbox') choose.push('composer');
  if (node.role === 'button' && node.submitControl === true) choose.push('submit');
  const insideMenu = node.ancestorIds.some((id) => menuIds.has(id));
  if (!node.disabled) {
    if (node.role === 'slider' || (node.role === 'button' && node.hasPopup !== null) ||
        ['menuitemradio', 'option', 'radio'].includes(node.role) || isPreparationSummary(node, insideMenu)) {
      choose.push('model', 'effort');
    }
    if (['slider', 'menuitemradio', 'option', 'radio'].includes(node.role) || (node.role === 'menuitem' && insideMenu) || (node.role === 'button' &&
        (node.controls.length > 0 || ['menu', 'listbox', 'dialog', 'true'].includes(node.hasPopup ?? '')))) {
      reveal.push('model', 'effort');
    }
  }
  return { choose, reveal };
}

function hasRevealedChoices(nodes: readonly BrowserSnapshotNode[], opener: BrowserSnapshotNode, before: readonly BrowserSnapshotNode[]): boolean {
  // A nested menu may replace its opener. Verify fresh choices in that menu,
  // rather than requiring the clicked element to survive the transition.
  const scopes = new Set([
    ...opener.controls,
    ...before.filter((node) => node.id !== '' && node.role === 'menu' && opener.ancestorIds.includes(node.id)).map((node) => node.id),
    ...nodes.filter((node) => node.id !== '' && node.id === opener.id).flatMap((node) => node.controls),
  ]);
  return nodes.some((node) => ['option', 'menuitem', 'menuitemradio', 'radio', 'slider'].includes(node.role) &&
    node.ancestorIds.some((id) => scopes.has(id)) &&
    !before.some((previous) => sameSnapshotSemantics(previous, node)));
}

function hasNavigationEvidence(nodes: readonly BrowserSnapshotNode[], opener: BrowserSnapshotNode, before: readonly BrowserSnapshotNode[]): boolean {
  // Exploration can return from a submenu by closing its expanded chooser.
  // Verify the control transition and closed scope, without confirming a value.
  const collapsed = opener.expanded === true && opener.id !== '' &&
    nodes.some(node => node.id === opener.id && node.expanded === false) &&
    !nodes.some(node => opener.controls.includes(node.id));
  return collapsed || hasRevealedChoices(nodes, opener, before);
}

function toPreparationTarget(purpose: PreparationPurpose, node: BrowserSnapshotNode, selectedValue?: number): PreparationTarget {
  return {
    purpose, id: node.id, ancestorIds: node.ancestorIds, role: node.role, name: node.name, tag: node.tag, text: node.text, placeholder: node.placeholder,
    selected: node.selected, checked: node.checked, disabled: node.disabled, editable: node.editable,
    ariaValueText: node.ariaValueText, ariaValueNow: node.ariaValueNow, ariaValueMin: node.ariaValueMin,
    ariaValueMax: node.ariaValueMax, selectedValue: selectedValue ?? null, description: node.description, controls: node.controls,
    describedBy: node.describedBy, labelledBy: node.labelledBy,
  };
}

function typedUiError(error: unknown): SessionPlaneDomainError {
  if (error instanceof SessionPlaneDomainError) return error;
  if (error instanceof ProviderSubmissionError) return new SessionPlaneDomainError(error.errorCode, error.message, error.details);
  if (error instanceof PageRegistryError || error instanceof BrowserSnapshotError) {
    return new SessionPlaneDomainError(error.errorCode, error.message);
  }
  return new SessionPlaneDomainError('browser.unavailable', error instanceof Error ? error.message : 'Exact preparation page is unavailable');
}

/** Display identity only: this never infers an ACK or completes a generation. */
export function latestDisplayTarget(session: SessionSnapshot): { role: 'user' | 'assistant'; ids: string[] } | null {
  const reconciledFailure = session.terminal && session.sessionState === 'failed' &&
    ['thinking-failed-reconciled', 'message-timeout-reconciled'].includes(session.reason ?? '') && session.errorCode === 'provider.execution-failed';
  const unresolvedAlert = !session.terminal && session.errorCode === 'provider.actionable-alert';
  if (session.provider !== 'chatgpt' || (session.errorCode !== null && !unresolvedAlert && !reconciledFailure) || !session.promptSubmitted || session.conversationId === null) return null;
  if (session.terminal && session.sessionState === 'complete' && session.responseMessageId !== null)
    return { role: 'assistant', ids: [session.responseMessageId] };
  const ids = [session.submittedUserMessageId, session.submittedUserTurnId].filter((id): id is string => id !== null);
  return (!session.terminal || reconciledFailure) && session.submissionState === 'submitted' && session.responseMessageId === null && ids.length > 0
    ? { role: 'user', ids } : null;
}
