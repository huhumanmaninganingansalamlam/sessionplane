import { z } from 'zod';

import type { SubmissionService } from '../../core/submission-service.ts';
import type { RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const RequestId = z.string().trim().min(1).max(300);
const SessionId = z.string().uuid();
const TeamId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);
const Prompt = z.string().min(1).max(200_000);
const Model = z.string().trim().min(1).max(200).nullable().optional();
const Effort = z.string().trim().min(1).max(200).nullable().optional();
const Surface = z.string().trim().min(1).max(200).nullable().optional();
const Files = z.array(z.string().min(1).max(20_000)).max(20).optional();
const SessionDeadlineSec = z.number().int().min(1).max(86_400).default(5_400);

export function registerSendMethods(router: RpcRouter, submissions: SubmissionService): void {
  router.register(
    'session.send',
    z.union([
      z
        .object({
          clientId: ClientId,
          requestId: RequestId,
          sessionId: SessionId,
          prompt: Prompt,
          model: Model,
          effort: Effort,
          surface: Surface,
          assistedPreparation: z.boolean().optional(),
          files: Files,
          sessionDeadlineSec: SessionDeadlineSec,
        })
        .strict(),
      z
        .object({
          clientId: ClientId,
          requestId: RequestId,
          teamId: TeamId,
          roleKey: RoleKey,
          prompt: Prompt,
          model: Model,
          effort: Effort,
          surface: Surface,
          assistedPreparation: z.boolean().optional(),
          files: Files,
          sessionDeadlineSec: SessionDeadlineSec,
        })
        .strict(),
    ]),
    (params) =>
      submissions.send({
        clientId: params.clientId,
        requestId: params.requestId,
        prompt: params.prompt,
        sessionDeadlineSec: params.sessionDeadlineSec,
        ...(params.model === undefined ? {} : { model: params.model }),
        ...(params.effort === undefined ? {} : { effort: params.effort }),
        ...(params.surface === undefined ? {} : { surface: params.surface }),
        ...(params.assistedPreparation === true ? { assistedPreparation: true } : {}),
        ...(params.files === undefined ? {} : { files: params.files }),
        ...('sessionId' in params
          ? { sessionId: params.sessionId }
          : { teamId: params.teamId, roleKey: params.roleKey }),
      }),
  );
}
