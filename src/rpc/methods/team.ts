import { z } from 'zod';

import type { TeamDirectory } from '../../core/team-directory.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { RpcMethodError, type RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const RequestId = z.string().trim().min(1).max(300);
const TeamId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);

export function registerTeamMethods(router: RpcRouter, directory: TeamDirectory): void {
  router.register(
    'team.create',
    z
      .object({
        clientId: ClientId,
        requestId: RequestId,
        name: z.string().max(500).nullable().optional(),
        objective: z.string().max(20_000).nullable().optional(),
        primaryRoleKey: RoleKey.optional(),
        externalRef: z.string().max(500).nullable().optional(),
      })
      .strict(),
    (params) =>
      wrapDomain(() =>
        directory.createTeam({
          clientId: params.clientId,
          ...(params.name === undefined ? {} : { name: params.name }),
          ...(params.objective === undefined ? {} : { objective: params.objective }),
          ...(params.primaryRoleKey === undefined
            ? {}
            : { primaryRoleKey: params.primaryRoleKey }),
          ...(params.externalRef === undefined ? {} : { externalRef: params.externalRef }),
        }),
      ),
  );

  router.register(
    'team.get',
    z.object({ clientId: ClientId, teamId: TeamId }).strict(),
    (params) => wrapDomain(() => directory.getTeam(params.teamId)),
  );

  router.register(
    'team.list',
    z.object({ clientId: ClientId }).strict(),
    (params) => wrapDomain(() => directory.listTeams(params.clientId)),
  );

  router.register(
    'team.role.create',
    z
      .object({
        clientId: ClientId,
        requestId: RequestId,
        teamId: TeamId,
        roleKey: RoleKey,
        roleType: z.enum(['expert', 'reviewer', 'custom']),
        displayName: z.string().max(500).nullable().optional(),
        reportsToRoleKey: RoleKey.optional(),
        provider: z.literal('chatgpt').optional(),
      })
      .strict(),
    (params) =>
      wrapDomain(() =>
        directory.createRole({
          teamId: params.teamId,
          roleKey: params.roleKey,
          roleType: params.roleType,
          ...(params.displayName === undefined ? {} : { displayName: params.displayName }),
          ...(params.reportsToRoleKey === undefined
            ? {}
            : { reportsToRoleKey: params.reportsToRoleKey }),
        }),
      ),
  );

  router.register(
    'team.role.retire',
    z
      .object({
        clientId: ClientId,
        requestId: RequestId,
        teamId: TeamId,
        roleKey: RoleKey,
      })
      .strict(),
    (params) => wrapDomain(() => directory.retireRole(params.teamId, params.roleKey)),
  );

  router.register(
    'team.brief.update',
    z
      .object({
        clientId: ClientId,
        requestId: RequestId,
        teamId: TeamId,
        objective: z.string().max(20_000).nullable().optional(),
        briefText: z.string().min(1).max(200_000),
      })
      .strict(),
    (params) =>
      wrapDomain(() =>
        directory.updateBrief({
          teamId: params.teamId,
          briefText: params.briefText,
          ...(params.objective === undefined ? {} : { objective: params.objective }),
        }),
      ),
  );
}

function wrapDomain<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SessionPlaneDomainError) {
      throw new RpcMethodError(error.errorCode, error.message, { details: error.details });
    }
    throw error;
  }
}

