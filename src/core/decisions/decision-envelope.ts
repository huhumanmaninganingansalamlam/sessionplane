import type { SemanticActionPurpose, SemanticTaskContext } from '../../providers/semantic-adapter.ts';
import type {
  AgentDecisionOption, AgentDecisionPacket, AgentDecisionEvidenceSection,
} from '../semantic-decision-gateway.ts';

export interface StoredProviderAction {
  readonly purpose: SemanticActionPurpose;
  readonly snapshotId: string;
  readonly actionRef: string;
  readonly evidenceHash: string;
}

export interface StoredDecisionEvidence {
  readonly original_request: string;
  readonly current_attempt: string;
  readonly provider_question: string;
  readonly permission: string;
  readonly partial_answer: string;
  readonly capability_issues: string;
  readonly provider_controls: string;
  readonly decision_options: string;
}

/** Only one current wire shape: no v0.4.108 single-action aliases or
 * duplicated option list on new durable writes. Complete choices are in
 * evidence.decision_options, separate from the bounded packet preview.
 */
export interface DecisionEnvelopeV2 {
  readonly schemaVersion: 2;
  readonly taskContext: SemanticTaskContext;
  readonly attemptId: string;
  readonly providerActions: readonly StoredProviderAction[];
  readonly evidence: StoredDecisionEvidence;
  readonly packet: AgentDecisionPacket;
}

export interface DecisionEnvelopeV1 {
  readonly kind: 'semantic_action';
  readonly context: SemanticTaskContext;
  readonly attemptId: string;
  readonly purpose?: SemanticActionPurpose | null;
  readonly snapshotId?: string | null;
  readonly actionRef?: string | null;
  readonly evidenceHash?: string | null;
  readonly actions?: readonly StoredProviderAction[];
  readonly allOptions?: readonly AgentDecisionOption[];
  readonly reconcilesUncertainReasoningEffort?: boolean;
  readonly evidence?: StoredDecisionEvidence;
  readonly packet: AgentDecisionPacket;
}

/** Read model unifies historical JSON only after version-appropriate decoding.
 * These aliases are never written into a v2 SQLite row.
 */
export interface ParsedDecisionEnvelope {
  readonly schemaVersion: 1 | 2;
  readonly context: SemanticTaskContext;
  readonly attemptId: string;
  readonly purpose: SemanticActionPurpose | null;
  readonly snapshotId: string | null;
  readonly actionRef: string | null;
  readonly evidenceHash: string | null;
  readonly actions: readonly StoredProviderAction[];
  readonly allOptions: readonly AgentDecisionOption[];
  readonly evidence: StoredDecisionEvidence;
  readonly packet: AgentDecisionPacket;
  readonly reconcilesUncertainReasoningEffort: boolean;
}

const EVIDENCE_SECTIONS = [
  'original_request', 'current_attempt', 'provider_question', 'permission',
  'partial_answer', 'capability_issues', 'provider_controls', 'decision_options',
] as const satisfies readonly AgentDecisionEvidenceSection['section'][];

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid decision ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(`Invalid decision ${label}`);
  return value;
}

function context(value: unknown): SemanticTaskContext {
  const r = object(value, 'task context');
  string(r.projectId, 'projectId');
  string(r.slotId, 'slotId');
  string(r.taskId, 'taskId');
  if (typeof r.slotRevision !== 'number' || !Number.isSafeInteger(r.slotRevision) ||
    r.slotRevision < 1) throw new Error('Invalid decision slotRevision');
  for (const name of ['providerConversationId', 'submittedUserMessageId', 'submittedUserTurnId']) {
    if (r[name] !== null && typeof r[name] !== 'string') {
      throw new Error(`Invalid decision ${name}`);
    }
  }
  if (r.pageLease !== null) object(r.pageLease, 'pageLease');
  return r as unknown as SemanticTaskContext;
}

