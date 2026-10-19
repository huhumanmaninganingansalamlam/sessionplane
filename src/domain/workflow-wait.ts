// Node timers use signed 32-bit milliseconds. Keep whole minutes within that bound.
export const MAX_WORKFLOW_WAIT_MS = Math.floor(2_147_483_647 / 60_000) * 60_000;
export const DEFAULT_WORKFLOW_WAIT_MS = 10 * 60_000;

export function workflowWaitMs(value: number): number {
  return value === 0 ? 0 : Math.ceil(value / 60_000) * 60_000;
}

/** Observation pacing/429 and changing progress are not completion or a decision. */
export function workflowWaitOutcome(result: Record<string, unknown>): boolean {
  const recovery = result.recovery as { userActionRequired?: boolean } | undefined;
  return result.requestOk === false || result.terminal === true ||
    result.status === 'needs_decision' || result.status === 'recovery_required' ||
    recovery?.userActionRequired === true || result.inspectionError !== undefined ||
    (result.stopOutcome as { state?: string } | undefined)?.state === 'unknown' || result.reason === 'provider-actionable-alert' ||
    ['provider.interstitial', 'provider.observation-unavailable', 'provider.conversation-unavailable', 'provider.actionable-alert'].includes(String(result.errorCode)) ||
    result.providerState === 'blocked' || result.providerState === 'error';
}
