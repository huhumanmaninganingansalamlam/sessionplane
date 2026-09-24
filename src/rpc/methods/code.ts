import { z } from 'zod';

import type { ChatGptWorkflowService } from '../../core/chatgpt-workflow-service.ts';
import type { RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const RequestId = z.string().trim().min(1).max(300);
const SessionId = z.string().uuid();
const TeamId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);
const Prompt = z.string().min(1).max(200_000);
const Files = z.array(z.string().min(1).max(20_000)).max(20).optional();
const OutputPath = z.string().min(1).max(20_000).optional();
const Generation = z.number().int().positive().optional();

const GenerateFields = {
  clientId: ClientId,
  requestId: RequestId,
  prompt: Prompt,
  model: z.string().trim().min(1).max(200).nullable().optional(),
  effort: z.string().trim().min(1).max(200).nullable().optional(),
  files: Files,
  sessionDeadlineSec: z.number().int().min(1).max(86_400).default(5_400),
  outputPath: OutputPath,
  outputDir: OutputPath,
  multiZip: z.boolean().default(false),
  overwrite: z.boolean().default(false),
} as const;

const ExtractFields = {
  clientId: ClientId,
  generation: Generation,
  outputPath: OutputPath,
  outputDir: OutputPath,
  multiZip: z.boolean().default(false),
  requirePlan: z.boolean().default(false),
  overwrite: z.boolean().default(false),
} as const;

export function registerCodeMethods(
  router: RpcRouter,
  workflows: ChatGptWorkflowService,
): void {
  router.register(
    'code.generate',
    z.union([
      z.object({ ...GenerateFields, sessionId: SessionId }).strict(),
      z.object({ ...GenerateFields, teamId: TeamId, roleKey: RoleKey }).strict(),
    ]),
    (params) =>
      workflows.generateCode({
        clientId: params.clientId,
        requestId: params.requestId,
        prompt: params.prompt,
        model: params.model ?? null,
        effort: params.effort ?? null,
        surface: 'chat',
        sessionDeadlineSec: params.sessionDeadlineSec,
        ...(params.files === undefined ? {} : { files: params.files }),
        ...(params.outputPath === undefined ? {} : { outputPath: params.outputPath }),
        ...(params.outputDir === undefined ? {} : { outputDir: params.outputDir }),
        multiZip: params.multiZip,
        overwrite: params.overwrite,
        ...('sessionId' in params
          ? { sessionId: params.sessionId }
          : { teamId: params.teamId, roleKey: params.roleKey }),
      }),
  );

  router.register(
    'code.extract',
    z.union([
      z
        .object({
          ...ExtractFields,
          sessionId: SessionId,
          conversationId: z.string().min(1).max(2_000).optional(),
        })
        .strict(),
      z
        .object({
          ...ExtractFields,
          teamId: TeamId,
          roleKey: RoleKey,
          conversationId: z.string().min(1).max(2_000).optional(),
        })
        .strict(),
      z
        .object({
          ...ExtractFields,
          conversationId: z.string().min(1).max(2_000),
        })
        .strict(),
      z.object({ ...ExtractFields }).strict(),
    ]),
    (params) =>
      workflows.extractCode({
        clientId: params.clientId,
        ...(params.generation === undefined ? {} : { generation: params.generation }),
        ...(!('conversationId' in params) || params.conversationId === undefined
          ? {}
          : { conversationId: params.conversationId }),
        ...(params.outputPath === undefined ? {} : { outputPath: params.outputPath }),
        ...(params.outputDir === undefined ? {} : { outputDir: params.outputDir }),
        multiZip: params.multiZip,
        requirePlan: params.requirePlan,
        overwrite: params.overwrite,
        ...('sessionId' in params
          ? { sessionId: params.sessionId }
          : 'teamId' in params
            ? { teamId: params.teamId, roleKey: params.roleKey }
            : {}),
      }),
  );
}
