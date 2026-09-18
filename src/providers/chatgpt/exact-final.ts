import type { ProviderObservationEvidence } from '../provider-adapter.ts';

export type ExactFinalDecisionKind =
  | 'complete'
  | 'blocked'
  | 'interstitial'
  | 'progress'
  | 'pending'
  | 'unverified';

export interface ExactFinalDecision {
  readonly kind: ExactFinalDecisionKind;
  readonly responseMessageId: string | null;
  readonly answerText: string | null;
  readonly reason: string;
  readonly freshExactProgress: boolean;
}

export class ExactFinalTracker {
  readonly #quietWindowMs: number;
  #candidateId: string | null = null;
  #candidateText: string | null = null;
  #stableSinceMs = 0;

  constructor(quietWindowMs: number) {
    if (!Number.isSafeInteger(quietWindowMs) || quietWindowMs <= 0) {
      throw new Error('quietWindowMs must be a positive integer');
    }
    this.#quietWindowMs = quietWindowMs;
  }

  evaluate(evidence: ProviderObservationEvidence, nowMs: number): ExactFinalDecision {
    if (evidence.dialogKind === 'rate_limit') {
      return decision('blocked', 'provider-rate-limit-dialog');
    }
    if (evidence.dialogKind === 'interstitial') {
      return decision('interstitial', 'provider-interstitial');
    }
    if (evidence.observationTransport === 'unavailable') {
      this.#reset();
      return decision('unverified', evidence.reason ?? 'dom-observation-unavailable');
    }
    if (evidence.conversationId === null) {
      this.#reset();
      return decision('unverified', evidence.reason ?? 'dom-conversation-unverified');
    }
    if (!evidence.submittedUserFound) {
      this.#reset();
      return decision('unverified', evidence.reason ?? 'dom-user-anchor-missing');
    }
    if (evidence.laterUserFound) {
      this.#reset();
      return decision('unverified', 'dom-later-user-turn');
    }

    const candidate = evidence.candidate;
    if (candidate === null) {
      this.#reset();
      if (evidence.activity === 'strong') {
        return decision('progress', 'provider-generation-activity', true);
      }
      if (evidence.networkActivity) {
        return decision('progress', 'provider-network-activity');
      }
      return decision('pending', 'assistant-candidate-missing');
    }

    if (candidate.responseMessageId.startsWith('request-placeholder-')) {
      this.#reset();
      return decision('progress', 'assistant-placeholder-active', true);
    }

    const text = candidate.answerText.trim();
    if (text.length === 0 || candidate.responseMessageId.length === 0) {
      this.#reset();
      return decision('progress', 'assistant-candidate-empty', true);
    }

    if (this.#candidateId !== candidate.responseMessageId || this.#candidateText !== text) {
      this.#candidateId = candidate.responseMessageId;
      this.#candidateText = text;
      this.#stableSinceMs = nowMs;
    }

    if (candidate.streamingMarker || evidence.activity === 'strong') {
      return decision('progress', 'assistant-generation-active', true);
    }
    if (candidate.terminalMarker) {
      return complete(candidate.responseMessageId, text, 'dom-terminal-marker');
    }
    if (evidence.activity === 'unknown') {
      return decision('unverified', 'activity-observation-unknown');
    }
    if (nowMs - this.#stableSinceMs >= this.#quietWindowMs) {
      return complete(candidate.responseMessageId, text, 'dom-quiet-stable-final');
    }
    return decision('progress', 'assistant-candidate-stabilizing', true);
  }

  #reset(): void {
    this.#candidateId = null;
    this.#candidateText = null;
    this.#stableSinceMs = 0;
  }
}

function decision(
  kind: ExactFinalDecisionKind,
  reason: string,
  freshExactProgress = false,
): ExactFinalDecision {
  return {
    kind,
    responseMessageId: null,
    answerText: null,
    reason,
    freshExactProgress,
  };
}

function complete(
  responseMessageId: string,
  answerText: string,
  reason: string,
): ExactFinalDecision {
  return {
    kind: 'complete',
    responseMessageId,
    answerText,
    reason,
    freshExactProgress: true,
  };
}
