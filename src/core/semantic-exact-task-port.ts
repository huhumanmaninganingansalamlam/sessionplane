import { createHash } from 'node:crypto';

import type {
  ExactSendIntent, ExactTaskProviderPort, ExactTurnQuery,
  FinalObservation, RecoveryOutcome, SendOutcome,
} from './durable-task-kernel.ts';
import { semanticConfigurationMatches } from '../providers/semantic-adapter.ts';
import type {
  SemanticActionCandidate, SemanticActResult, SemanticDispatchEvidence, SemanticObservation,
  SemanticProviderAdapter, SemanticRootPostEvidence, SemanticTaskContext,
} from '../providers/semantic-adapter.ts';

/** Core-side bridge over the provider-neutral semantic port. In particular,
 * no CSS, ChatGPT label, browser API, or UI-specific decision type lives here.
 */
export interface SemanticRootDispatchJournalRecord extends SemanticRootPostEvidence {
  readonly observationCount: number;
  readonly ambiguous: boolean;
}
export interface SemanticDispatchJournal {
  /** Synchronous and durable; invoked after outgoing request provenance. */
  record(intent: ExactSendIntent, evidence: SemanticDispatchEvidence): void;
  read(query: ExactTurnQuery): SemanticDispatchEvidence | null;
  /** First-POST evidence is written by the provider request callback itself. */
  readRoot(query: ExactSendIntent): SemanticRootDispatchJournalRecord | null;
  /** URL identity is only a candidate for authenticated canonical recovery. */
  resolveRootCandidate(query: ExactSendIntent): string | null;
}
export type SemanticContextResolver = (
  intent: ExactSendIntent,
) => SemanticTaskContext | Promise<SemanticTaskContext>;

function sha(value: string): string {
  return createHash('sha256').update(value.replaceAll('\r\n', '\n')).digest('hex');
}
function one(
  candidates: readonly SemanticActionCandidate[], purpose: SemanticActionCandidate['purpose'],
): SemanticActionCandidate | null {
  const matches = candidates.filter(candidate => candidate.purpose === purpose);
  return matches.length === 1 ? matches[0]! : null;
}
function sameTask(intent: ExactSendIntent, context: SemanticTaskContext): boolean {
  return context.taskId === intent.taskId && context.projectId === intent.projectId &&
    context.slotId === intent.slotId && context.slotRevision === intent.slotRevision &&
    context.providerConversationId === intent.providerConversationId;
}
function supportsConversation(adapter: SemanticProviderAdapter): boolean {
  return adapter.capabilities.providerKey === adapter.providerKey &&
    adapter.capabilities.contractVersion === 1 &&
    adapter.capabilities.supports.includes('conversation');
}
function isConversationObservation(
  observation: SemanticObservation, adapter: SemanticProviderAdapter,
): boolean {
  const manifest = observation.capabilityManifest;
  return supportsConversation(adapter) &&
    observation.providerKey === adapter.providerKey &&
    manifest.providerKey === adapter.providerKey &&
    manifest.contractVersion === adapter.capabilities.contractVersion &&
    manifest.browserRequired === adapter.capabilities.browserRequired &&
    manifest.supports.includes('conversation');
}
function failed(result: SemanticActResult): string {
  return result.kind === 'uncertain' || result.kind === 'stale' ||
    result.kind === 'unsupported' || result.kind === 'authorization_required' ||
    result.kind === 'busy' ? result.reason : 'semantic-action-not-verified';
}
function correlate(intent: ExactSendIntent, evidence: SemanticDispatchEvidence): boolean {
  return evidence.conversationId === intent.providerConversationId &&
    evidence.textHash === sha(intent.content) &&
    Boolean(evidence.messageId && evidence.parentMessageId);
}
function correlateRoot(intent: ExactSendIntent, evidence: SemanticRootPostEvidence): boolean {
  return intent.providerConversationId === null && evidence.textHash === sha(intent.content) &&
    Boolean(evidence.messageId && evidence.parentMessageId) &&
    (evidence.requestConversationId === null ||
      /^[A-Za-z0-9_-]{1,160}$/.test(evidence.requestConversationId));
}
function sameRoot(
  left: SemanticRootPostEvidence, right: SemanticRootPostEvidence,
): boolean {
  return left.requestConversationId === right.requestConversationId &&
    left.messageId === right.messageId && left.parentMessageId === right.parentMessageId &&
    left.textHash === right.textHash && left.observedAt === right.observedAt;
}

