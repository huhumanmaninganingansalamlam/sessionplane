import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
  readonly primaryRoleKey: string;
  readonly roles: readonly Array<{
    readonly roleKey: string;
    readonly currentSessionId: string | null;
  }>;
  readonly latestEventSequence: number;
}

interface SessionSnapshot {
  readonly sessionId: string;
  readonly predecessorSessionId: string | null;
  readonly sessionState: string;
  readonly teamId: string;
  readonly roleKey: string;
}

test('teams, role isolation, session replacement, events, and restart restoration are durable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-team-session-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Review complete';
  let service = await startCore({ config, startBrowser: false, providerAdapters: [fake] });

  try {
    const teamA = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'client-a',
      requestId: 'team-a',
      name: 'Team A',
      objective: 'Implement and review',
      primaryRoleKey: 'main',
    });
    assert.equal(teamA.primaryRoleKey, 'main');
    const teamAReplay = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'client-a',
      requestId: 'team-a',
      name: 'Team A',
      objective: 'Implement and review',
      primaryRoleKey: 'main',
    });
    assert.equal(teamAReplay.teamId, teamA.teamId);

    for (const [roleKey, roleType] of [
      ['expert.backend', 'expert'],
      ['expert.database', 'expert'],
      ['reviewer.security', 'reviewer'],
    ] as const) {
      await rpc(config.socketPath, 'team.role.create', {
        clientId: 'client-a',
        requestId: `role-${roleKey}`,
        teamId: teamA.teamId,
        roleKey,
        roleType,
        reportsToRoleKey: 'main',
        provider: 'chatgpt',
      });
    }

    const firstBackend = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'client-a',
      requestId: 'backend-session-1',
      teamId: teamA.teamId,
      roleKey: 'expert.backend',
      provider: 'chatgpt',
    });
    const mainSession = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'client-a',
      requestId: 'main-session-1',
      teamId: teamA.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });

    const aggregate = await rpc<TeamSnapshot>(config.socketPath, 'team.get', {
      clientId: 'client-a',
      teamId: teamA.teamId,
    });
    assert.deepEqual(
      aggregate.roles.map((role) => role.roleKey).sort(),
      ['expert.backend', 'expert.database', 'main', 'reviewer.security'],
    );
    assert.equal(
      aggregate.roles.find((role) => role.roleKey === 'expert.backend')?.currentSessionId,
      firstBackend.sessionId,
    );

    const selected = await rpc<{ readonly waitExpired: boolean; readonly sessions: readonly SessionSnapshot[] }>(
      config.socketPath,
      'team.wait',
      {
        clientId: 'client-a',
        teamId: teamA.teamId,
        roleKeys: ['expert.backend', 'main', 'expert.backend'],
        until: 'all_selected_terminal',
        waitMs: 0,
      },
    );
    assert.equal(selected.waitExpired, true);
    assert.deepEqual(selected.sessions.map((session) => session.sessionId), [
      firstBackend.sessionId,
      mainSession.sessionId,
    ]);

    const teamB = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'client-b',
      requestId: 'team-b',
      name: 'Team B',
      primaryRoleKey: 'main',
    });
    await rpc(config.socketPath, 'team.role.create', {
      clientId: 'client-b',
      requestId: 'team-b-backend-role',
      teamId: teamB.teamId,
      roleKey: 'expert.backend',
      roleType: 'expert',
    });
    const teamBBackend = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'client-b',
      requestId: 'team-b-backend-session',
      teamId: teamB.teamId,
      roleKey: 'expert.backend',
      provider: 'chatgpt',
    });
    assert.notEqual(teamBBackend.sessionId, firstBackend.sessionId);
    assert.notEqual(teamBBackend.teamId, firstBackend.teamId);

    const teamC = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'client-a',
      requestId: 'team-c',
      name: 'Team C',
    });
    const listedA = await rpc<{ readonly teams: readonly TeamSnapshot[] }>(config.socketPath, 'team.list', {
      clientId: 'client-a',
    });
    assert.deepEqual(new Set(listedA.teams.map((team) => team.teamId)), new Set([teamA.teamId, teamC.teamId]));
    assert.deepEqual(listedA.teams.find((team) => team.teamId === teamA.teamId), aggregate);
    assert.deepEqual(listedA.teams.find((team) => team.teamId === teamC.teamId), teamC);
    const listedB = await rpc<{ readonly teams: readonly TeamSnapshot[] }>(config.socketPath, 'team.list', {
      clientId: 'client-b',
    });
    assert.deepEqual(listedB.teams.map((team) => team.teamId), [teamB.teamId]);

    const replacement = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'client-a',
      requestId: 'backend-session-2',
      teamId: teamA.teamId,
      roleKey: 'expert.backend',
      provider: 'chatgpt',
    });
    assert.equal(replacement.predecessorSessionId, firstBackend.sessionId);
    const previous = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-a',
      sessionId: firstBackend.sessionId,
    });
    assert.equal(previous.sessionState, 'superseded');

    const events = await rpc<{
      readonly events: readonly Array<{ readonly sequence: number; readonly eventType: string }>;
      readonly latestEventSequence: number;
    }>(config.socketPath, 'session.events', {
      clientId: 'client-a',
      teamId: teamA.teamId,
      afterSequence: 0,
      limit: 100,
    });
    assert.ok(events.events.length >= 7);
    assert.deepEqual(
      events.events.map((event) => event.sequence),
      [...events.events].map((event) => event.sequence).sort((left, right) => left - right),
    );
    assert.equal(events.latestEventSequence, events.events.at(-1)?.sequence);

    await assert.rejects(
      rpc(config.socketPath, 'team.role.create', {
        clientId: 'client-a',
        requestId: 'duplicate-role',
        teamId: teamA.teamId,
        roleKey: 'expert.backend',
        roleType: 'expert',
      }),
      (error: unknown) =>
        error instanceof RpcClientError &&
        (error.data as Record<string, unknown>).errorCode === 'team.role-key-conflict',
    );

    const reviewer = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'client-a', requestId: 'reviewer-session', teamId: teamA.teamId,
      roleKey: 'reviewer.security', provider: 'chatgpt',
    });
    await rpc(config.socketPath, 'session.send', {
      clientId: 'client-a', requestId: 'reviewer-send', sessionId: reviewer.sessionId, prompt: 'Review',
    });
    let review: { terminal: boolean };
    do {
      review = await rpc(config.socketPath, 'session.wait', {
        clientId: 'client-a', sessionId: reviewer.sessionId, generation: 1, waitMs: 1000,
      });
    } while (!review.terminal);
    const waiting = rpc<{ waitExpired: boolean }>(config.socketPath, 'team.wait', {
      clientId: 'client-a', teamId: teamA.teamId,
      roleKeys: ['reviewer.security', 'main'], until: 'primary_terminal', waitMs: 500,
    });
    const concurrentRead = new Promise((resolve) => setTimeout(resolve, 20)).then(() =>
      rpc(config.socketPath, 'team.get', { clientId: 'client-a', teamId: teamA.teamId }));
    assert.equal(await Promise.race([
      waiting.then(() => 'wait-finished'), concurrentRead.then(() => 'core-responsive'),
    ]), 'core-responsive');
    assert.equal((await waiting).waitExpired, true);

    await service.close();
    service = await startCore({ config, startBrowser: false });
    const restored = await rpc<TeamSnapshot>(config.socketPath, 'team.get', {
      clientId: 'client-a',
      teamId: teamA.teamId,
    });
    assert.equal(
      restored.roles.find((role) => role.roleKey === 'expert.backend')?.currentSessionId,
      replacement.sessionId,
    );
    const restoredCurrent = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-a',
      teamId: teamA.teamId,
      roleKey: 'expert.backend',
    });
    assert.equal(restoredCurrent.sessionId, replacement.sessionId);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function rpc<Result = Readonly<Record<string, unknown>>>(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<Result> {
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 3_000 });
}
