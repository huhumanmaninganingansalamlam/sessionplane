import { z } from 'zod';

import type { TeamDirectory } from '../../core/team-directory.ts';
import type { ReceiptRepository } from '../../storage/receipt-repository.ts';
import type { RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const RequestId = z.string().trim().min(1).max(300);
const TeamId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);

export function registerTeamMethods(
  router: RpcRouter,
  directory: TeamDirectory,
  receipts: ReceiptRepository,
): void {
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
    (params) => {
      const command = {
        clientId: params.clientId,
        ...(params.name === undefined ? {} : { name: params.name }),
        ...(params.objective === undefined ? {} : { objective: params.objective }),
        ...(params.primaryRoleKey === undefined
          ? {}
          : { primaryRoleKey: params.primaryRoleKey }),
        ...(params.externalRef === undefined ? {} : { externalRef: params.externalRef }),
      };
      return receipts.execute({
        clientId: params.clientId,
        requestId: params.requestId,
        method: 'team.create',
        payload: command,
        operation: () => directory.createTeam(command),
      });
    },
  );

  router.register(
    'team.get',
    z.object({ clientId: ClientId, teamId: TeamId }).strict(),
    (params) => directory.getTeam(params.teamId),
  );

  router.register(
    'team.list',
    z.object({ clientId: ClientId }).strict(),
    (params) => directory.listTeams(params.clientId),
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
    (params) => {
      const command = {
        teamId: params.teamId,
        roleKey: params.roleKey,
        roleType: params.roleType,
        ...(params.displayName === undefined ? {} : { displayName: params.displayName }),
        ...(params.reportsToRoleKey === undefined
          ? {}
          : { reportsToRoleKey: params.reportsToRoleKey }),
      };
      return receipts.execute({
        clientId: params.clientId,
        requestId: params.requestId,
        method: 'team.role.create',
        payload: command,
        operation: () => directory.createRole(command),
      });
    },
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
    (params) =>
      receipts.execute({
        clientId: params.clientId,
        requestId: params.requestId,
        method: 'team.role.retire',
        payload: { teamId: params.teamId, roleKey: params.roleKey },
        operation: () => directory.retireRole(params.teamId, params.roleKey),
      }),
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
    (params) => {
      const command = {
        teamId: params.teamId,
        briefText: params.briefText,
        ...(params.objective === undefined ? {} : { objective: params.objective }),
      };
      return receipts.execute({
        clientId: params.clientId,
        requestId: params.requestId,
        method: 'team.brief.update',
        payload: command,
        operation: () => directory.updateBrief(command),
      });
    },
  );
}

