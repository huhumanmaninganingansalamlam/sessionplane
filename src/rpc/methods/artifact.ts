import { z } from 'zod';

import type { ArtifactService } from '../../core/artifact-service.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import { RpcMethodError, type RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const SessionId = z.string().uuid();
const TeamId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);
const Generation = z.number().int().positive().optional();
const ArtifactId = z.string().uuid();

const SessionSelector = z.union([
  z
    .object({
      clientId: ClientId,
      sessionId: SessionId,
      generation: Generation,
    })
    .strict(),
  z
    .object({
      clientId: ClientId,
      teamId: TeamId,
      roleKey: RoleKey,
      generation: Generation,
    })
    .strict(),
]);

export function registerArtifactMethods(router: RpcRouter, artifacts: ArtifactService): void {
  router.register('artifact.discover', SessionSelector, async (params) =>
    await wrapAsync(async () => await artifacts.discover(selector(params))),
  );

  router.register(
    'artifact.capture',
    z.union([
      z
        .object({
          clientId: ClientId,
          sessionId: SessionId,
          generation: Generation,
          artifactIds: z.array(z.string().min(1).max(500)).max(100).optional(),
        })
        .strict(),
      z
        .object({
          clientId: ClientId,
          teamId: TeamId,
          roleKey: RoleKey,
          generation: Generation,
          artifactIds: z.array(z.string().min(1).max(500)).max(100).optional(),
        })
        .strict(),
    ]),
    async (params) =>
      await wrapAsync(async () =>
        await artifacts.capture({
          ...selector(params),
          ...(params.artifactIds === undefined ? {} : { artifactIds: params.artifactIds }),
        }),
      ),
  );

  router.register('artifact.list', SessionSelector, (params) =>
    wrap(() => artifacts.list(selector(params))),
  );

  router.register(
    'artifact.get',
    z.object({ clientId: ClientId, artifactId: ArtifactId }).strict(),
    (params) => wrap(() => artifacts.get(params.artifactId)),
  );

  router.register(
    'artifact.export',
    z
      .object({
        clientId: ClientId,
        artifactId: ArtifactId,
        outputPath: z.string().min(1).max(20_000),
        overwrite: z.boolean().optional(),
      })
      .strict(),
    (params) =>
      wrap(() =>
        artifacts.export({
          artifactId: params.artifactId,
          outputPath: params.outputPath,
          ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
        }),
      ),
  );
}

function selector(
  params:
    | { readonly sessionId: string; readonly generation?: number | undefined }
    | {
        readonly teamId: string;
        readonly roleKey: string;
        readonly generation?: number | undefined;
      },
) {
  return 'sessionId' in params
    ? {
        sessionId: params.sessionId,
        ...(params.generation === undefined ? {} : { generation: params.generation }),
      }
    : {
        teamId: params.teamId,
        roleKey: params.roleKey,
        ...(params.generation === undefined ? {} : { generation: params.generation }),
      };
}

function wrap<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SessionPlaneDomainError) {
      throw new RpcMethodError(error.errorCode, error.message, { details: error.details });
    }
    throw error;
  }
}

async function wrapAsync<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SessionPlaneDomainError) {
      throw new RpcMethodError(error.errorCode, error.message, { details: error.details });
    }
    throw error;
  }
}

