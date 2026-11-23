import { SessionPlaneDomainError } from '../../domain/errors.ts';
import type { AgentDecisionPacket, AgentDecisionEvidenceSection } from '../semantic-decision-gateway.ts';
import { parseDecisionEnvelope, projectHistoricalDecisionForRead } from './decision-envelope.ts';
import { preview, DEFAULT_EVIDENCE_PAGE_BYTES } from './decision-packet-builder.ts';
import type { DecisionServices } from './decision-services.ts';

export function readDecisionPacket(services: DecisionServices, taskId: string, clientId: string): AgentDecisionPacket | null {
    const full = services.repository.tasks.readTaskAggregate(taskId, clientId);
    if (full.task.pendingDecisionId === null) return null;
    const decision = full.decisions.find(row => row.decisionId === full.task.pendingDecisionId);
    if (!decision || decision.status !== 'pending') {
      throw new Error('Durable pending decision is missing');
    }
    const envelope = parseDecisionEnvelope(decision.contextJson);
    return { ...projectHistoricalDecisionForRead(envelope, true),
      taskRevision: full.task.revision };
  }

export function readDecisionEvidencePage(services: DecisionServices, input: {
    taskId: string; clientId: string; decisionId: string;
    section: AgentDecisionEvidenceSection['section'];
    cursor?: number; maxBytes?: number;
  }): {
    decisionId: string; section: AgentDecisionEvidenceSection['section'];
    cursor: number; text: string; returnedBytes: number;
    totalBytes: number; nextCursor: number | null;
  } {
    const full = services.repository.tasks.readTaskAggregate(input.taskId, input.clientId);
    const row = full.decisions.find(decision => decision.decisionId === input.decisionId);
    if (!row) throw new SessionPlaneDomainError('stale_decision', 'Unknown decision identity');
    const stored = parseDecisionEnvelope(row.contextJson);
    const value = stored.evidence?.[input.section] ?? '';
    const cursor = input.cursor ?? 0;
    const maxBytes = input.maxBytes ?? DEFAULT_EVIDENCE_PAGE_BYTES;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > value.length ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 64 * 1024) {
      throw new SessionPlaneDomainError('invalid_request', 'Invalid decision evidence page');
    }
    const page = preview(value.slice(cursor), maxBytes);
    return {
      decisionId: input.decisionId, section: input.section, cursor,
      text: page.text, returnedBytes: page.bytes,
      totalBytes: Buffer.byteLength(value, 'utf8'),
      nextCursor: page.nextCursor === null ? null : cursor + page.nextCursor,
    };
  }
