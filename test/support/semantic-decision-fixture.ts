import type { SemanticActionCandidate, SemanticTaskContext } from
  '../../src/providers/semantic-adapter.ts';
import type { AgentDecisionPacket } from '../../src/core/semantic-decision-gateway.ts';
import {
  buildDecisionEnvelopeV2, type StoredDecisionEvidence,
} from '../../src/core/decisions/decision-envelope.ts';

/** Literal provider evidence, never an injected approval or synthetic ACK. */
export function createDecisionEvidence(overrides: Partial<StoredDecisionEvidence> = {}):
  StoredDecisionEvidence {
  return {
    original_request: '', current_attempt: '', provider_question: '',
    permission: '', partial_answer: '', capability_issues: '',
    provider_controls: '', decision_options: '[]',
    ...overrides,
  };
}
export function createProviderAction(input: Pick<SemanticActionCandidate,
  'actionRef' | 'purpose' | 'effect' | 'risk' | 'input' |
  'evidenceHash' | 'expiresAt'>): SemanticActionCandidate {
  return { ...input };
}
export function createDecisionFixture(input: {
  context: SemanticTaskContext;
  attemptId: string;
  packet: AgentDecisionPacket;
  actions?: readonly {
    purpose: SemanticActionCandidate['purpose']; snapshotId: string;
    actionRef: string; evidenceHash: string;
  }[];
  evidence?: StoredDecisionEvidence;
}) {
  return buildDecisionEnvelopeV2({
    taskContext: input.context,
    attemptId: input.attemptId,
    providerActions: input.actions ?? [],
    packet: input.packet,
    evidence: input.evidence ?? createDecisionEvidence(),
  });
}
