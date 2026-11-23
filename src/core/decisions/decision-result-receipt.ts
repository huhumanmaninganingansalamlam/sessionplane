import { SessionPlaneDomainError } from '../../domain/errors.ts';
import type { AgentDecisionOutcome, AgentDecisionPacket } from '../semantic-decision-gateway.ts';

export function replayDecisionOutcome(
  resolutionJson: string | null,
  input: { requestId: string; actionRef: string; inputValue: string | null },
): AgentDecisionOutcome {
  const value: unknown = resolutionJson === null ? null : JSON.parse(resolutionJson);
  if (!value || typeof value !== 'object') {
    throw new SessionPlaneDomainError('idempotency_conflict', 'Decision already resolved by a different request');
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.kind !== 'semantic_action' || receipt.requestId !== input.requestId ||
      receipt.actionRef !== input.actionRef || receipt.input !== input.inputValue) {
    throw new SessionPlaneDomainError('idempotency_conflict', 'Decision already resolved by a different request');
  }
  // The decision grant is irreversibly reserved before the adapter acts.
  // Neither a consumed bit nor the resolution alone proves its effect.
  const recorded = receipt.outcome;
  if (!recorded || typeof recorded !== 'object') {
    return { kind: 'uncertain', reason: 'decision-effect-receipt-pending' };
  }
  const outcome = recorded as Record<string, unknown>;
  if (outcome.kind === 'performed' && typeof outcome.effect === 'string') {
    return { kind: 'performed', effect: outcome.effect };
  }
  if (outcome.kind === 'uncertain' && typeof outcome.reason === 'string') {
    return { kind: 'uncertain', reason: outcome.reason };
  }
  if (outcome.kind === 'refresh_required' &&
      (outcome.packet === null || (outcome.packet && typeof outcome.packet === 'object'))) {
    return { kind: 'refresh_required', packet: outcome.packet as AgentDecisionPacket | null };
  }
  throw new Error('Invalid persisted decision outcome');
}


export function parseDecisionReceiptRecord(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid durable decision receipt');
  }
  return value as Record<string, unknown>;
}
