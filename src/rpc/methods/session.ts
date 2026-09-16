import { z } from 'zod';

import type { TeamDirectory } from '../../core/team-directory.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import type { ReceiptRepository } from '../../storage/receipt-repository.ts';
import { RpcMethodError, type RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const RequestId = z.string().trim().min(1).max(300);
const TeamId = z.string().uuid();
const SessionId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);

export function registerSessionMethods(
  router: RpcRouter,
  directory: TeamDirectory,
  receipts: ReceiptRepository,
): void {
  router.register(
    'session.create',
    z
      .object({
        clientId: ClientId,
        requestId: RequestId,
        teamId: TeamId,
        roleKey: RoleKey,
        provider: z.literal('chatgpt').default('chatgpt'),
      })
      .strict(),
    (params) => {
      const command = {
        teamId: params.teamId,
        roleKey: params.roleKey,
        provider: params.provider,
      };
      return wrapDomain(() =>
        receipts.execute({
          clientId: params.clientId,
          requestId: params.requestId,
          method: 'session.create',
          payload: command,
          operation: () => directory.createSession(command),
        }),
      );
    },
  );

  router.register(
    'session.get',
    z.union([
      z.object({ clientId: ClientId, sessionId: SessionId }).strict(),
      z.object({ clientId: ClientId, teamId: TeamId, roleKey: RoleKey }).strict(),
    ]),
    (params) =>
      wrapDomain(() =>
        'sessionId' in params
          ? directory.getSession(params.sessionId)
          : directory.getCurrentSession(params.teamId, params.roleKey),
      ),
  );

  router.register(
    'session.events',
    z
      .object({
        clientId: ClientId,
        teamId: TeamId,
        afterSequence: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(1_000).default(200),
      })
      .strict(),
    (params) =>
      wrapDomain(() => directory.listEvents(params.teamId, params.afterSequence, params.limit)),
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

