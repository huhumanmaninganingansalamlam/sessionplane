import { z } from 'zod';

import type { SessionUiService } from '../../core/session-ui-service.ts';
import type { RpcRouter } from '../router.ts';

const identity = {
  clientId: z.string().trim().min(1).max(200),
  sessionId: z.string().uuid(),
  generation: z.number().int().min(0),
} as const;

export function registerSessionUiMethods(router: RpcRouter, ui: SessionUiService): void {
  router.register('session.ui.inspect', z.object(identity).strict(),
    ({ sessionId, generation }) => ui.inspect(sessionId, generation));
  router.register('session.ui.action', z.object({
    ...identity,
    requestId: z.string().trim().min(1).max(300),
    snapshotId: z.string().uuid(),
    ref: z.string().regex(/^@e\d+$/),
    action: z.enum(['click', 'press']),
    key: z.enum(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Space']).optional(),
  }).strict(), (input) => ui.action(input));
}
