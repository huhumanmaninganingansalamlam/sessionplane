export interface SessionPlaneEvent {
  readonly sequence: number;
  readonly teamId: string;
  readonly roleId: string | null;
  readonly sessionId: string | null;
  readonly generation: number | null;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface EventListResult {
  readonly requestOk: true;
  readonly teamId: string;
  readonly afterSequence: number;
  readonly latestEventSequence: number;
  readonly events: readonly SessionPlaneEvent[];
}

