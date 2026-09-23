import { randomUUID } from 'node:crypto';

import type { SessionPlaneDatabase } from '../storage/database.ts';
import { EventRepository } from '../storage/event-repository.ts';
import { SessionRepository } from '../storage/session-repository.ts';
import { TeamRepository } from '../storage/team-repository.ts';
import { assertDomain, SessionPlaneDomainError } from '../domain/errors.ts';
import type { EventListResult } from '../domain/events.ts';
import {
  isRoleType,
  normalizeRoleKey,
  type RoleRecord,
  type RoleType,
  type TeamRoleSnapshot,
} from '../domain/role.ts';
import { isTerminalSessionState, type SessionRecord, type SessionSnapshot } from '../domain/session.ts';
import type { TeamListResult, TeamRecord, TeamSnapshot } from '../domain/team.ts';
import { PROVIDERS, type ProviderName } from '../providers/provider-adapter.ts';

export interface TeamDirectoryOptions {
  readonly now?: () => Date;
  readonly uuid?: () => string;
  readonly enabledProviders?: readonly ProviderName[];
}

export class TeamDirectory {
  readonly #database: SessionPlaneDatabase;
  readonly #teams: TeamRepository;
  readonly #sessions: SessionRepository;
  readonly #events: EventRepository;
  readonly #now: () => Date;
  readonly #uuid: () => string;
  readonly #enabledProviders: ReadonlySet<ProviderName>;

  constructor(database: SessionPlaneDatabase, options: TeamDirectoryOptions = {}) {
    this.#database = database;
    this.#teams = new TeamRepository(database.raw);
    this.#sessions = new SessionRepository(database.raw);
    this.#events = new EventRepository(database.raw);
    this.#now = options.now ?? (() => new Date());
    this.#uuid = options.uuid ?? randomUUID;
    this.#enabledProviders = new Set(options.enabledProviders ?? PROVIDERS);
  }

