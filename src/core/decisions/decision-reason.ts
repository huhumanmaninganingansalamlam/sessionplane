import type { DecisionRecord } from '../../storage/kernel/create-kernel-stores.ts';
import type { SemanticActionCandidate, SemanticActionPurpose, SemanticObservation } from '../../providers/semantic-adapter.ts';
import type { AgentDecisionKind } from '../semantic-decision-gateway.ts';
import { parseDecisionEnvelope } from './decision-envelope.ts';
import { parseDecisionReceiptRecord } from './decision-result-receipt.ts';
import type { ParsedDecisionEnvelope } from './decision-envelope.ts';

export function priorUncertainReasoningEffort(decisions: readonly DecisionRecord[]): boolean {
  for (const row of decisions) {
    if (row.status !== 'resolved') continue;
    let stored: ParsedDecisionEnvelope;
    try { stored = parseDecisionEnvelope(row.contextJson); }
    catch { return true; } // Malformed durable decision history fails closed.
    const hasEffort = stored.purpose === 'choose_reasoning_effort' ||
      stored.actions?.some(action => action.purpose === 'choose_reasoning_effort') === true;
    if (!hasEffort) continue;
    if (row.resolutionJson === null) return true;
    let receipt: Record<string, unknown>;
    try { receipt = parseDecisionReceiptRecord(row.resolutionJson); }
    catch { return true; }
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return true;
    // Read-only refresh has no provider mutation. A failed refresh may publish
    // a fresh, *still unconsumed* option with a distinct decisionId.
    if (receipt.kind === 'read_only_refresh' && !row.actionConsumed) continue;
    if (receipt.kind !== 'semantic_action' || !receipt.outcome ||
        typeof receipt.outcome !== 'object') return true;
    const outcome = receipt.outcome as { kind?: unknown; effect?: unknown };
    if (outcome.kind === 'performed' && row.actionConsumed &&
        outcome.effect === 'reasoning_effort_selected') continue;
    const kind = outcome.kind;
    if (kind === 'refresh_required' && !row.actionConsumed) continue;
    return true; // uncertain, malformed or action-consumption mismatch
  }
  return false;
}

export function matchingActions(
  observation: SemanticObservation, purposes: readonly SemanticActionPurpose[],
): readonly SemanticActionCandidate[] {
  return observation.actions.filter(action => purposes.includes(action.purpose));
}

export function decisionKind(
  observation: SemanticObservation, modelChoice: boolean,
): AgentDecisionKind | null {
  switch (observation.blocker) {
    case 'provider_question': return 'provider_question';
    case 'provider_permission': return 'tool_permission';
    case 'provider_control': return 'provider_control';
    case 'provider_retry':
    case 'rate_limit': return 'recovery_choice';
    case 'human_verification': return 'human_verification';
    case 'unsupported': return 'adapter_unsupported';
    case 'none': return modelChoice ? 'model_choice' : null;
  }
}
