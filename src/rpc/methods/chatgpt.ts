import { z } from 'zod';

import type { ProjectSourceService } from '../../core/project-source-service.ts';
import type { RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const RequestId = z.string().trim().min(1).max(300);

export function registerChatGptMethods(
  router: RpcRouter,
  projectSources: ProjectSourceService,
): void {
  router.register(
    'chatgpt.projectSources.list',
    z.object({ clientId: ClientId, projectUrl: z.string().min(1).max(20_000) }).strict(),
    (params) => projectSources.list(params.projectUrl),
  );

  router.register(
    'chatgpt.projectSources.add',
    z
      .object({
        clientId: ClientId,
        requestId: RequestId,
        projectUrl: z.string().min(1).max(20_000),
        files: z.array(z.string().min(1).max(20_000)).min(1).max(50),
        dryRun: z.boolean().default(false),
      })
      .strict(),
    (params) =>
      projectSources.add({
        projectUrl: params.projectUrl,
        files: params.files,
        dryRun: params.dryRun,
      }),
  );
}
