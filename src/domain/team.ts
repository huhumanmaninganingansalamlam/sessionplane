import type { TeamRoleSnapshot } from './role.ts';

export const TEAM_STATES = ['active', 'paused', 'complete', 'archived'] as const;
export type TeamState = (typeof TEAM_STATES)[number];

export interface TeamRecord {
  readonly teamId: string;
  readonly ownerClientId: string;
  readonly name: string | null;
  readonly objective: string | null;
  readonly teamState: TeamState;
  readonly primaryRoleId: string | null;
  readonly sharedBriefVersion: number;
  readonly externalRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TeamSnapshot {
  readonly requestOk: true;
  readonly teamId: string;
  readonly ownerClientId: string;
  readonly name: string | null;
  readonly objective: string | null;
  readonly teamState: TeamState;
  readonly primaryRoleKey: string;
  readonly sharedBriefVersion: number;
  readonly roles: readonly TeamRoleSnapshot[];
  readonly latestEventSequence: number;
}

export interface TeamListResult {
  readonly requestOk: true;
  readonly teams: readonly TeamSnapshot[];
}

