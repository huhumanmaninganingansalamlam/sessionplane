import type { SessionUiService } from '../../core/session-ui-service.ts';
import { z } from 'zod';
import type { ConversationCleanupService } from '../../core/conversation-cleanup-service.ts';

import type { TeamDirectory } from '../../core/team-directory.ts';
import type { ReceiptRepository } from '../../storage/receipt-repository.ts';
import { PROVIDERS } from '../../providers/provider-adapter.ts';
import type { RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const RequestId = z.string().trim().min(1).max(300);
const TeamId = z.string().uuid();
const SessionId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);

export function registerSessionMethods(
  router: RpcRouter,
  directory: TeamDirectory,
  receipts: ReceiptRepository,
  cleanup: ConversationCleanupService,
  ui?: SessionUiService,
): void {
  router.register('session.close_pages', z.object({
    clientId: ClientId, sessionId: SessionId, generation: z.number().int().positive(),
    conversationId: z.string().min(1).max(300), evidenceRef: z.string().trim().min(1).max(2000),
  }).strict(), (input) => cleanup.closePages(input));
  router.register('session.delete', z.object({
    clientId: ClientId, requestId: RequestId, sessionId: SessionId,
    generation: z.number().int().positive(), conversationId: z.string().min(1).max(300),
    outputsRetrieved: z.literal(true),
    discardRetiredObservation: z.object({ conversationId: z.string().min(1).max(300), evidenceRef: z.string().trim().min(1).max(2000) }).strict().optional().describe('Explicitly authorize permanent deletion of this exact obsolete conversation after observation retirement and role displacement/retirement. Preserves unresolved generation records; never means its answer was retrieved.'),
  }).strict(), (input) => cleanup.delete(input));
  router.register(
    'session.create',
    z
      .object({
        clientId: ClientId,
        requestId: RequestId,
        teamId: TeamId,
        roleKey: RoleKey,
        provider: z.enum(PROVIDERS).default('chatgpt'),
      })
      .strict(),
    (params) => {
      const command = {
        teamId: params.teamId,
        roleKey: params.roleKey,
        provider: params.provider,
      };
      return cleanup.replace({
        clientId: params.clientId, requestId: params.requestId, method: 'session.create',
        payload: command, ...command,
      });
    },
  );

  router.register(
    'session.get',
    z.union([
      z.object({ clientId: ClientId, sessionId: SessionId }).strict(),
      z.object({ clientId: ClientId, teamId: TeamId, roleKey: RoleKey }).strict(),
    ]),
    async (params) => {
      const session = 'sessionId' in params ? directory.getSession(params.sessionId)
        : directory.getCurrentSession(params.teamId, params.roleKey);
      return { ...session, ...(ui && session.provider === 'chatgpt'
        ? { observedSurface: await ui.inspectSurface(session) } : {}) };
    },
  );

  router.register(
    'session.list',
    z.object({ clientId: ClientId }).strict(),
    (params) => ({ requestOk: true, sessions: directory.listSessions(params.clientId) }),
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
    (params) => directory.listEvents(params.teamId, params.afterSequence, params.limit),
  );
}