function packet(value: unknown, legacy = false): AgentDecisionPacket {
  const p = object(value, 'packet');
  string(p.taskId, 'packet taskId');
  string(p.decisionId, 'packet decisionId');
  string(p.kind, 'packet kind');
  if (!Array.isArray(p.options) ||
      (!legacy && !Array.isArray(p.controls))) {
    throw new Error('Invalid decision packet options/controls');
  }
  return {
    ...p, controls: Array.isArray(p.controls) ? p.controls : [],
    evidenceSections: Array.isArray(p.evidenceSections) ? p.evidenceSections : [],
    observedControls: Array.isArray(p.observedControls) ? p.observedControls : [],
  } as unknown as AgentDecisionPacket;
}

function providerActions(value: unknown): readonly StoredProviderAction[] {
  if (!Array.isArray(value)) throw new Error('Invalid decision providerActions');
  return value.map((action) => {
    const a = object(action, 'provider action');
    for (const key of ['purpose', 'snapshotId', 'actionRef', 'evidenceHash']) {
      string(a[key], key);
    }
    return a as unknown as StoredProviderAction;
  });
}

function evidence(value: unknown, legacy = false): StoredDecisionEvidence {
  const e = object(value, 'evidence');
  for (const section of EVIDENCE_SECTIONS) {
    if (typeof e[section] !== 'string' &&
        !(legacy && e[section] === undefined)) {
      throw new Error(`Invalid decision evidence section: ${section}`);
    }
  }
  if (!legacy) return e as unknown as StoredDecisionEvidence;
  return Object.fromEntries(EVIDENCE_SECTIONS.map(section =>
    [section, typeof e[section] === 'string' ? e[section] : (section === 'decision_options' ? '[]' : '')]
  )) as unknown as StoredDecisionEvidence;
}

function fullOptions(value: string): readonly AgentDecisionOption[] {
  let decoded: unknown;
  try { decoded = JSON.parse(value); }
  catch { throw new Error('Invalid durable decision option JSON'); }
  if (!Array.isArray(decoded)) throw new Error('Invalid durable decision option catalogue');
  return decoded.map((option) => {
    const o = object(option, 'option');
    for (const field of ['actionRef', 'purpose', 'effect', 'risk', 'evidenceHash', 'expiresAt']) {
      string(o[field], 'option ' + field);
    }
    const input = object(o.inputSchema, 'option inputSchema');
    if (!['none', 'text', 'option'].includes(String(input.kind))) {
      throw new Error('Invalid decision option inputSchema.kind');
    }
    return o as unknown as AgentDecisionOption;
  });
}

const emptyEvidence: StoredDecisionEvidence = Object.freeze({
  original_request: '', current_attempt: '', provider_question: '',
  permission: '', partial_answer: '', capability_issues: '',
  provider_controls: '', decision_options: '[]',
});

function decodeV1(value: unknown): ParsedDecisionEnvelope {
  const r = object(value, 'legacy envelope');
  if (r.kind !== 'semantic_action' || r.schemaVersion !== undefined) {
    throw new Error('Unsupported legacy decision envelope');
  }
  const taskContext = context(r.context);
  const currentPacket = packet(r.packet, true);
  if (taskContext.taskId !== currentPacket.taskId) {
    throw new Error('Historical decision Task binding mismatch');
  }
  const legacyEvidence = r.evidence === undefined
    ? emptyEvidence : evidence(r.evidence, true);
  const legacyActions = r.actions === undefined ? [] : providerActions(r.actions);
  const legacyOptions = Array.isArray(r.allOptions)
    ? r.allOptions as AgentDecisionOption[]
    : currentPacket.options;
  const purpose = r.purpose === undefined || r.purpose === null ? null
    : string(r.purpose, 'legacy purpose') as SemanticActionPurpose;
  const maybe = (key: string) => r[key] === undefined || r[key] === null
    ? null : string(r[key], key);
  return {
    schemaVersion: 1, context: taskContext,
    attemptId: string(r.attemptId, 'attemptId'),
    purpose, snapshotId: maybe('snapshotId'),
    actionRef: maybe('actionRef'), evidenceHash: maybe('evidenceHash'),
    actions: legacyActions, allOptions: legacyOptions,
    evidence: legacyEvidence, packet: currentPacket,
    reconcilesUncertainReasoningEffort: r.reconcilesUncertainReasoningEffort === true,
  };
}

