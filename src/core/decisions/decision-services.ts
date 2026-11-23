import type { KernelStores } from '../../storage/kernel/create-kernel-stores.ts';
import type { SemanticProviderRegistry } from '../../providers/semantic-provider-registry.ts';
import type { SemanticContextResolver } from '../semantic-exact-task-port.ts';
import type { AgentDecisionPacket, AgentDecisionOutcome, AgentDecisionControl } from '../semantic-decision-gateway.ts';
import type { ParsedDecisionEnvelope } from './decision-envelope.ts';

export type DecisionRepository = Pick<KernelStores, 'projects' | 'tasks' | 'attempts' | 'decisions' | 'timers'>;
export type ResumeDecisionInput = {
  taskId: string; clientId: string; attemptId: string;
  mode: 'wait' | 'resume' | 'provider_effect';
};
export type DecideInput = {
  taskId: string; clientId: string; attemptId: string; decisionId: string;
  requestId: string; actionRef: string; input?: string;
};
export type DecisionControlInput = DecideInput & {
  stored: ParsedDecisionEnvelope; control: AgentDecisionControl;
};
export type InspectInput = {
  taskId: string; clientId: string; attemptId: string;
  modelChoice?: boolean; modelIntent?: string;
};
export type RefreshInput = {
  taskId: string; clientId: string; attemptId: string; decisionId: string;
  modelChoice?: boolean; requestId?: string;
};
export type ModelIntentInput = {
  taskId: string; clientId: string; attemptId: string; modelIntent: string;
};

export interface DecisionServices {
  readonly repository: DecisionRepository;
  readonly providers: SemanticProviderRegistry;
  readonly resolveContext: SemanticContextResolver;
  readonly onTaskResumed?: (input: ResumeDecisionInput) => Promise<void>;
  get(taskId: string, clientId: string): AgentDecisionPacket | null;
  inspect(input: InspectInput): Promise<AgentDecisionPacket | null>;
  verifyModelIntent(input: ModelIntentInput): Promise<boolean>;
  refresh(input: RefreshInput): Promise<AgentDecisionPacket | null>;
  scheduleUnsentContinuationReview(taskId: string, clientId: string, decisionId: string): void;
  decideControl(input: DecisionControlInput): Promise<AgentDecisionOutcome>;
  decide(input: DecideInput): Promise<AgentDecisionOutcome>;
}
