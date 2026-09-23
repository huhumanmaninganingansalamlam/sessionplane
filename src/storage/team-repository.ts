import type { DatabaseSync } from 'node:sqlite';

import type { RoleRecord, RoleState, RoleType } from '../domain/role.ts';
import type { TeamRecord, TeamState } from '../domain/team.ts';

interface TeamRow {
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

interface RoleRow {
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

const TEAM_COLUMNS = `
  team_id AS teamId,
  owner_client_id AS ownerClientId,
  name,
  objective,
  team_state AS teamState,
  primary_role_id AS primaryRoleId,
  shared_brief_version AS sharedBriefVersion,
  external_ref AS externalRef,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const ROLE_COLUMNS = `
  team_roles.role_id AS roleId,
  team_roles.team_id AS teamId,
  team_roles.role_key AS roleKey,
  team_roles.role_type AS roleType,
  team_roles.display_name AS displayName,
  team_roles.reports_to_role_id AS reportsToRoleId,
  team_roles.current_session_id AS currentSessionId,
  team_roles.role_state AS roleState,
  team_roles.created_at AS createdAt,
  team_roles.retired_at AS retiredAt
`;

export class TeamRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  insertTeam(team: TeamRecord): void {
    this.#database
      .prepare(`
        INSERT INTO teams(
          team_id, owner_client_id, name, objective, team_state, primary_role_id,
          shared_brief_version, external_ref, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        team.teamId,
        team.ownerClientId,
        team.name,
        team.objective,
        team.teamState,
        team.primaryRoleId,
        team.sharedBriefVersion,
        team.externalRef,
        team.createdAt,
        team.updatedAt,
      );
  }

  insertRole(role: RoleRecord): void {
    this.#database
      .prepare(`
        INSERT INTO team_roles(
          role_id, team_id, role_key, role_type, display_name, reports_to_role_id,
          current_session_id, role_state, created_at, retired_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        role.roleId,
        role.teamId,
        role.roleKey,
        role.roleType,
        role.displayName,
        role.reportsToRoleId,
        role.currentSessionId,
        role.roleState,
        role.createdAt,
        role.retiredAt,
      );
  }

  setPrimaryRole(teamId: string, roleId: string, updatedAt: string): void {
    this.#database
      .prepare('UPDATE teams SET primary_role_id = ?, updated_at = ? WHERE team_id = ?')
      .run(roleId, updatedAt, teamId);
  }

  getTeam(teamId: string): TeamRecord | null {
    const row = this.#database
      .prepare(`SELECT ${TEAM_COLUMNS} FROM teams WHERE team_id = ?`)
      .get(teamId) as TeamRow | undefined;
    return row ?? null;
  }

  listTeamsByOwner(ownerClientId: string): readonly TeamRecord[] {
    return this.#database
      .prepare(`
        SELECT ${TEAM_COLUMNS}
        FROM teams
        WHERE owner_client_id = ?
        ORDER BY created_at, team_id
      `)
      .all(ownerClientId) as unknown as TeamRow[];
  }

  getRoleByKey(teamId: string, roleKey: string): RoleRecord | null {
    const row = this.#database
      .prepare(`SELECT ${ROLE_COLUMNS} FROM team_roles WHERE team_id = ? AND role_key = ?`)
      .get(teamId, roleKey) as RoleRow | undefined;
    return row ?? null;
  }

  getRoleById(roleId: string): RoleRecord | null {
    const row = this.#database
      .prepare(`SELECT ${ROLE_COLUMNS} FROM team_roles WHERE role_id = ?`)
      .get(roleId) as RoleRow | undefined;
    return row ?? null;
  }

  listRoles(teamId: string): readonly RoleRecord[] {
    return this.#database
      .prepare(`
        SELECT ${ROLE_COLUMNS}
        FROM team_roles
        WHERE team_id = ?
        ORDER BY created_at, role_key
      `)
      .all(teamId) as unknown as RoleRow[];
  }

  listRolesForOwner(ownerClientId: string): readonly RoleRecord[] {
    return this.#database
      .prepare(`
        SELECT ${ROLE_COLUMNS}
        FROM team_roles
        JOIN teams ON teams.team_id = team_roles.team_id
        WHERE teams.owner_client_id = ?
        ORDER BY teams.created_at, teams.team_id, team_roles.created_at, team_roles.role_key
      `)
      .all(ownerClientId) as unknown as RoleRow[];
  }

  setCurrentSession(roleId: string, sessionId: string | null): void {
    this.#database
      .prepare('UPDATE team_roles SET current_session_id = ? WHERE role_id = ?')
      .run(sessionId, roleId);
  }

  retireRole(roleId: string, retiredAt: string): void {
    this.#database
      .prepare(`
        UPDATE team_roles
        SET role_state = 'retired', retired_at = ?, current_session_id = NULL
        WHERE role_id = ?
      `)
      .run(retiredAt, roleId);
  }

  insertBrief(
    teamId: string,
    version: number,
    objective: string | null,
    briefText: string,
    createdAt: string,
  ): void {
    this.#database
      .prepare(`
        INSERT INTO team_briefs(team_id, version, objective, brief_text, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(teamId, version, objective, briefText, createdAt);
    this.#database
      .prepare(`
        UPDATE teams
        SET objective = ?, shared_brief_version = ?, updated_at = ?
        WHERE team_id = ?
      `)
      .run(objective, version, createdAt, teamId);
  }
}
