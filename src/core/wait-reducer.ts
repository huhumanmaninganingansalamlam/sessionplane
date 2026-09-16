import type { SessionSnapshot } from '../domain/session.ts';

export interface WaitReductionInput {
  readonly snapshot: SessionSnapshot;
  readonly clientWaitExpired: boolean;
  readonly sessionDeadlineExpired?: boolean;
  readonly freshExactProgress?: boolean;
}

export function reduceWaitState(input: WaitReductionInput): SessionSnapshot {
  const snapshot = input.snapshot;
  if (snapshot.terminal) {
    return { ...snapshot, waitExpired: false };
  }

  if (input.sessionDeadlineExpired === true && input.freshExactProgress !== true) {
    return {
      ...snapshot,
      sessionState: 'observing',
      providerState: 'unknown',
      terminal: false,
      waitExpired: input.clientWaitExpired,
      reason: 'session-deadline-unverified',
      errorCode: null,
    };
  }

  return {
    ...snapshot,
    waitExpired: input.clientWaitExpired,
  };
}

