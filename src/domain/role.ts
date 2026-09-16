import { SessionPlaneDomainError } from './errors.ts';

export const ROLE_TYPES = ['primary', 'expert', 'reviewer', 'custom'] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

export const ROLE_STATES = ['active', 'sleeping', 'retired', 'blocked'] as const;
export type RoleState = (typeof ROLE_STATES)[number];

export interface RoleRecord {
  readonly roleId: string;
  readonly teamId: string;
  readonly roleKey: string;
  readonly roleType: RoleType;
  readonly displayName: string | null;
  readonly reportsToRoleId: string | null;
  readonly currentSessionId: string | null;
  readonly roleState: RoleState;
  readonly createdAt: string;
  readonly retiredAt: string | null;
}

export interface TeamRoleSnapshot {
  readonly roleId: string;
  readonly roleKey: string;
  readonly roleType: RoleType;
  readonly roleState: RoleState;
  readonly displayName: string | null;
  readonly reportsToRoleId: string | null;
  readonly currentSessionId: string | null;
  readonly provider: string | null;
  readonly generation: number | null;
  readonly sessionState: string | null;
  readonly providerState: string | null;
  readonly terminal: boolean | null;
}

const ROLE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export function normalizeRoleKey(value: string): string {
  const roleKey = value.trim();
  if (roleKey.length === 0 || roleKey.length > 80 || !ROLE_KEY_PATTERN.test(roleKey)) {
    throw new SessionPlaneDomainError(
      'input.invalid',
      'roleKey must be a lowercase stable key such as main, expert.backend, or reviewer.security',
    );
  }
  return roleKey;
}

export function isRoleType(value: string): value is RoleType {
  return (ROLE_TYPES as readonly string[]).includes(value);
}

