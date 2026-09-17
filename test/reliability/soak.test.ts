import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { RUNTIME_COUNTERS } from '../../src/telemetry/metrics.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
  readonly roles: readonly Array<{
    readonly roleKey: string;
    readonly currentSessionId: string | null;
  }>;
}

interface WaitSnapshot extends SessionSnapshot {
  readonly latestEventSequence: number;
}

interface HealthSnapshot {
  readonly metrics: Readonly<Record<string, unknown>>;
}

const VIRTUAL_MINUTES = 120;
const VIRTUAL_DURATION_MS = VIRTUAL_MINUTES * 60_000;

test('accelerated two-hour reliability run preserves exact identity across restart and 20 waits', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-reliability-soak-'));
  const initialConfig = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: 20,
    observationQuietSweepMs: 50,
    observationQuietWindowMs: 20,
    backendRecoveryAfterMs: 60_000,
  });
  const firstAdapter = new FakeProviderAdapter();
  let service: CoreService = await startCore({
    config: initialConfig,
    startBrowser: false,
    providerAdapters: [firstAdapter],
    logger: silentLogger(),
  });

  try {
    const firstTeam = await createTeamWithExpert(
      initialConfig.socketPath,
      'reliability-a',
    );
    const secondTeam = await createTeamWithExpert(
      initialConfig.socketPath,
      'reliability-b',
    );
    assert.notEqual(firstTeam.teamId, secondTeam.teamId);
    assert.deepEqual(
      firstTeam.roles.map((role) => role.roleKey),
      ['main', 'expert.backend'],
    );
    assert.deepEqual(
      secondTeam.roles.map((role) => role.roleKey),
      ['main', 'expert.backend'],
    );

    const sessions = await Promise.all([
      createSession(initialConfig.socketPath, firstTeam.teamId, 'main', 'a-main'),
      createSession(
        initialConfig.socketPath,
        firstTeam.teamId,
        'expert.backend',
        'a-expert',
      ),
      createSession(initialConfig.socketPath, secondTeam.teamId, 'main', 'b-main'),
      createSession(
        initialConfig.socketPath,
        secondTeam.teamId,
        'expert.backend',
        'b-expert',
      ),
    ]);
    assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 4);

    const firstSend = {
      clientId: 'reliability-client',
      requestId: 'reliability-send-a-main',
      sessionId: sessions[0]?.sessionId,
      prompt: 'Reliability generation for a-main',
      sessionDeadlineSec: 7_200,
    } as const;
    const [firstResult, duplicateResult, ...otherResults] = await Promise.all([
      rpc<SessionSnapshot>(initialConfig.socketPath, 'session.send', firstSend),
      rpc<SessionSnapshot>(initialConfig.socketPath, 'session.send', firstSend),
      ...sessions.slice(1).map((session, index) =>
        rpc<SessionSnapshot>(initialConfig.socketPath, 'session.send', {
          clientId: 'reliability-client',
          requestId: `reliability-send-${index + 1}`,
          sessionId: session.sessionId,
          prompt: `Reliability generation ${index + 1}`,
          sessionDeadlineSec: 7_200,
        }),
      ),
    ]);
    assert.deepEqual(duplicateResult, firstResult);
    assert.equal(otherResults.length, 3);
    assert.equal(firstAdapter.submitCount, 4);

    const expectedIdentity = new Map(
      [firstResult, ...otherResults].map((snapshot) => [
        snapshot.sessionId,
        {
          teamId: snapshot.teamId,
          roleKey: snapshot.roleKey,
          generation: snapshot.generation,
          conversationId: snapshot.conversationId,
        },
      ]),
    );

    for (let minute = 0; minute < 60; minute += 1) {
      await verifyIdentityCheckpoint(
        initialConfig.socketPath,
        sessions.map((session) => session.sessionId),
        expectedIdentity,
        minute,
      );
      if (minute % 15 === 0) {
        for (const session of sessions) {
          firstAdapter.emitObservation(session.sessionId, {
            activity: 'strong',
            candidate: null,
            networkActivity: false,
          });
        }
      }
    }

    await service.close();

    const restartConfig = resolveConfig({
      cwd: root,
      env: {},
      stateDir: '.state',
      observationActiveSweepMs: 20,
      observationQuietSweepMs: 50,
      observationQuietWindowMs: 20,
      backendRecoveryAfterMs: 20,
      probeSuccessIntervalMs: 5_000,
      probeMin429BackoffMs: 5_000,
      probeMax429BackoffMs: 5_000,
    });
    const restartedAdapter = new FakeProviderAdapter();
    for (const session of sessions) {
      restartedAdapter.queueRecovery(session.sessionId, {
        kind: 'deferred',
        observationTransport: 'deferred',
        responseMessageId: null,
        answerText: null,
        reason: 'backend-http-429',
        retryAfterMs: 50,
        nextCheckAt: null,
      });
    }
    service = await startCore({
      config: restartConfig,
      startBrowser: false,
      providerAdapters: [restartedAdapter],
      logger: silentLogger(),
    });
    assert.equal(restartedAdapter.openCount, 0);
    assert.equal(restartedAdapter.submitCount, 0);
    assert.equal(restartedAdapter.observationOpenCount, 4);

    const deferredHealth = await waitForHealth(
      restartConfig.socketPath,
      (health) => Number(health.metrics.backend_probe_429_total) >= 1,
    );
    assert.ok(Number(deferredHealth.metrics.backend_probe_deferred_total) >= 1);

    for (let minute = 60; minute < VIRTUAL_MINUTES; minute += 1) {
      await verifyIdentityCheckpoint(
        restartConfig.socketPath,
        sessions.map((session) => session.sessionId),
        expectedIdentity,
        minute,
      );
      if (minute % 15 === 0) {
        for (const session of sessions) {
          restartedAdapter.emitObservation(session.sessionId, {
            activity: 'strong',
            candidate: null,
            networkActivity: false,
          });
        }
      }
    }

    const waitSession = sessions[0];
    assert.notEqual(waitSession, undefined);
    if (waitSession === undefined) {
      throw new Error('Reliability fixture did not create the primary wait session');
    }
    assert.equal(service.observationService.stop(waitSession.sessionId, 1), true);

    const cursor = await rpc<WaitSnapshot>(restartConfig.socketPath, 'session.wait', {
      clientId: 'reliability-client',
      sessionId: waitSession.sessionId,
      generation: 1,
      waitMs: 0,
    });
    const waits = Array.from({ length: 20 }, () =>
      rpc<WaitSnapshot>(restartConfig.socketPath, 'session.wait', {
        clientId: 'reliability-client',
        sessionId: waitSession.sessionId,
        generation: 1,
        afterEventSequence: cursor.latestEventSequence,
        waitMs: 2_000,
      }),
    );
    await waitForHealth(
      restartConfig.socketPath,
      (health) => Number(health.metrics.wait_subscriber_count) === 20,
    );

    await service.actorScheduler.updateGeneration(
      waitSession.sessionId,
      1,
      {
        sessionState: 'complete',
        providerState: 'complete',
        observationTransport: 'fresh',
        responseMessageId: 'reliability-final-0',
        answerText: 'Reliability final 0',
        completedAt: new Date().toISOString(),
        reason: 'reliability-multiwait-complete',
        errorCode: null,
      },
      'generation.reliability-complete',
    );

    for (const [index, session] of sessions.slice(1).entries()) {
      restartedAdapter.emitObservation(session.sessionId, {
        dialogKind: null,
        candidate: {
          responseMessageId: `reliability-final-${index + 1}`,
          answerText: `Reliability final ${index + 1}`,
          terminalMarker: true,
          streamingMarker: false,
        },
        activity: 'none',
        networkActivity: false,
      });
    }

    const waitResults = await Promise.all(waits);
    assert.ok(waitResults.every((snapshot) => snapshot.terminal && !snapshot.waitExpired));
    const finals = await Promise.all(
      sessions.map((session) =>
        waitForTerminal(restartConfig.socketPath, session.sessionId),
      ),
    );
    assert.equal(new Set(finals.map((snapshot) => snapshot.responseMessageId)).size, 4);

    const settledHealth = await waitForHealth(
      restartConfig.socketPath,
      (health) =>
        Number(health.metrics.observer_count) === 0 &&
        Number(health.metrics.wait_subscriber_count) === 0,
    );
    for (const name of [
      'wrong_session_total',
      'wrong_generation_total',
      'duplicate_submit_total',
      'focus_switch_total',
    ] as const) {
      assert.equal(settledHealth.metrics[name], 0, `${name} must remain zero`);
    }
    assert.equal(settledHealth.metrics.session_actor_count, 4);
    assert.equal(settledHealth.metrics.session_actor_queue_depth, 0);
    assert.equal(settledHealth.metrics.wait_subscriber_count, 0);
    assert.equal(settledHealth.metrics.observer_count, 0);
    assert.ok(Number(settledHealth.metrics.backend_probe_total) >= 1);
    assert.ok(Number(settledHealth.metrics.backend_probe_429_total) >= 1);
    assert.ok(Number(settledHealth.metrics.backend_probe_deferred_total) >= 1);

    const integrity = service.database.raw.prepare('PRAGMA quick_check').get() as Record<
      string,
      unknown
    >;
    assert.equal(Object.values(integrity)[0], 'ok');
    assert.equal(firstAdapter.submitCount + restartedAdapter.submitCount, 4);
    assert.equal(VIRTUAL_DURATION_MS, 2 * 60 * 60 * 1_000);
    assert.deepEqual(
      RUNTIME_COUNTERS.filter((name) => name.endsWith('_total')).sort(),
      [...RUNTIME_COUNTERS].filter((name) => name.endsWith('_total')).sort(),
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function createTeamWithExpert(socketPath: string, suffix: string): Promise<TeamSnapshot> {
  const team = await rpc<TeamSnapshot>(socketPath, 'team.create', {
    clientId: 'reliability-client',
    requestId: `${suffix}-team`,
    name: suffix,
    primaryRoleKey: 'main',
  });
  return await rpc<TeamSnapshot>(socketPath, 'team.role.create', {
    clientId: 'reliability-client',
    requestId: `${suffix}-expert-role`,
    teamId: team.teamId,
    roleKey: 'expert.backend',
    roleType: 'expert',
    reportsToRoleKey: 'main',
  });
}

async function createSession(
  socketPath: string,
  teamId: string,
  roleKey: string,
  suffix: string,
): Promise<SessionSnapshot> {
  return await rpc<SessionSnapshot>(socketPath, 'session.create', {
    clientId: 'reliability-client',
    requestId: `${suffix}-session`,
    teamId,
    roleKey,
    provider: 'chatgpt',
  });
}

async function verifyIdentityCheckpoint(
  socketPath: string,
  sessionIds: readonly string[],
  expected: ReadonlyMap<
    string,
    {
      readonly teamId: string;
      readonly roleKey: string;
      readonly generation: number;
      readonly conversationId: string | null;
    }
  >,
  minute: number,
): Promise<void> {
  const snapshots = await Promise.all(
    sessionIds.map((sessionId) =>
      rpc<SessionSnapshot>(socketPath, 'session.get', {
        clientId: 'reliability-client',
        sessionId,
      }),
    ),
  );
  for (const snapshot of snapshots) {
    const identity = expected.get(snapshot.sessionId);
    assert.notEqual(identity, undefined, `minute ${minute}: unexpected session`);
    assert.equal(snapshot.teamId, identity?.teamId, `minute ${minute}: team mismatch`);
    assert.equal(snapshot.roleKey, identity?.roleKey, `minute ${minute}: role mismatch`);
    assert.equal(snapshot.generation, identity?.generation, `minute ${minute}: generation mismatch`);
    assert.equal(
      snapshot.conversationId,
      identity?.conversationId,
      `minute ${minute}: conversation mismatch`,
    );
  }
}

async function waitForTerminal(socketPath: string, sessionId: string): Promise<WaitSnapshot> {
  let cursor = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await rpc<WaitSnapshot>(socketPath, 'session.wait', {
      clientId: 'reliability-client',
      sessionId,
      generation: 1,
      afterEventSequence: cursor,
      waitMs: 25,
    });
    cursor = Math.max(cursor, snapshot.latestEventSequence);
    if (snapshot.terminal) {
      return snapshot;
    }
  }
  throw new Error(`Timed out waiting for terminal session ${sessionId}`);
}

async function waitForHealth(
  socketPath: string,
  predicate: (health: HealthSnapshot) => boolean,
): Promise<HealthSnapshot> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const health = await rpc<HealthSnapshot>(socketPath, 'system.health', {});
    if (predicate(health)) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for reliability health state');
}

async function rpc<Result>(socketPath: string, method: string, params: unknown): Promise<Result> {
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 5_000 });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
