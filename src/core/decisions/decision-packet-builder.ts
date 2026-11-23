import { createHash } from 'node:crypto';
import type { SemanticInput, SemanticControlDescriptor } from '../../providers/semantic-adapter.ts';
import type { AgentDecisionPacket, AgentDecisionOption, AgentDecisionControl, AgentDecisionEvidenceSection, AgentTaskControlPurpose } from '../semantic-decision-gateway.ts';
import type { StoredDecisionEvidence } from './decision-envelope.ts';

export const DEFAULT_PACKET_PREVIEW_BYTES = 2 * 1024;
export const DEFAULT_PACKET_OPTIONS_BYTES = 4 * 1024;
export const DEFAULT_PACKET_EVIDENCE_BYTES = 4 * 1024;
export const DEFAULT_PACKET_MAX_BYTES = 12 * 1024;
export const DEFAULT_EVIDENCE_PAGE_BYTES = 12 * 1024;
export const MAX_REASON_LENGTH = 120;


export function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function preview(value: string, maxBytes = DEFAULT_PACKET_PREVIEW_BYTES): {
  text: string; bytes: number; nextCursor: number | null;
} {
  let cursor = 0;
  let bytes = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    cursor += point.length;
  }
  return { text: value.slice(0, cursor), bytes,
    nextCursor: cursor < value.length ? cursor : null };
}

export function evidenceSection(
  section: AgentDecisionEvidenceSection['section'], value: string,
): AgentDecisionEvidenceSection {
  const page = preview(value);
  return { section, totalBytes: Buffer.byteLength(value, 'utf8'), preview: page.text,
    previewBytes: page.bytes, nextCursor: page.nextCursor };
}

export function evidenceSections(
  evidence: StoredDecisionEvidence,
): readonly AgentDecisionEvidenceSection[] {
  let remaining = DEFAULT_PACKET_EVIDENCE_BYTES;
  const result: AgentDecisionEvidenceSection[] = [];
  for (const [section, value] of Object.entries(evidence) as Array<[
    AgentDecisionEvidenceSection['section'], string
  ]>) {
    if (value.length === 0) continue;
    const allowance = remaining <= 0 ? 0 : Math.min(1_024, remaining);
    const page = preview(value, allowance);
    result.push({
      section, totalBytes: Buffer.byteLength(value, 'utf8'), preview: page.text,
      previewBytes: page.bytes, nextCursor: page.nextCursor,
    });
    remaining -= page.bytes;
  }
  return result;
}

export function compactDecisionOption(option: AgentDecisionOption): AgentDecisionOption {
  if (option.inputSchema.kind !== 'option') {
    return {
      ...option, effect: preview(option.effect, 512).text,
      ...(option.control ? { control: {
        ...option.control, contextSummary: preview(option.control.contextSummary, 512).text,
      } } : {}),
    };
  }
  const selected: Array<{ value: string; enabled: boolean }> = [];
  let bytes = 0;
  for (const candidate of option.inputSchema.options) {
    const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    if (bytes + size > 1_536) break;
    selected.push(candidate);
    bytes += size;
  }
  return {
    ...option, effect: preview(option.effect, 512).text,
    inputSchema: { kind: 'option', options: selected },
    inputOptionCount: option.inputSchema.options.length,
    ...(option.control ? { control: {
      ...option.control, contextSummary: preview(option.control.contextSummary, 512).text,
    } } : {}),
  };
}

export function packetOptions(options: readonly AgentDecisionOption[]): readonly AgentDecisionOption[] {
  const selected: AgentDecisionOption[] = [];
  let bytes = 0;
  for (const option of options) {
    const compact = compactDecisionOption(option);
    const size = Buffer.byteLength(JSON.stringify(compact), 'utf8');
    if (selected.length > 0 && bytes + size > DEFAULT_PACKET_OPTIONS_BYTES) break;
    selected.push(compact);
    bytes += size;
  }
  return selected;
}

