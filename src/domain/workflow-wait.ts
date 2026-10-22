// Node timers use signed 32-bit milliseconds. Keep whole minutes within that bound.
export const MAX_WORKFLOW_WAIT_MS = Math.floor(2_147_483_647 / 60_000) * 60_000;
export const DEFAULT_WORKFLOW_WAIT_MS = 10 * 60_000;

export function workflowWaitMs(value: number): number {
  return value === 0 ? 0 : Math.ceil(value / 60_000) * 60_000;
}

/** A provider-paced exact-owner ACK check is routine control, never a candidate decision. */
export function workflowAcknowledgementPending(result: Record<string, unknown>): boolean {
  const recovery = result.acknowledgementRecovery as { kind?: string; currentIdentityMatches?: boolean } | undefined;
  return result.submissionState === 'submission_unknown' && result.promptSubmitted === true &&
    result.terminal !== true && recovery?.kind === 'deferred' && recovery.currentIdentityMatches === true;
}

/** A retained ACK missing from a read surface still belongs to the paced observer. */
export function workflowAnchorRecoveryPending(result: Record<string, unknown>): boolean {
  const verification = result.submissionVerification as { state?: string; nextAction?: string;
    backend?: { currentIdentityMatches?: boolean; recoveryReason?: string } } | undefined;
  const load = result.conversationLoadRecovery as { state?: string; conversationId?: string; sessionId?: string; pageKey?: string } | undefined;
  const loading = !!load && ['held', 'waiting', 'attempting'].includes(load.state ?? '') &&
    typeof result.conversationId === 'string' && load.conversationId === result.conversationId &&
    typeof result.sessionId === 'string' && load.sessionId === result.sessionId &&
    typeof result.pageKey === 'string' && load.pageKey === result.pageKey;
  const paced = result.reason === 'backend-conversation-probe-paced' &&
    result.observationTransport === 'deferred' &&
    Number.isFinite(Date.parse(String(result.nextCheckAt))) &&
    typeof result.conversationId === 'string' && typeof result.pageKey === 'string' &&
    typeof result.submittedUserMessageId === 'string';
  return result.submissionState === 'submitted' && result.promptSubmitted === true && result.terminal !== true &&
    result.userActionRequired !== true &&
    verification?.state === 'anchor-unverified' && verification.nextAction === 'read_same_request' &&
    (loading || paced || (verification.backend?.currentIdentityMatches === true &&
      verification.backend.recoveryReason === 'backend-user-anchor-absent-from-mapping'));
}

/** A live preparation waiting for its owned conversation is not a model choice yet. */
export function workflowPreparationPending(result: Record<string, unknown>): boolean {
  const load = result.conversationLoadRecovery as { state?: string } | undefined;
  const evidence = result.evidence as { preparationAvailability?: { available?: boolean } } | undefined;
  return result.requestOk !== false && result.terminal !== true && result.userActionRequired !== true &&
    result.submissionState === 'prepared' && result.promptSubmitted === false &&
    result.status === 'needs_decision' && (result.reason === 'account-cooldown' ||
      (evidence?.preparationAvailability?.available === false &&
        ['held', 'waiting', 'attempting'].includes(load?.state ?? '')));
}

/** Observation transport delays, pacing/429 and progress are not completion or a decision. */
export function workflowWaitOutcome(result: Record<string, unknown>): boolean {
  if ((result.recovery as { decisionRequired?: boolean } | undefined)?.decisionRequired === true) return true;
  if (workflowPreparationPending(result)) return false;
  if (result.followup !== undefined) return result.requestOk === false || (result.followup as { terminal?: boolean }).terminal === true || result.errorCode === 'provider.actionable-alert';
  const load = result.conversationLoadRecovery as { state?: string } | undefined;
  if (result.requestOk !== false && result.terminal !== true && result.promptSubmitted === true &&
      result.errorCode === 'provider.conversation-unavailable' && load &&
      ['held', 'waiting', 'attempting'].includes(load.state ?? '') &&
      (result.recovery as { userActionRequired?: boolean } | undefined)?.userActionRequired !== true) return false;
  const recovery = result.recovery as { userActionRequired?: boolean } | undefined;
  return result.requestOk === false || result.terminal === true || (result.followup as { terminal?: boolean } | undefined)?.terminal === true ||
    (result.status === 'needs_decision' && !workflowAcknowledgementPending(result)) ||
    (result.status === 'recovery_required' && !workflowAnchorRecoveryPending(result)) ||
    recovery?.userActionRequired === true || (result.inspectionError !== undefined &&
      !['browser.snapshot-timeout', 'provider.observation-unavailable'].includes(String((result.inspectionError as { errorCode?: string }).errorCode))) ||
    (result.stopOutcome as { state?: string } | undefined)?.state === 'unknown' || result.reason === 'provider-actionable-alert' ||
    ['provider.interstitial', 'provider.conversation-unavailable', 'provider.actionable-alert'].includes(String(result.errorCode)) ||
    result.providerState === 'blocked' || result.providerState === 'error';
}
