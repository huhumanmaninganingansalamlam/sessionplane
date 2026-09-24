import { z } from 'zod';

import {
  ContextPackageService,
  type ContextPackageInput,
} from '../../context/context-package.ts';
import type { RpcRouter } from '../router.ts';

const ContextParams = z
  .object({
    root: z.string().min(1).max(20_000).optional(),
    includes: z.array(z.string().min(1).max(20_000)).max(2_000).optional(),
    excludes: z.array(z.string().min(1).max(20_000)).max(2_000).optional(),
    contextFile: z.string().min(1).max(20_000).optional(),
    prompt: z.string().max(500_000).optional(),
    transport: z.enum(['inline', 'upload']).optional(),
    transform: z.enum(['raw', 'repomix']).optional(),
    maxInputTokens: z.number().int().positive().max(10_000_000).optional(),
    maxFileBytes: z.number().int().positive().max(1024 * 1024 * 1024).optional(),
    maxTotalBytes: z.number().int().positive().max(2 * 1024 * 1024 * 1024).optional(),
  })
  .strict();

export function registerContextMethods(
  router: RpcRouter,
  contextPackages: ContextPackageService,
): void {
  router.register('context.dryRun', ContextParams, (params) =>
    contextPackages.dryRun(toInput(params)),
  );
  router.register('context.render', ContextParams, (params) =>
    contextPackages.render(toInput(params)),
  );
}

function toInput(params: z.infer<typeof ContextParams>): ContextPackageInput {
  return {
    ...(params.root === undefined ? {} : { root: params.root }),
    ...(params.includes === undefined ? {} : { includes: params.includes }),
    ...(params.excludes === undefined ? {} : { excludes: params.excludes }),
    ...(params.contextFile === undefined ? {} : { contextFile: params.contextFile }),
    ...(params.prompt === undefined ? {} : { prompt: params.prompt }),
    ...(params.transport === undefined ? {} : { transport: params.transport }),
    ...(params.transform === undefined ? {} : { transform: params.transform }),
    ...(params.maxInputTokens === undefined
      ? {}
      : { maxInputTokens: params.maxInputTokens }),
    ...(params.maxFileBytes === undefined ? {} : { maxFileBytes: params.maxFileBytes }),
    ...(params.maxTotalBytes === undefined ? {} : { maxTotalBytes: params.maxTotalBytes }),
  };
}