  createTeam(input: {
    readonly clientId: string;
    readonly name?: string | null;
    readonly objective?: string | null;
    readonly primaryRoleKey?: string;
    readonly externalRef?: string | null;
  }): TeamSnapshot {
    const primaryRoleKey = normalizeRoleKey(input.primaryRoleKey ?? 'main');
    const timestamp = this.#now().toISOString();
    const teamId = this.#uuid();
    const roleId = this.#uuid();

    this.#database.transaction(() => {
      const team: TeamRecord = {
        teamId,
        ownerClientId: requireNonEmpty(input.clientId, 'clientId'),
        name: normalizeOptionalText(input.name),
        objective: normalizeOptionalText(input.objective),
        teamState: 'active',
        primaryRoleId: null,
        sharedBriefVersion: 0,
        externalRef: normalizeOptionalText(input.externalRef),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const primaryRole: RoleRecord = {
        roleId,
        teamId,
        roleKey: primaryRoleKey,
        roleType: 'primary',
        displayName: null,
        reportsToRoleId: null,
        currentSessionId: null,
        roleState: 'active',
        createdAt: timestamp,
        retiredAt: null,
      };
      this.#teams.insertTeam(team);
      this.#teams.insertRole(primaryRole);
      this.#teams.setPrimaryRole(teamId, roleId, timestamp);
      this.#events.append({
        teamId,
        roleId,
        eventType: 'team.created',
        payload: { primaryRoleKey },
        createdAt: timestamp,
      });
    });

    return this.getTeam(teamId);
  }

  getTeam(teamId: string): TeamSnapshot {
    const team = this.#requireTeam(teamId);
    const roleRecords = this.#teams.listRoles(teamId);
    return this.#teamSnapshot(
      team,
      roleRecords,
      this.#sessions.listCurrentSessionsForTeam(teamId),
      this.#events.latestSequence(teamId),
    );
  }

  listTeams(ownerClientId: string): TeamListResult {
    const clientId = requireNonEmpty(ownerClientId, 'clientId');
    const teams = this.#teams.listTeamsByOwner(clientId);
    if (teams.length === 0) return { requestOk: true, teams: [] };

    const rolesByTeam = new Map<string, RoleRecord[]>();
    for (const role of this.#teams.listRolesForOwner(clientId)) {
      const roles = rolesByTeam.get(role.teamId) ?? [];
      roles.push(role);
      rolesByTeam.set(role.teamId, roles);
    }
    const sessions = this.#sessions.listCurrentSessionsForOwner(clientId);
    const sequences = this.#events.latestSequencesForOwner(clientId);
    return {
      requestOk: true,
      teams: teams.map((team) => this.#teamSnapshot(
        team,
        rolesByTeam.get(team.teamId) ?? [],
        sessions,
        sequences.get(team.teamId) ?? 0,
      )),
    };
  }

  #teamSnapshot(
    team: TeamRecord,
    roleRecords: readonly RoleRecord[],
    currentSessions: ReadonlyMap<string, SessionRecord>,
    latestEventSequence: number,
  ): TeamSnapshot {
    const teamId = team.teamId;
    const primaryRole = roleRecords.find((role) => role.roleId === team.primaryRoleId);
    assertDomain(
      primaryRole !== undefined,
      'internal.invariant-violation',
      `Team ${teamId} has no valid primary role`,
    );
    const roles = roleRecords.map((role): TeamRoleSnapshot => {
      const session = role.currentSessionId === null
        ? null
        : currentSessions.get(role.currentSessionId) ?? null;
      return {
        roleId: role.roleId,
        roleKey: role.roleKey,
        roleType: role.roleType,
        roleState: role.roleState,
        displayName: role.displayName,
        reportsToRoleId: role.reportsToRoleId,
        currentSessionId: role.currentSessionId,
        provider: session?.provider ?? null,
        generation: session === null ? null : Number(session.currentGeneration),
        sessionState: session?.sessionState ?? null,
        providerState: session?.providerState ?? null,
        terminal: session === null ? null : isTerminalSessionState(session.sessionState),
      };
    });
    return {
      requestOk: true,
      teamId: team.teamId,
      ownerClientId: team.ownerClientId,
      name: team.name,
      objective: team.objective,
      teamState: team.teamState,
      primaryRoleKey: primaryRole.roleKey,
      sharedBriefVersion: Number(team.sharedBriefVersion),
      roles,
      latestEventSequence,
    };
  }

  createRole(input: {
    readonly teamId: string;
    readonly roleKey: string;
    readonly roleType: string;
    readonly displayName?: string | null;
    readonly reportsToRoleKey?: string;
  }): TeamSnapshot {
    const team = this.#requireTeam(input.teamId);
    assertDomain(team.teamState === 'active', 'input.invalid', 'Roles can be added only to an active team');
    const roleKey = normalizeRoleKey(input.roleKey);
    assertDomain(isRoleType(input.roleType), 'input.invalid', `Unknown role type: ${input.roleType}`);
    assertDomain(input.roleType !== 'primary', 'input.invalid', 'A team can have exactly one primary role');
    assertDomain(
      this.#teams.getRoleByKey(team.teamId, roleKey) === null,
      'team.role-key-conflict',
      `Role key already exists in team: ${roleKey}`,
    );

    const primaryRole = team.primaryRoleId === null ? null : this.#teams.getRoleById(team.primaryRoleId);
    assertDomain(primaryRole !== null, 'internal.invariant-violation', 'Team primary role is missing');
    const reportsToRoleKey = normalizeRoleKey(input.reportsToRoleKey ?? primaryRole.roleKey);
    const reportsTo = this.#teams.getRoleByKey(team.teamId, reportsToRoleKey);
    assertDomain(reportsTo !== null, 'input.role-not-found', `Unknown reportsTo role: ${reportsToRoleKey}`);
    assertDomain(
      reportsTo.roleId === primaryRole.roleId,
      'input.invalid',
      'v1 supports only roles that report directly to the primary role',
    );

    const roleId = this.#uuid();
    const timestamp = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#teams.insertRole({
        roleId,
        teamId: team.teamId,
        roleKey,
        roleType: input.roleType as RoleType,
        displayName: normalizeOptionalText(input.displayName),
        reportsToRoleId: primaryRole.roleId,
        currentSessionId: null,
        roleState: 'active',
        createdAt: timestamp,
        retiredAt: null,
      });
      this.#events.append({
        teamId: team.teamId,
        roleId,
        eventType: 'role.created',
        payload: { roleKey, roleType: input.roleType, reportsToRoleKey },
        createdAt: timestamp,
      });
    });
    return this.getTeam(team.teamId);
  }

  retireRole(teamId: string, roleKeyValue: string): TeamSnapshot {
    const team = this.#requireTeam(teamId);
    const roleKey = normalizeRoleKey(roleKeyValue);
    const role = this.#requireRole(teamId, roleKey);
    assertDomain(role.roleType !== 'primary', 'input.invalid', 'The primary role cannot be retired');
    if (role.roleState === 'retired') {
      return this.getTeam(teamId);
    }
    const timestamp = this.#now().toISOString();
    this.#database.transaction(() => {
      if (role.currentSessionId !== null) {
        this.#sessions.transitionToCancelled(role.currentSessionId, timestamp);
      }
      this.#teams.retireRole(role.roleId, timestamp);
      this.#events.append({
        teamId: team.teamId,
        roleId: role.roleId,
        sessionId: role.currentSessionId,
        eventType: 'role.retired',
        payload: { roleKey },
        createdAt: timestamp,
      });
    });
    return this.getTeam(teamId);
  }

  updateBrief(input: {
    readonly teamId: string;
    readonly objective?: string | null;
    readonly briefText: string;
  }): TeamSnapshot {
    const team = this.#requireTeam(input.teamId);
    const briefText = requireNonEmpty(input.briefText, 'briefText');
    const version = Number(team.sharedBriefVersion) + 1;
    const timestamp = this.#now().toISOString();
    this.#database.transaction(() => {
      this.#teams.insertBrief(
        team.teamId,
        version,
        normalizeOptionalText(input.objective) ?? team.objective,
        briefText,
        timestamp,
      );
      this.#events.append({
        teamId: team.teamId,
        eventType: 'team.brief.updated',
        payload: { version },
        createdAt: timestamp,
      });
    });
    return this.getTeam(team.teamId);
  }

  createSession(input: {
    readonly teamId: string;
    readonly roleKey: string;
    readonly provider: string;
  }): SessionSnapshot {
    const team = this.#requireTeam(input.teamId);
    const role = this.#requireRole(team.teamId, normalizeRoleKey(input.roleKey));
    assertDomain(role.roleState === 'active', 'input.invalid', 'Session can be created only for an active role');
    assertDomain(
      PROVIDERS.includes(input.provider as (typeof PROVIDERS)[number]),
      'input.invalid',
      `Unsupported provider: ${input.provider}`,
    );
    const provider = input.provider as ProviderName;
    assertDomain(
      this.#enabledProviders.has(provider),
      'provider.disabled',
      'Provider is disabled by runtime configuration: ' + provider,
    );

    const timestamp = this.#now().toISOString();
    const sessionId = this.#uuid();
    const predecessorSessionId = role.currentSessionId;
    this.#database.transaction(() => {
      if (predecessorSessionId !== null) {
        this.#sessions.transitionToSuperseded(predecessorSessionId, timestamp);
      }
      this.#sessions.insertSession({
        sessionId,
        teamId: team.teamId,
        roleId: role.roleId,
        provider,
        predecessorSessionId,
        sessionState: 'created',
        providerState: 'unknown',
        observationTransport: 'unavailable',
        currentGeneration: 0,
        conversationId: null,
        pageKey: null,
        deadlineAt: null,
        nextCheckAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.#teams.setCurrentSession(role.roleId, sessionId);
      this.#events.append({
        teamId: team.teamId,
        roleId: role.roleId,
        sessionId,
        generation: 0,
        eventType: 'session.created',
        payload: { roleKey: role.roleKey, provider, predecessorSessionId },
        createdAt: timestamp,
      });
    });
    return this.getSession(sessionId);
  }

  getSession(sessionId: string): SessionSnapshot {
    const snapshot = this.#sessions.getSnapshot(sessionId);
    if (snapshot === null) {
      throw new SessionPlaneDomainError('input.session-not-found', `Unknown session: ${sessionId}`);
    }
    return snapshot;
  }

  getCurrentSession(teamId: string, roleKeyValue: string): SessionSnapshot {
    this.#requireTeam(teamId);
    const role = this.#requireRole(teamId, normalizeRoleKey(roleKeyValue));
    if (role.currentSessionId === null) {
      throw new SessionPlaneDomainError(
        'team.role-session-missing',
        `Role ${role.roleKey} has no current session`,
      );
    }
    return this.getSession(role.currentSessionId);
  }

  listSessions(ownerClientId: string): readonly SessionSnapshot[] {
    const clientId = requireNonEmpty(ownerClientId, 'clientId');
    return this.#sessions.listSnapshotsForOwner(clientId);
  }

  listEvents(teamId: string, afterSequence = 0, limit = 200): EventListResult {
    this.#requireTeam(teamId);
    return {
      requestOk: true,
      teamId,
      afterSequence,
      latestEventSequence: this.#events.latestSequence(teamId),
      events: this.#events.list(teamId, afterSequence, limit),
    };
  }

  #requireTeam(teamId: string): TeamRecord {
    const team = this.#teams.getTeam(requireNonEmpty(teamId, 'teamId'));
    if (team === null) {
      throw new SessionPlaneDomainError('input.team-not-found', `Unknown team: ${teamId}`);
    }
    return team;
  }

  #requireRole(teamId: string, roleKey: string): RoleRecord {
    const role = this.#teams.getRoleByKey(teamId, roleKey);
    if (role === null) {
      throw new SessionPlaneDomainError(
        'input.role-not-found',
        `Unknown role ${roleKey} in team ${teamId}`,
      );
    }
    return role;
  }
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new SessionPlaneDomainError('input.invalid', `${name} must not be empty`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}
