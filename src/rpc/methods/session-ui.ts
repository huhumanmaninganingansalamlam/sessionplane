import { z } from 'zod';

import type { SessionUiService } from '../../core/session-ui-service.ts';
import type { RpcRouter } from '../router.ts';

const identity = {
  clientId: z.string().trim().min(1).max(200),
  requestId: z.string().trim().min(1).max(300),
  sessionId: z.string().uuid(),
  generation: z.number().int().min(0),
} as const;

export function registerSessionUiMethods(router: RpcRouter, ui: SessionUiService): void {
  router.register('session.submission.inspect', z.object({
    ...identity,
    maxNodes: z.number().int().min(1).max(5_000).optional(),
  }).strict(), (input) => ui.inspectSubmission(input));

  router.register('session.preparation.inspect', z.object({
    ...identity,
    maxNodes: z.number().int().min(1).max(5_000).optional(),
  }).strict(), (input) => ui.inspect(input));

  router.register('session.preparation.decide', z.union([
    z.object({
      ...identity,
      decisionId: z.string().trim().min(1).max(300),
      decision: z.enum(['choose', 'reveal']),
      purpose: z.enum(['model', 'effort', 'composer', 'submit']),
      snapshotId: z.string().uuid(),
      ref: z.string().regex(/^@e\d+$/),
      value: z.number().optional(),
    }).strict(),
    z.object({
      ...identity,
      decisionId: z.string().trim().min(1).max(300),
      decision: z.literal('cancel'),
    }).strict(),
  ]), (input) => ui.decide(input));

  router.register('session.preparation.resume', z.object(identity).strict(),
    (input) => ui.resume(input));
}
