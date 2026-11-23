import type { SemanticActionCandidate, SemanticActionPurpose, SemanticInput, SemanticControlDescriptor, SemanticPermissionEvidence } from '../providers/semantic-adapter.ts';
import type { DecisionServices, DecisionRepository, ResumeDecisionInput } from './decisions/decision-services.ts';
import type { SemanticProviderRegistry } from '../providers/semantic-provider-registry.ts';
import type { SemanticContextResolver } from './semantic-exact-task-port.ts';
import { readDecisionPacket, readDecisionEvidencePage } from './decisions/decision-evidence-reader.ts';
import { requireNoProgressReview, verifyModelIntent, inspectCurrentDecisionNeed } from './decisions/decision-inspector.ts';
import { refreshDecision, refreshCurrentDecision, scheduleUnsentContinuationReview } from './decisions/decision-refresh.ts';
import { executeTaskDecisionControl } from './decisions/decision-control-executor.ts';
import { decideCurrentAction, executeProviderDecisionAction } from './decisions/decision-provider-executor.ts';

export type AgentDecisionKind =
  | 'model_choice' | 'provider_question' | 'tool_permission' | 'provider_control'
  | 'recovery_choice' | 'adapter_unsupported' | 'human_verification';

export interface AgentDecisionOption {
  readonly actionRef: string;
  readonly purpose: SemanticActionPurpose;
  readonly effect: string;
  readonly risk: SemanticActionCandidate['risk'];
  readonly evidenceHash: string;
  readonly expiresAt: string;
  readonly inputSchema: SemanticInput;
  readonly inputOptionCount?: number | undefined;
  readonly control?: SemanticControlDescriptor | undefined;
}

export type AgentTaskControlPurpose =
  | 'reobserve' | 'wait' | 'resume' | 'cancel' | 'request_human';

export interface AgentDecisionControl {
  readonly actionRef: string;
  readonly purpose: AgentTaskControlPurpose;
  readonly effect: string;
  readonly risk: 'read_only' | 'task_control' | 'human_escalation';
  readonly evidenceHash: string;
  readonly inputSchema: { readonly kind: 'none' };
}

export interface AgentDecisionEvidenceSection {
  readonly section: 'original_request' | 'current_attempt' | 'provider_question' |
    'permission' | 'partial_answer' | 'capability_issues' | 'provider_controls' |
    'decision_options';
  readonly totalBytes: number;
  readonly preview: string;
  readonly previewBytes: number;
  readonly nextCursor: number | null;
}

export interface AgentDecisionPacket {
  readonly taskId: string;
  readonly taskRevision: number;
  readonly decisionId: string;
  readonly kind: AgentDecisionKind;
  readonly reason: string;
  readonly humanOnly: boolean;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly snapshotId: string | null;
  readonly questionText: string | null;
  readonly permission: SemanticPermissionEvidence | null;
  readonly requestedModel: string | null;
  readonly options: readonly AgentDecisionOption[];
  readonly controls: readonly AgentDecisionControl[];
  readonly evidenceSections: readonly AgentDecisionEvidenceSection[];
  readonly optionCount?: number | undefined;
  readonly observedControls: readonly SemanticControlDescriptor[];
  readonly observedControlCount?: number | undefined;
  readonly resumePoint: string;
  readonly evidenceBytes: number;
}

export type AgentDecisionOutcome =
  | { readonly kind: 'performed'; readonly effect: string }
  | { readonly kind: 'refresh_required'; readonly packet: AgentDecisionPacket | null }
  | { readonly kind: 'uncertain'; readonly reason: string };


export class SemanticDecisionGateway {
  readonly #services: DecisionServices;
  constructor(input: {
    repository: DecisionRepository;
    providers: SemanticProviderRegistry;
    resolveContext: SemanticContextResolver;
    onTaskResumed?: (input: ResumeDecisionInput) => Promise<void>;
  }) {
    this.#services = {
      repository: input.repository, providers: input.providers,
      resolveContext: input.resolveContext,
      ...(input.onTaskResumed ? { onTaskResumed: input.onTaskResumed } : {}),
      get: (a,b) => this.get(a,b),
      inspect: x => this.inspect(x),
      verifyModelIntent: x => this.verifyModelIntent(x),
      refresh: x => this.refresh(x),
      scheduleUnsentContinuationReview: (a,b,c) => scheduleUnsentContinuationReview(this.#services,a,b,c),
      decideControl: x => executeTaskDecisionControl(this.#services,x),
      decide: x => this.decide(x),
    };
  }

  get(taskId: string, clientId: string): AgentDecisionPacket | null { return readDecisionPacket(this.#services, taskId, clientId); }

  readEvidence(input: {
    taskId: string; clientId: string; decisionId: string;
    section: AgentDecisionEvidenceSection['section'];
    cursor?: number; maxBytes?: number;
  }): {
    decisionId: string; section: AgentDecisionEvidenceSection['section'];
    cursor: number; text: string; returnedBytes: number;
    totalBytes: number; nextCursor: number | null;
  } { return readDecisionEvidencePage(this.#services, input); }

  async requireNoProgressReview(input: {
    taskId: string; clientId: string; attemptId: string;
    cause?: 'persistent_backend_read_throttle' | 'repeated_no_progress';
  }): Promise<AgentDecisionPacket | null> { return await requireNoProgressReview(this.#services, input); }

  async verifyModelIntent(input: {
    taskId: string; clientId: string; attemptId: string; modelIntent: string;
  }): Promise<boolean> { return await verifyModelIntent(this.#services, input); }

  async inspect(input: {
    taskId: string; clientId: string; attemptId: string;
    modelChoice?: boolean;
    modelIntent?: string;
  }): Promise<AgentDecisionPacket | null> { return await inspectCurrentDecisionNeed(this.#services, input); }

  async refresh(input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    modelChoice?: boolean; requestId?: string;
  }): Promise<AgentDecisionPacket | null> { return await refreshDecision(this.#services, input); }

  async refreshCurrent(input: {
    taskId: string; clientId: string; decisionId: string; requestId: string;
  }): Promise<AgentDecisionOutcome> { return await refreshCurrentDecision(this.#services, input); }

  async decideCurrent(input: {
    taskId: string; clientId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
  }): Promise<AgentDecisionOutcome> { return await decideCurrentAction(this.#services, input); }

  async decide(input: {
    taskId: string; clientId: string; attemptId: string; decisionId: string;
    requestId: string; actionRef: string; input?: string;
  }): Promise<AgentDecisionOutcome> { return await executeProviderDecisionAction(this.#services, input); }

}
