import { z } from 'zod';

import type { TeamDirectory } from '../../core/team-directory.ts';
import { SessionPlaneDomainError } from '../../domain/errors.ts';
import type { SessionSnapshot } from '../../domain/session.ts';
import type { ActorScheduler } from '../../scheduler/actor-scheduler.ts';
import { RpcMethodError, type RpcRouter } from '../router.ts';

const ClientId = z.string().trim().min(1).max(200);
const TeamId = z.string().uuid();
const SessionId = z.string().uuid();
const RoleKey = z.string().trim().min(1).max(80);
const WaitMs = z.number().int().min(0).max(120_000).default(30_000);

export function registerWaitMethods(
  router: RpcRouter,
  directory: TeamDirectory,
  scheduler: ActorScheduler,
): void {
  router.register(
    'session.wait',
    z
      .union([
        z
          .object({
            clientId: ClientId,
            sessionId: SessionId,
            generation: z.number().int().nonnegative().optional(),
            afterEventSequence: z.number().int().nonnegative().optional(),
            waitMs: WaitMs,
          })
          .strict(),
        z
          .object({
            clientId: ClientId,
            teamId: TeamId,
            roleKey: RoleKey,
            generation: z.number().int().nonnegative().optional(),
            afterEventSequence: z.number().int().nonnegative().optional(),
            waitMs: WaitMs,
          })
          .strict(),
      ]),
    async (params) =>
      await wrapDomainAsync(async () => {
        const snapshot =
          'sessionId' in params
            ? directory.getSession(params.sessionId)
            : directory.getCurrentSession(params.teamId, params.roleKey);
        return await scheduler.waitSession(snapshot.sessionId, {
          waitMs: params.waitMs,
          ...(params.generation === undefined
            ? {}
            : { expectedGeneration: params.generation }),
          ...(params.afterEventSequence === undefined
            ? {}
            : { afterRevision: params.afterEventSequence }),
        });
      }),
  );

  router.register(
    'team.wait',
    z
      .object({
        clientId: ClientId,
        teamId: TeamId,
        roleKeys: z.array(RoleKey).min(1).max(64).optional(),
        until: z.enum(['any_change', 'primary_terminal', 'all_selected_terminal']),
        afterEventSequence: z.number().int().nonnegative().optional(),
        waitMs: WaitMs,
      })
      .strict(),
    async (params) =>
      await wrapDomainAsync(async () => {
        const deadline = Date.now() + params.waitMs;
        let team = directory.getTeam(params.teamId);
        let cursor = params.afterEventSequence ?? team.latestEventSequence;

        for (;;) {
          const selected = directory.selectCurrentSessions(team, params.roleKeys);
          const conditionMet = evaluateTeamCondition(
            params.until,
            team.primaryRoleKey,
            selected,
          );
          const changed = team.latestEventSequence > cursor;
          if (conditionMet || (params.until === 'any_change' && changed)) {
            return teamWaitResult(team.teamId, params.until, false, team.latestEventSequence, selected);
          }

          const remaining = Math.max(0, deadline - Date.now());
          if (remaining === 0) {
            return teamWaitResult(team.teamId, params.until, true, team.latestEventSequence, selected);
          }

          const controller = new AbortController();
          const waits = selected.map((snapshot) =>
            scheduler.waitSession(snapshot.sessionId, {
              waitMs: remaining,
              afterRevision: cursor,
              expectedGeneration: snapshot.generation,
              signal: controller.signal,
            }),
          );
          const wake = await Promise.race(waits);
          controller.abort();
          team = directory.getTeam(params.teamId);
          const observedChange = !wake.waitExpired || team.latestEventSequence > cursor;
          if (params.until === 'any_change' && observedChange) {
            return teamWaitResult(
              team.teamId,
              params.until,
              false,
              team.latestEventSequence,
              directory.selectCurrentSessions(team, params.roleKeys),
            );
          }
          if (wake.waitExpired && team.latestEventSequence <= cursor) {
            return teamWaitResult(
              team.teamId,
              params.until,
              true,
              team.latestEventSequence,
              directory.selectCurrentSessions(team, params.roleKeys),
            );
          }
          cursor = Math.max(cursor, wake.latestEventSequence, team.latestEventSequence);
        }
      }),
  );
}

function evaluateTeamCondition(
  until: 'any_change' | 'primary_terminal' | 'all_selected_terminal',
  primaryRoleKey: string,
  sessions: readonly SessionSnapshot[],
): boolean {
  if (until === 'all_selected_terminal') {
    return sessions.every((snapshot) => snapshot.terminal);
  }
  if (until === 'primary_terminal') {
    return sessions.some((snapshot) => snapshot.roleKey === primaryRoleKey && snapshot.terminal);
  }
  return sessions.every((snapshot) => snapshot.terminal);
}

function teamWaitResult(
  teamId: string,
  until: string,
  waitExpired: boolean,
  latestEventSequence: number,
  sessions: readonly SessionSnapshot[],
): Readonly<Record<string, unknown>> {
  return {
    requestOk: true,
    teamId,
    until,
    waitExpired,
    latestEventSequence,
    sessions,
  };
}

async function wrapDomainAsync<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SessionPlaneDomainError) {
      throw new RpcMethodError(error.errorCode, error.message, { details: error.details });
    }
    throw error;
  }
}

