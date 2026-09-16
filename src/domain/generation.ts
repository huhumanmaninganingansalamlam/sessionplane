import type {
  ObservationTransport,
  ProviderState,
  SessionState,
} from './session.ts';

export const SUBMISSION_STATES = [
  'prepared',
  'composer_filled',
  'submit_attempted',
  'submitted',
  'submission_unknown',
] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

export interface GenerationRecord {
  readonly sessionId: string;
  readonly generation: number;
  readonly teamBriefVersion: number;
  readonly promptHash: string;
  readonly submissionState: SubmissionState;
  readonly submittedUserMessageId: string | null;
  readonly submittedUserTurnId: string | null;
  readonly responseMessageId: string | null;
  readonly answerText: string | null;
  readonly completedAt: string | null;
}

export interface CurrentGenerationUpdate {
  readonly sessionState?: SessionState;
  readonly providerState?: ProviderState;
  readonly observationTransport?: ObservationTransport;
  readonly submissionState?: SubmissionState;
  readonly conversationId?: string | null;
  readonly pageKey?: string | null;
  readonly nextCheckAt?: string | null;
  readonly submittedUserMessageId?: string | null;
  readonly submittedUserTurnId?: string | null;
  readonly responseMessageId?: string | null;
  readonly answerText?: string | null;
  readonly completedAt?: string | null;
}

