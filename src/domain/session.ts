export const SESSION_STATES = [
  'created',
  'ready',
  'submitting',
  'submitted',
  'observing',
  'complete',
  'cancelled',
  'superseded',
  'failed',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const PROVIDER_STATES = [
  'unknown',
  'pending',
  'generating',
  'complete',
  'blocked',
  'stopped',
  'error',
] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

export const OBSERVATION_TRANSPORTS = ['fresh', 'stale', 'deferred', 'unavailable'] as const;
export type ObservationTransport = (typeof OBSERVATION_TRANSPORTS)[number];

export interface SessionRecord {
  readonly sessionId: string;
  readonly teamId: string;
  readonly roleId: string;
  readonly provider: string;
  readonly predecessorSessionId: string | null;
  readonly sessionState: SessionState;
  readonly providerState: ProviderState;
  readonly observationTransport: ObservationTransport;
  readonly currentGeneration: number;
  readonly conversationId: string | null;
  readonly pageKey: string | null;
  readonly deadlineAt: string | null;
  readonly nextCheckAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionSnapshot {
  readonly requestOk: true;
  readonly teamId: string;
  readonly roleId: string;
  readonly roleKey: string;
  readonly sessionId: string;
  readonly predecessorSessionId: string | null;
  readonly generation: number;
  readonly sessionState: SessionState;
  readonly providerState: ProviderState;
  readonly observationTransport: ObservationTransport;
  readonly terminal: boolean;
  readonly waitExpired: boolean;
  readonly nextCheckAt: string | null;
  readonly conversationId: string | null;
  readonly submittedUserMessageId: string | null;
  readonly submittedUserTurnId: string | null;
  readonly responseMessageId: string | null;
  readonly answerText: string | null;
  readonly reason: string | null;
  readonly errorCode: string | null;
}

const TERMINAL_SESSION_STATES = new Set<SessionState>([
  'complete',
  'cancelled',
  'superseded',
  'failed',
]);

export function isTerminalSessionState(state: SessionState): boolean {
  return TERMINAL_SESSION_STATES.has(state);
}

