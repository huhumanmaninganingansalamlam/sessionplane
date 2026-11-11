import { createHash } from 'node:crypto';

import type {
  ExactSendIntent, ExactTaskProviderPort, ExactTurnQuery,
  FinalObservation, RecoveryOutcome, SendOutcome,
} from './durable-task-kernel.ts';
import type {
  SemanticActionCandidate, SemanticActResult, SemanticDispatchEvidence, SemanticObservation,
  SemanticProviderAdapter, SemanticTaskContext,
} from '../providers/semantic-adapter.ts';

/** Core-side bridge over the provider-neutral semantic port. In particular,
 * no CSS, ChatGPT label, browser API, or UI-specific decision type lives here.
 */
export interface SemanticDispatchJournal {
  /** Synchronous and durable; invoked after outgoing request provenance. */
  record(intent: ExactSendIntent, evidence: SemanticDispatchEvidence): void;
  read(query: ExactTurnQuery): SemanticDispatchEvidence | null;
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

  constructor(input: {
    adapter: SemanticProviderAdapter;
    resolveContext: SemanticContextResolver;
    dispatchJournal: SemanticDispatchJournal;
  }) {
    this.#adapter = input.adapter;
    this.providerKey = input.adapter.providerKey;
    this.#context = input.resolveContext;
    this.#journal = input.dispatchJournal;
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
    if (!intent.providerConversationId) {
      return { kind: 'unavailable', reason: 'canonical-conversation-binding-required-before-send' };
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
          return { kind: 'unavailable', reason: 'semantic-preflight-blocked-or-generating' };
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
    if (!intent.providerConversationId) {
      return { kind: 'uncertain', reason: 'canonical-conversation-binding-required-before-send' };
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
        context, kind: 'ack', prompt: intent.content, attempts: [evidence],
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
      const evidence = this.#journal.read(query);
      if (evidence === null || !correlate(query, evidence)) {
        return { kind: 'unavailable', reason: 'durable-exact-dispatch-evidence-unavailable' };
      }
      const context = await this.#context(query);
      if (!sameTask(query, context) ||
        (context.submittedUserMessageId !== null &&
          context.submittedUserMessageId !== evidence.messageId)) {
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
      const final = await this.#adapter.recover({ context: exactContext, kind: 'final' });
      if (final.kind === 'exact_final' && final.externalTurnId === query.externalTurnId) {
        return { kind: 'exact_final', externalTurnId: final.externalTurnId,
          answerText: final.answerText };
      }
      return final.kind === 'pending'
        ? { kind: 'pending', reason: final.reason }
        : { kind: 'unavailable',
          reason: final.kind === 'unavailable' ? final.reason : 'exact-semantic-final-not-recovered' };
    } catch {
      return { kind: 'unavailable', reason: 'semantic-final-recovery-unavailable' };
    }
  }
}
