import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface WaitSnapshot extends SessionSnapshot {
  readonly latestEventSequence: number;
}

test('stale DOM recovers an exact server final and backend 429 remains deferred, not blocked', async () => {
  const fixture = await createFixture('sessionplane-backend-recovery-');
  const { config, fake, service } = fixture;
  try {
    const { teamId, session } = await createSession(config.socketPath, 'main', 'primary');
    fake.queueRecovery(session.sessionId, {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: 'server-assistant-1',
      answerText: 'Recovered exact server final',
      reason: 'backend-exact-final',
      retryAfterMs: null,
      nextCheckAt: null,
    });
    await send(config.socketPath, session.sessionId, 'recover-final');

    const complete = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.terminal,
    );
    assert.equal(complete.sessionState, 'complete');
    assert.equal(complete.providerState, 'complete');
    assert.equal(complete.responseMessageId, 'server-assistant-1');
    assert.equal(complete.answerText, 'Recovered exact server final');
    assert.equal(fake.recoveryCount, 1);

    await rpc(config.socketPath, 'team.role.create', {
      clientId: 'backend-client',
      requestId: 'role-429',
      teamId,
      roleKey: 'expert.backend',
      roleType: 'expert',
      reportsToRoleKey: 'main',
    });
    const limitedSession = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'backend-client',
      requestId: 'session-429',
      teamId,
      roleKey: 'expert.backend',
      provider: 'chatgpt',
    });
    fake.queueRecovery(limitedSession.sessionId, {
      kind: 'deferred',
      observationTransport: 'deferred',
      responseMessageId: null,
      answerText: null,
      reason: 'backend-http-429',
      retryAfterMs: 100,
      nextCheckAt: null,
    });
    const beforeLimited = fake.recoveryCount;
    await send(config.socketPath, limitedSession.sessionId, 'recover-429');
    const deferred = await waitForSnapshot(
      config.socketPath,
      limitedSession.sessionId,
      (snapshot) =>
        snapshot.observationTransport === 'deferred' &&
        snapshot.reason === 'backend-http-429',
    );
    assert.equal(deferred.providerState, 'unknown');
    assert.equal(deferred.terminal, false);
    assert.equal(deferred.errorCode, null);
    assert.notEqual(deferred.nextCheckAt, null);
    assert.equal(fake.recoveryCount, beforeLimited + 1);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('strong exact generation activity suppresses backend recovery until activity stops', async () => {
  const fixture = await createFixture('sessionplane-backend-activity-');
  const { config, fake, service } = fixture;
  try {
    const { session } = await createSession(config.socketPath, 'main', 'activity');
    fake.queueRecovery(session.sessionId, {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: 'server-after-activity',
      answerText: 'Recovered after activity stopped',
      reason: 'backend-exact-final',
      retryAfterMs: null,
      nextCheckAt: null,
    });
    await send(config.socketPath, session.sessionId, 'strong-activity');

    const interval = setInterval(() => {
      fake.emitObservation(session.sessionId, {
        activity: 'strong',
        candidate: null,
        networkActivity: false,
      });
    }, 5);
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fake.recoveryCount, 0);
      const active = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
        clientId: 'backend-client',
        sessionId: session.sessionId,
      });
      assert.equal(active.providerState, 'generating');
      assert.equal(active.terminal, false);
    } finally {
      clearInterval(interval);
    }

    const complete = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.terminal,
    );
    assert.equal(complete.answerText, 'Recovered after activity stopped');
    assert.equal(fake.recoveryCount, 1);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(prefix: string) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: 10,
    observationQuietSweepMs: 10,
    observationQuietWindowMs: 5,
    backendRecoveryAfterMs: 30,
    probeSuccessIntervalMs: 1,
    probeMin429BackoffMs: 100,
    probeMax429BackoffMs: 100,
  });
  const fake = new FakeProviderAdapter();
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });
  return { root, config, fake, service };
}

async function createSession(socketPath: string, roleKey: string, suffix: string) {
  const team = await rpc<TeamSnapshot>(socketPath, 'team.create', {
    clientId: 'backend-client',
    requestId: `team-${suffix}`,
    name: `Backend ${suffix}`,
    primaryRoleKey: roleKey,
  });
  const session = await rpc<SessionSnapshot>(socketPath, 'session.create', {
    clientId: 'backend-client',
    requestId: `session-${suffix}`,
    teamId: team.teamId,
    roleKey,
    provider: 'chatgpt',
  });
  return { teamId: team.teamId, session };
}

async function send(socketPath: string, sessionId: string, suffix: string): Promise<void> {
  await rpc(socketPath, 'session.send', {
    clientId: 'backend-client',
    requestId: `send-${suffix}`,
    sessionId,
    prompt: `Backend recovery ${suffix}`,
    sessionDeadlineSec: 600,
  });
}

async function waitForSnapshot(
  socketPath: string,
  sessionId: string,
  predicate: (snapshot: WaitSnapshot) => boolean,
): Promise<WaitSnapshot> {
  let cursor = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const snapshot = await rpc<WaitSnapshot>(socketPath, 'session.wait', {
      clientId: 'backend-client',
      sessionId,
      afterEventSequence: cursor,
      waitMs: 25,
    });
    cursor = Math.max(cursor, snapshot.latestEventSequence);
    if (predicate(snapshot)) {
      return snapshot;
    }
  }
  throw new Error('Timed out waiting for backend recovery state');
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
