import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { startCore, type CoreService } from '../../src/main.ts';

interface TeamSnapshot {
  readonly teamId: string;
  readonly latestEventSequence: number;
}

interface SessionSnapshot {
  readonly sessionId: string;
  readonly generation: number;
  readonly sessionState: string;
  readonly providerState: string;
  readonly terminal: boolean;
  readonly waitExpired: boolean;
  readonly latestEventSequence?: number;
}

test('one actor serves concurrent waits, preserves provider lifetime, and restores after restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-actor-wait-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  let service: CoreService = await startCore({
    config,
    startBrowser: false,
    logger: silentLogger(),
  });

  try {
    const createTeamParams = {
      clientId: 'client-a',
      requestId: 'create-team-once',
      name: 'Actor Team',
      primaryRoleKey: 'main',
    };
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', createTeamParams);
    const replayedTeam = await rpc<TeamSnapshot>(
      config.socketPath,
      'team.create',
      createTeamParams,
    );
    assert.equal(replayedTeam.teamId, team.teamId);

    await assert.rejects(
      rpc(config.socketPath, 'team.create', {
        ...createTeamParams,
        name: 'Different payload',
      }),
      (error: unknown) =>
        error instanceof RpcClientError &&
        (error.data as Record<string, unknown>).errorCode === 'input.idempotency-conflict',
    );

    const createSessionParams = {
      clientId: 'client-a',
      requestId: 'create-main-session-once',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    };
    const session = await rpc<SessionSnapshot>(
      config.socketPath,
      'session.create',
      createSessionParams,
    );
    const replayedSession = await rpc<SessionSnapshot>(
      config.socketPath,
      'session.create',
      createSessionParams,
    );
    assert.equal(replayedSession.sessionId, session.sessionId);

    const aggregate = await rpc<TeamSnapshot>(config.socketPath, 'team.get', {
      clientId: 'client-a',
      teamId: team.teamId,
    });
    const waitParams = {
      clientId: 'client-a',
      sessionId: session.sessionId,
      generation: 0,
      afterEventSequence: aggregate.latestEventSequence,
      waitMs: 200,
    };
    const waits = Array.from({ length: 20 }, () =>
      rpc<SessionSnapshot>(config.socketPath, 'session.wait', waitParams),
    );

    const actor = service.actorScheduler.actorFor(session.sessionId);
    await waitUntil(() => actor.subscriberCount === 20, 1_000);
    assert.equal(service.actorScheduler.actorCount, 1);
    assert.equal(actor.subscriberCount, 20);

    const timedOut = await Promise.all(waits);
    assert.ok(timedOut.every((snapshot) => snapshot.waitExpired));
    assert.ok(timedOut.every((snapshot) => snapshot.terminal === false));
    assert.ok(timedOut.every((snapshot) => snapshot.generation === 0));
    assert.equal(actor.subscriberCount, 0);

    const persistedAfterTimeout = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-a',
      sessionId: session.sessionId,
    });
    assert.equal(persistedAfterTimeout.sessionState, 'created');
    assert.equal(persistedAfterTimeout.providerState, 'unknown');
    assert.equal(persistedAfterTimeout.generation, 0);

    const wakePromise = rpc<SessionSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'client-a',
      sessionId: session.sessionId,
      generation: 0,
      afterEventSequence: aggregate.latestEventSequence,
      waitMs: 2_000,
    });
    await waitUntil(() => actor.subscriberCount === 1, 1_000);
    const started = await service.actorScheduler.startGeneration({
      sessionId: session.sessionId,
      expectedGeneration: 0,
      teamBriefVersion: 0,
      promptHash: 'sha256:test-prompt',
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(started.generation, 1);
    assert.equal(started.sessionState, 'submitting');

    const awakened = await wakePromise;
    assert.equal(awakened.waitExpired, false);
    assert.equal(awakened.generation, 1);
    assert.equal(awakened.sessionState, 'submitting');

    const afterGenerationStart = await rpc<TeamSnapshot>(config.socketPath, 'team.get', {
      clientId: 'client-a',
      teamId: team.teamId,
    });
    const teamWait = rpc<{
      readonly waitExpired: boolean;
      readonly sessions: readonly SessionSnapshot[];
    }>(config.socketPath, 'team.wait', {
      clientId: 'client-a',
      teamId: team.teamId,
      roleKeys: ['main'],
      until: 'any_change',
      afterEventSequence: afterGenerationStart.latestEventSequence,
      waitMs: 2_000,
    });
    await waitUntil(() => actor.subscriberCount === 1, 1_000);
    await service.actorScheduler.updateGeneration(
      session.sessionId,
      1,
      {
        sessionState: 'submitted',
        providerState: 'generating',
        observationTransport: 'fresh',
        submissionState: 'submitted',
      },
      'generation.submitted',
    );
    const teamWake = await teamWait;
    assert.equal(teamWake.waitExpired, false);
    assert.equal(teamWake.sessions[0]?.sessionState, 'submitted');
    assert.equal(actor.subscriberCount, 0);

    await assert.rejects(
      service.actorScheduler.updateGeneration(session.sessionId, 0, {
        sessionState: 'complete',
        providerState: 'complete',
      }),
      (error: unknown) =>
        error instanceof SessionPlaneDomainError &&
        error.errorCode === 'session.generation-superseded',
    );

    await service.close();
    service = await startCore({
      config,
      startBrowser: false,
      logger: silentLogger(),
    });
    assert.equal(service.actorScheduler.actorCount, 1);
    const restored = await rpc<SessionSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'client-a',
      sessionId: session.sessionId,
      generation: 1,
      waitMs: 0,
    });
    assert.equal(restored.generation, 1);
    assert.equal(restored.sessionState, 'submitted');
    assert.equal(restored.waitExpired, true);
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
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 5_000 });
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for test condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