/**
 * Task Kernel already committed beginDispatch before invoking sendOnce.
 * Drafting is non-authoritative; one attempted send produces only evidence,
 * not an ACK. Absent/ambiguous evidence remains uncertain and is never sent
 * again during recovery.
 */
export class SemanticExactTaskPort implements ExactTaskProviderPort {
  readonly providerKey: string;
  readonly #adapter: SemanticProviderAdapter;
  readonly #context: SemanticContextResolver;
  readonly #journal: SemanticDispatchJournal;
  readonly #onDecisionRequired: ((intent: ExactSendIntent) => Promise<void>) | undefined;

  constructor(input: {
    adapter: SemanticProviderAdapter;
    resolveContext: SemanticContextResolver;
    dispatchJournal: SemanticDispatchJournal;
    onDecisionRequired?: (intent: ExactSendIntent) => Promise<void>;
  }) {
    this.#adapter = input.adapter;
    this.providerKey = input.adapter.providerKey;
    this.#context = input.resolveContext;
    this.#journal = input.dispatchJournal;
    this.#onDecisionRequired = input.onDecisionRequired;
  }

  /** No DOM mutation and no irreversible attempt journal. Absence of a
   * verified owned tab is known-not-attempted, not a potentially sent POST.
   */
  async preflight(intent: ExactSendIntent): Promise<
    { kind: 'ready' } | { kind: 'unavailable'; reason: string }
  > {
    if (intent.kind === 'stop') {
      return { kind: 'unavailable', reason: 'stop-requires-explicit-provider-evidence' };
    }
    const root = intent.providerConversationId === null;
    if (root && intent.kind !== 'initial') {
      return { kind: 'unavailable', reason: 'unbound-root-allows-only-the-owned-initial' };
    }
    if (root && this.#journal.readRoot(intent) !== null) {
      return { kind: 'unavailable', reason: 'root-post-already-recorded-no-replay' };
    }
    if (!supportsConversation(this.#adapter)) {
      return { kind: 'unavailable', reason: 'semantic-conversation-capability-unavailable' };
    }
    try {
      const context = await this.#context(intent);
      if (!sameTask(intent, context)) {
        return { kind: 'unavailable', reason: 'semantic-context-does-not-match-task-binding' };
      }
      if (this.#adapter.capabilities.browserRequired && context.pageLease === null) {
        return { kind: 'unavailable', reason: 'owned-page-lease-not-ready' };
      }
      if (intent.kind === 'continuation' &&
          (context.submittedUserMessageId === null || context.submittedUserTurnId === null)) {
        return { kind: 'unavailable', reason: 'continuation-exact-turn-not-ready' };
      }
      if (this.#adapter.capabilities.browserRequired) {
        // Observe only. Existing provider questions, permission cards, retry
        // barriers and active streams are known BEFORE beginDispatch; the
        // subsequent sendOnce must obtain a fresh observation independently.
        const observation = await this.#adapter.observe(context);
        if (!isConversationObservation(observation, this.#adapter)) {
          return { kind: 'unavailable', reason: 'semantic-preflight-capability-unverified' };
        }
        if (observation.blocker !== 'none' || observation.progress === 'streaming') {
          // The same blocked attempt remains planned. A verified provider
          // decision must become a durable agent packet, not a guessed click.
          if (observation.progress !== 'streaming' && (
            observation.blocker === 'provider_question' ||
            observation.blocker === 'provider_permission' ||
            observation.blocker === 'provider_retry' ||
            observation.blocker === 'human_verification')) {
            try { await this.#onDecisionRequired?.(intent); }
            catch { return { kind: 'unavailable', reason: 'agent-decision-publication-unavailable' }; }
          }
          return { kind: 'unavailable', reason: 'semantic-preflight-blocked-or-generating' };
        }
        if (context.requiredModel &&
          !semanticConfigurationMatches(this.providerKey, context.requiredModel, observation)) {
          return { kind: 'unavailable', reason: 'requested-model-not-currently-verified' };
        }
        // A non-empty existing draft has no Core-owned content proof. It is a
        // known-not-sent state, so do not consume beginDispatch merely for the
        // later sendOnce hash check to reject it. Only an exact empty-composer
        // draft action is sufficient readiness; sendOnce still re-observes.
        const compose = one(observation.actions, 'compose');
        if (compose === null || compose.risk !== 'draft_only' ||
            compose.input.kind !== 'text') {
          return { kind: 'unavailable', reason: 'semantic-preflight-exact-compose-required' };
        }
        if (intent.content.length > compose.input.maxLength) {
          return { kind: 'unavailable', reason: 'exact-prompt-exceeds-composer-schema' };
        }
      }
      return { kind: 'ready' };
    } catch {
      return { kind: 'unavailable', reason: 'semantic-context-unavailable' };
    }
  }

  async sendOnce(intent: ExactSendIntent): Promise<SendOutcome> {
    if (intent.kind === 'stop') {
      return { kind: 'uncertain', reason: 'stop-requires-explicit-provider-evidence' };
    }
    const root = intent.providerConversationId === null;
    if (root && intent.kind !== 'initial') {
      return { kind: 'uncertain', reason: 'unbound-root-allows-only-the-owned-initial' };
    }
    if (root && this.#journal.readRoot(intent) !== null) {
      return { kind: 'uncertain', reason: 'root-post-already-recorded-no-replay' };
    }
    if (!supportsConversation(this.#adapter)) {
      return { kind: 'uncertain', reason: 'semantic-conversation-capability-unavailable' };
    }
    try {
      const context = await this.#context(intent);
      if (!sameTask(intent, context)) {
        return { kind: 'uncertain', reason: 'semantic-context-does-not-match-task-binding' };
      }
      let observation = await this.#adapter.observe(context);
      if (!isConversationObservation(observation, this.#adapter) ||
        observation.blocker !== 'none' || observation.progress === 'streaming') {
        return { kind: 'uncertain', reason: 'semantic-observation-blocked-or-generating' };
      }
      if (context.requiredModel &&
          !semanticConfigurationMatches(this.providerKey, context.requiredModel, observation)) {
        return { kind: 'uncertain', reason: 'requested-model-changed-after-preflight' };
      }
      const compose = one(observation.actions, 'compose');
      if (compose !== null) {
        if (compose.input.kind !== 'text' || intent.content.length > compose.input.maxLength) {
          return { kind: 'uncertain', reason: 'exact-prompt-exceeds-composer-schema' };
        }
        const drafted = await this.#adapter.act({
          context, snapshotId: observation.snapshotId, actionRef: compose.actionRef,
          evidenceHash: compose.evidenceHash, input: intent.content,
        });
        if (drafted.kind !== 'performed' || drafted.effect !== 'draft_updated') {
          return { kind: 'uncertain', reason: failed(drafted) };
        }
        observation = await this.#adapter.observe(context);
        if (!isConversationObservation(observation, this.#adapter) ||
          observation.blocker !== 'none' || observation.progress === 'streaming') {
          return { kind: 'uncertain', reason: 'semantic-observation-changed-after-draft' };
        }
        if (context.requiredModel &&
          !semanticConfigurationMatches(this.providerKey, context.requiredModel, observation)) {
          return { kind: 'uncertain', reason: 'requested-model-changed-after-draft' };
        }
      }
      const purpose = intent.kind === 'continuation' ? 'continue' : 'submit';
      // The actual provider adapter verifies the exact committed draft hash.
      // Never select a different send control or turn by heuristic.
      const send = one(observation.actions, purpose);
      if (!send || send.risk !== 'send_once' || send.input.kind !== 'none') {
        return { kind: 'uncertain', reason: 'exact-semantic-send-candidate-unavailable' };
      }
      const dispatched = await this.#adapter.act({
        context, snapshotId: observation.snapshotId, actionRef: send.actionRef,
        evidenceHash: send.evidenceHash, authorizedAttemptId: intent.attemptId,
        expectedContentSha256: sha(intent.content),
      });
      if (root) {
        if (dispatched.kind !== 'root_dispatched_unverified' ||
            dispatched.rootPosts.length !== 1 ||
            !correlateRoot(intent, dispatched.rootPosts[0]!)) {
          return { kind: 'uncertain', reason: failed(dispatched) };
        }
        const persisted = this.#journal.readRoot(intent);
        if (persisted === null || persisted.ambiguous || persisted.observationCount !== 1 ||
            !sameRoot(persisted, dispatched.rootPosts[0]!)) {
          return { kind: 'uncertain', reason: 'durable-root-post-evidence-unverified' };
        }
        // The URL transition is not an ACK. Recovery performs an authenticated
        // canonical GET and atomically promotes this exact persisted POST.
        return { kind: 'uncertain', reason: 'root-post-recorded-awaiting-canonical-ack' };
      }
      if (dispatched.kind === 'uncertain' && dispatched.attempts?.length === 1 &&
        correlate(intent, dispatched.attempts[0]!)) {
        // A provider-side synchronous sink may have failed after the POST.
        // A second *journal write* is safe; a second send is never attempted.
        try { this.#journal.record(intent, dispatched.attempts[0]!); }
        catch { /* Preserve uncertain; recovery will use any durable evidence. */ }
        return { kind: 'uncertain', reason: dispatched.reason };
      }
      if (dispatched.kind !== 'dispatched_unverified' || dispatched.attempts.length !== 1 ||
        !correlate(intent, dispatched.attempts[0]!)) {
        return { kind: 'uncertain', reason: failed(dispatched) };
      }
      const evidence = dispatched.attempts[0]!;
      // Durable before ACK lookup. A failed insert is uncertain, never
      // permission to repeat a click or the original user question.
      this.#journal.record(intent, evidence);
      const ack = await this.#adapter.verify({
        // Before continuation POST, context anchors the prior ACK for UI
        // safety. The new ACK must instead identify this attempt's exact POST
        // message; the new turn ID is unknown until canonical verification.
        context: { ...context, submittedUserMessageId: evidence.messageId,
          submittedUserTurnId: null },
        kind: 'ack', prompt: intent.content, attempts: [evidence],
      });
      return ack.kind === 'verified_ack' && ack.messageId === evidence.messageId
        ? { kind: 'verified_ack', externalTurnId: ack.externalTurnId }
        : { kind: 'uncertain', reason: 'canonical-ack-still-unverified' };
    } catch {
      return { kind: 'uncertain', reason: 'semantic-dispatch-or-proof-unavailable' };
    }
  }

  async recoverAck(query: ExactTurnQuery): Promise<RecoveryOutcome> {
    if (!supportsConversation(this.#adapter)) {
      return { kind: 'unavailable', reason: 'semantic-conversation-capability-unavailable' };
    }
    try {
      const context = await this.#context(query);
      if (!sameTask(query, context)) {
        return { kind: 'unavailable', reason: 'semantic-recovery-task-binding-mismatch' };
      }
      if (query.providerConversationId === null) {
        const root = this.#journal.readRoot(query);
        if (root === null) {
          return { kind: 'unavailable', reason: 'durable-root-post-evidence-unavailable' };
        }
        if (root.ambiguous || root.observationCount !== 1) {
          return { kind: 'unavailable', reason: 'durable-root-post-evidence-ambiguous' };
        }
        if (!correlateRoot(query, root) || context.submittedUserMessageId !== null ||
            context.submittedUserTurnId !== null || query.externalTurnId !== null) {
          return { kind: 'unavailable', reason: 'root-recovery-task-or-message-mismatch' };
        }
        const candidateConversationId = this.#journal.resolveRootCandidate(query);
        if (candidateConversationId === null) {
          return { kind: 'pending', reason: 'root-conversation-candidate-not-observed' };
        }
        if (root.requestConversationId !== null &&
            root.requestConversationId !== candidateConversationId) {
          return { kind: 'unavailable', reason: 'root-request-conversation-candidate-mismatch' };
        }
        const ack = await this.#adapter.recover({
          context, kind: 'ack', prompt: query.content,
          rootPost: root, candidateConversationId,
        });
        if (ack.kind === 'verified_root_ack') {
          return ack.conversationId === candidateConversationId &&
            ack.messageId === root.messageId
            ? { kind: 'verified_root_ack', conversationId: ack.conversationId,
              messageId: ack.messageId, externalTurnId: ack.externalTurnId }
            : { kind: 'unavailable', reason: 'canonical-root-ack-bound-identity-mismatch' };
        }
        return ack.kind === 'pending' || ack.kind === 'unavailable'
          ? { kind: ack.kind, reason: ack.reason }
          : { kind: 'unavailable', reason: 'canonical-root-ack-invalid-result-kind' };
      }
      const evidence = this.#journal.read(query);
      if (evidence === null || !correlate(query, evidence)) {
        return { kind: 'unavailable', reason: 'durable-exact-dispatch-evidence-unavailable' };
      }
      if (context.submittedUserMessageId !== null &&
          context.submittedUserMessageId !== evidence.messageId) {
        return { kind: 'unavailable', reason: 'semantic-recovery-task-binding-mismatch' };
      }
      // Recovery is read-only even when the page lease is null after restart.
      const ack = await this.#adapter.recover({
        context, kind: 'ack', prompt: query.content, attempts: [evidence],
      });
      if (ack.kind === 'verified_ack') {
        return ack.messageId === evidence.messageId &&
          (query.externalTurnId === null || query.externalTurnId === ack.externalTurnId) &&
          (context.submittedUserTurnId === null || context.submittedUserTurnId === ack.externalTurnId)
          ? { kind: 'verified_ack', externalTurnId: ack.externalTurnId }
          : { kind: 'unavailable', reason: 'canonical-ack-bound-identity-mismatch' };
      }
      return ack.kind === 'pending' || ack.kind === 'unavailable'
        ? { kind: ack.kind, reason: ack.reason }
        : { kind: 'unavailable', reason: 'canonical-ack-invalid-result-kind' };
    } catch {
      return { kind: 'unavailable', reason: 'semantic-read-only-recovery-unavailable' };
    }
  }

  async reserveFinalRead(query: ExactTurnQuery, notBefore: string): Promise<void> {
    if (!this.#adapter.reserveFinalRead || !supportsConversation(this.#adapter) ||
        !query.externalTurnId || !Number.isFinite(Date.parse(notBefore))) return;
    const evidence = this.#journal.read(query);
    if (evidence === null || !correlate(query, evidence)) return;
    const context = await this.#context(query);
    if (!sameTask(query, context) ||
        (context.submittedUserTurnId !== null &&
          context.submittedUserTurnId !== query.externalTurnId) ||
        (context.submittedUserMessageId !== null &&
          context.submittedUserMessageId !== evidence.messageId)) return;
    await this.#adapter.reserveFinalRead({
      context: { ...context, submittedUserMessageId: evidence.messageId,
        submittedUserTurnId: query.externalTurnId },
      notBefore,
    });
  }

  async observeFinal(query: ExactTurnQuery): Promise<FinalObservation> {
    if (!supportsConversation(this.#adapter)) {
      return { kind: 'unavailable', reason: 'semantic-conversation-capability-unavailable' };
    }
    if (!query.externalTurnId) {
      return { kind: 'unavailable', reason: 'exact-acknowledged-turn-required' };
    }
    try {
      const evidence = this.#journal.read(query);
      if (evidence === null || !correlate(query, evidence)) {
        return { kind: 'unavailable', reason: 'durable-exact-dispatch-evidence-unavailable' };
      }
      const context = await this.#context(query);
      if (!sameTask(query, context) || (
        context.submittedUserTurnId !== null &&
        context.submittedUserTurnId !== query.externalTurnId
      )) {
        return { kind: 'unavailable', reason: 'semantic-final-task-or-turn-mismatch' };
      }
      if (context.submittedUserMessageId !== null &&
        context.submittedUserMessageId !== evidence.messageId) {
        return { kind: 'unavailable', reason: 'semantic-final-message-boundary-conflict' };
      }
      const exactContext: SemanticTaskContext = {
        ...context,
        submittedUserMessageId: evidence.messageId,
        submittedUserTurnId: query.externalTurnId,
      };
      const final = await this.#adapter.recover({
        context: exactContext, kind: 'final',
        ...(query.readPriority ? { readPriority: query.readPriority } : {}),
      });
      if (final.kind === 'exact_final' && final.externalTurnId === query.externalTurnId) {
        return { kind: 'exact_final', externalTurnId: final.externalTurnId,
          answerText: final.answerText };
      }
      return final.kind === 'pending'
        ? { kind: 'pending', reason: final.reason, nextCheckAt: final.nextCheckAt ?? null }
        : { kind: 'unavailable',
          reason: final.kind === 'unavailable' ? final.reason : 'exact-semantic-final-not-recovered',
          nextCheckAt: final.kind === 'unavailable' ? final.nextCheckAt ?? null : null };
    } catch {
      return { kind: 'unavailable', reason: 'semantic-final-recovery-unavailable' };
    }
  }
}
