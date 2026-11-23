export const CONTINUATION_INTERVAL_MS = 1_200_000;
export const CONTINUATION_READ_RETRY_MIN_MS = 5_000;
export const CONTINUATION_DUE_READ_RESERVATION_MS = CONTINUATION_INTERVAL_MS;
export const CONTINUATION_TIMER_KIND = 'continuation_due';

export interface ContinuationPolicy {
  readonly contract: 'approved_continuation_v1';
  readonly approvalRef: string;
  readonly intervalMs: number;
  readonly message: string;
  readonly sourceAttemptId: string;
  readonly agentReviewAfterMs?: number;
  readonly stagnationSince?: string;
}

export function validateContinuationPolicy(value: unknown): value is ContinuationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.contract === 'approved_continuation_v1' &&
    typeof v.approvalRef === 'string' && v.approvalRef.trim().length > 0 &&
    typeof v.message === 'string' && v.message.trim().length > 0 &&
    v.intervalMs === CONTINUATION_INTERVAL_MS &&
    typeof v.sourceAttemptId === 'string' && v.sourceAttemptId.length > 0 &&
    (v.agentReviewAfterMs === undefined ||
      (typeof v.agentReviewAfterMs === 'number' && Number.isSafeInteger(v.agentReviewAfterMs) &&
        v.agentReviewAfterMs >= CONTINUATION_INTERVAL_MS)) &&
    (v.stagnationSince === undefined ||
      (typeof v.stagnationSince === 'string' &&
        Number.isFinite(Date.parse(v.stagnationSince))));
}
export function parseContinuationPolicy(raw: string): ContinuationPolicy | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { return null; }
  return validateContinuationPolicy(parsed) ? parsed : null;
}
export function nextContinuationDueAt(acknowledgedAt: string, intervalMs = CONTINUATION_INTERVAL_MS): string {
  const ackMs = Date.parse(acknowledgedAt);
  if (!Number.isFinite(ackMs) || intervalMs !== CONTINUATION_INTERVAL_MS) {
    throw new Error('Exact ACK and approved interval required');
  }
  return new Date(ackMs + intervalMs).toISOString();
}

export interface PublicContinuationPolicy {
  readonly enabled: true;
  readonly intervalMs: typeof CONTINUATION_INTERVAL_MS;
  readonly approvalRef: string;
  readonly message: string;
  readonly agentReviewAfterMs?: number;
}
export function parsePublicContinuationPolicy(raw: string): PublicContinuationPolicy | null {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  if (p.enabled !== true || p.intervalMs !== CONTINUATION_INTERVAL_MS ||
      typeof p.approvalRef !== 'string' || !p.approvalRef.trim() ||
      typeof p.message !== 'string' || !p.message.trim() ||
      (p.agentReviewAfterMs !== undefined &&
       (typeof p.agentReviewAfterMs !== 'number' || !Number.isSafeInteger(p.agentReviewAfterMs) ||
        p.agentReviewAfterMs < CONTINUATION_INTERVAL_MS))) return null;
  return {
    enabled: true, intervalMs: CONTINUATION_INTERVAL_MS,
    approvalRef: p.approvalRef, message: p.message,
    ...(p.agentReviewAfterMs === undefined ? {} : { agentReviewAfterMs: p.agentReviewAfterMs as number }),
  };
}