function decodeV2(value: unknown): ParsedDecisionEnvelope {
  const r = object(value, 'v2 envelope');
  if (r.schemaVersion !== 2 || 'context' in r || 'actions' in r ||
      'purpose' in r || 'snapshotId' in r || 'actionRef' in r ||
      'evidenceHash' in r || 'allOptions' in r) {
    throw new Error('Invalid v2 decision envelope: legacy fields are forbidden');
  }
  const taskContext = context(r.taskContext);
  const currentPacket = packet(r.packet);
  if (taskContext.taskId !== currentPacket.taskId) {
    throw new Error('Decision v2 Task binding mismatch');
  }
  const safeEvidence = evidence(r.evidence);
  const actions = providerActions(r.providerActions);
  const options = fullOptions(safeEvidence.decision_options);
  // Every advertised executable option must be bound to the exact durable
  // action catalogue (preview clipping cannot create executable references).
  for (const action of actions) {
    if (!options.some((option) => option.actionRef === action.actionRef &&
        option.purpose === action.purpose &&
        option.evidenceHash === action.evidenceHash)) {
      throw new Error('Decision v2 provider action has no matching full option');
    }
  }
  return {
    schemaVersion: 2, context: taskContext,
    attemptId: string(r.attemptId, 'attemptId'),
    purpose: null, snapshotId: null, actionRef: null, evidenceHash: null,
    actions, allOptions: options, evidence: safeEvidence, packet: currentPacket,
    reconcilesUncertainReasoningEffort:
      currentPacket.reason === 'reasoning-effort-current-state-reobserved',
  };
}

export function parseDecisionEnvelopeV1(raw: string): ParsedDecisionEnvelope {
  return decodeV1(JSON.parse(raw) as unknown);
}

export function parseDecisionEnvelopeV2(raw: string): ParsedDecisionEnvelope {
  return decodeV2(JSON.parse(raw) as unknown);
}

export function parseDecisionEnvelope(raw: string): ParsedDecisionEnvelope {
  const value: unknown = JSON.parse(raw);
  const r = object(value, 'envelope');
  if (r.schemaVersion === 2) return decodeV2(value);
  if (r.schemaVersion !== undefined) throw new Error('Unsupported decision envelope version');
  return decodeV1(value);
}

export function buildDecisionEnvelopeV2(input: Omit<DecisionEnvelopeV2, 'schemaVersion'>): DecisionEnvelopeV2 {
  const document: DecisionEnvelopeV2 = { schemaVersion: 2, ...input };
  // Fail before a durable write if the full, exact option/ACK lineage is lost.
  parseDecisionEnvelopeV2(JSON.stringify(document));
  return document;
}

/** v1 pending actions are stale after upgrade; successful v1 receipts remain
 * readable. This is an authorization projection, not an implicit DB mutation.
 */
export function reconcilePendingDecisionV1(
  taskId: string, decisionId: string, envelope: ParsedDecisionEnvelope,
): 'safe_v2' | 'read_only_refresh_required' {
  if (envelope.context.taskId !== taskId || envelope.packet.decisionId !== decisionId) {
    throw new Error('Decision reconciliation identity mismatch');
  }
  return envelope.schemaVersion === 1 ? 'read_only_refresh_required' : 'safe_v2';
}

export function projectHistoricalDecisionForRead(
  envelope: ParsedDecisionEnvelope, pending: boolean,
): AgentDecisionPacket {
  if (envelope.schemaVersion !== 1 || !pending) return envelope.packet;
  return {
    ...envelope.packet,
    kind: 'recovery_choice',
    reason: 'historical-decision-read-only-refresh-required',
    options: [], optionCount: 0,
    controls: [{
      actionRef: `control:${envelope.packet.decisionId}:reobserve`,
      purpose: 'reobserve', effect: 'Refresh the historical exact Task evidence',
      risk: 'read_only', evidenceHash: '',
      inputSchema: { kind: 'none' },
    }],
  };
}
