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

/** Observation transport delays, pacing/429 and progress are not completion or a decision. */
export function workflowWaitOutcome(result: Record<string, unknown>): boolean {
  if (result.followup !== undefined) return result.requestOk === false || (result.followup as { terminal?: boolean }).terminal === true || result.errorCode === 'provider.actionable-alert';
  const recovery = result.recovery as { userActionRequired?: boolean } | undefined;
  return result.requestOk === false || result.terminal === true || (result.followup as { terminal?: boolean } | undefined)?.terminal === true ||
    (result.status === 'needs_decision' && !workflowAcknowledgementPending(result)) || result.status === 'recovery_required' ||
    recovery?.userActionRequired === true || (result.inspectionError !== undefined &&
      !['browser.snapshot-timeout', 'provider.observation-unavailable'].includes(String((result.inspectionError as { errorCode?: string }).errorCode))) ||
    (result.stopOutcome as { state?: string } | undefined)?.state === 'unknown' || result.reason === 'provider-actionable-alert' ||
    ['provider.interstitial', 'provider.conversation-unavailable', 'provider.actionable-alert'].includes(String(result.errorCode)) ||
    result.providerState === 'blocked' || result.providerState === 'error';
}
