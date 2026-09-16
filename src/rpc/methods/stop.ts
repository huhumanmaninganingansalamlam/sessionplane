import { z } from 'zod';

import type { StopService } from '../../core/stop-service.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { RpcMethodError, type RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const RequestId = z.string().trim().min(1).max(300);
const SessionId = z.string().uuid();
const TeamId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);

export function registerStopMethods(router: RpcRouter, stops: StopService): void {
  router.register(
    'session.stop',
    z.union([
      z
        .object({
          clientId: ClientId,
          requestId: RequestId,
          sessionId: SessionId,
        })
        .strict(),
      z
        .object({
          clientId: ClientId,
          requestId: RequestId,
          teamId: TeamId,
          roleKey: RoleKey,
        })
        .strict(),
    ]),
    async (params) =>
      await wrapDomain(async () =>
        await stops.stop({
          clientId: params.clientId,
          requestId: params.requestId,
          ...('sessionId' in params
            ? { sessionId: params.sessionId }
            : { teamId: params.teamId, roleKey: params.roleKey }),
        }),
      ),
  );
}

async function wrapDomain<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SessionPlaneDomainError) {
      throw new RpcMethodError(error.errorCode, error.message, { details: error.details });
    }
    throw error;
  }
}