export function compactObservedControls(
  controls: readonly SemanticControlDescriptor[],
): readonly SemanticControlDescriptor[] {
  const selected: SemanticControlDescriptor[] = [];
  let bytes = 0;
  for (const control of controls) {
    const compact = { ...control,
      contextSummary: preview(control.contextSummary, 256).text,
      options: control.options.slice(0, 16),
    };
    const size = Buffer.byteLength(JSON.stringify(compact), 'utf8');
    if (selected.length > 0 && bytes + size > 2_048) break;
    selected.push(compact);
    bytes += size;
  }
  return selected;
}

export function boundedPacket(packet: AgentDecisionPacket): AgentDecisionPacket {
  let bounded = countBytes(packet);
  if (bounded.evidenceBytes <= DEFAULT_PACKET_MAX_BYTES) return bounded;
  bounded = countBytes({
    ...bounded,
    questionText: bounded.questionText === null ? null : preview(bounded.questionText, 512).text,
    permission: bounded.permission === null ? null : {
      ...bounded.permission,
      visibleSummary: preview(bounded.permission.visibleSummary, 512).text,
      argumentsSummary: bounded.permission.argumentsSummary === null ? null
        : preview(bounded.permission.argumentsSummary, 512).text,
    },
    evidenceSections: bounded.evidenceSections.map(section => ({
      ...section, preview: '', previewBytes: 0,
      nextCursor: section.totalBytes > 0 ? 0 : null,
    })),
    observedControls: [],
    evidenceBytes: 0,
  });
  return bounded;
}

export function decisionControls(
  decisionId: string, reason: string, humanOnly: boolean,
): readonly AgentDecisionControl[] {
  const controls: Array<{ purpose: AgentTaskControlPurpose; effect: string;
    risk: AgentDecisionControl['risk'] }> = [
    { purpose: 'reobserve', effect: 'Read the latest exact task and provider state', risk: 'read_only' },
    { purpose: 'wait', effect: 'Resume read-only observation without performing a provider mutation', risk: 'read_only' },
    { purpose: 'cancel', effect: 'Request cancellation of this exact task', risk: 'task_control' },
  ];
  if (!humanOnly) controls.push({
    purpose: 'request_human', effect: 'Escalate this exact decision with its evidence to a person',
    risk: 'human_escalation',
  });
  if (reason === 'managed-continuation-no-final-after-approved-continue' ||
      reason === 'managed-continuation-no-progress-policy-reached' ||
      reason === 'managed-continuation-safe-send-unavailable') {
    controls.splice(2, 0, {
      purpose: 'resume',
      effect: 'Re-enter the approved continuation flow for this exact task',
      risk: 'task_control',
    });
  }
  return controls.map(control => ({
    actionRef: `control:${decisionId}:${control.purpose}`,
    purpose: control.purpose, effect: control.effect, risk: control.risk,
    evidenceHash: sha(JSON.stringify({ decisionId, reason, purpose: control.purpose })),
    inputSchema: { kind: 'none' },
  }));
}

export function countBytes(packet: AgentDecisionPacket): AgentDecisionPacket {
  let size = Buffer.byteLength(JSON.stringify(packet));
  while (true) {
    const actual = Buffer.byteLength(JSON.stringify({ ...packet, evidenceBytes: size }));
    if (actual === size) return { ...packet, evidenceBytes: size };
    size = actual;
  }
}

export function boundedReason(reason: string | null): string {
  return reason !== null && reason.length <= MAX_REASON_LENGTH &&
    /^[a-z0-9_.:-]+$/i.test(reason) ? reason : 'semantic-evidence-requires-review';
}

export function selectionIsValid(schema: SemanticInput, value: string | undefined): boolean {
  if (schema.kind === 'none') return value === undefined;
  if (schema.kind === 'text') return typeof value === 'string' &&
    value.length > 0 && value.length <= schema.maxLength;
  return typeof value === 'string' &&
    schema.options.some(option => option.value === value && option.enabled);
}
