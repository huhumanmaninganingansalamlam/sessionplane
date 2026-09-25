import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import type {
  ProviderRecoveryRequest,
  ProviderRecoveryResult,
} from '../../src/providers/provider-adapter.ts';
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

    fake.emitObservation(limitedSession.sessionId, {
      activity: 'strong',
      candidate: null,
      networkActivity: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterSpinner = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'backend-client',
      sessionId: limitedSession.sessionId,
    });
    assert.equal(afterSpinner.observationTransport, 'deferred');
    assert.equal(afterSpinner.providerState, 'unknown');

    fake.emitObservation(limitedSession.sessionId, {
      submittedUserFound: false, candidate: null, activity: 'unknown',
      observationTransport: 'unavailable',
      errorCode: 'provider.conversation-unavailable',
      reason: 'conversation-load-http-429',
    });
    const unreadable = await waitForSnapshot(config.socketPath, limitedSession.sessionId,
      (snapshot) => snapshot.errorCode === 'provider.conversation-unavailable');
    assert.equal(unreadable.terminal, false);
    assert.equal(unreadable.providerState, 'unknown');
    assert.equal(unreadable.submittedUserMessageId, deferred.submittedUserMessageId);
    fake.emitObservation(limitedSession.sessionId, {
      submittedUserFound: true, activity: 'weak', observationTransport: 'fresh',
      errorCode: undefined, reason: null,
      candidate: { responseMessageId: 'restored-answer', answerText: 'Recovered', terminalMarker: true, streamingMarker: false },
    });
    const restored = await waitForSnapshot(config.socketPath, limitedSession.sessionId,
      (snapshot) => snapshot.terminal);
    assert.equal(restored.errorCode, null);
    assert.equal(restored.answerText, 'Recovered');
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('spinner without an assistant candidate does not suppress exact backend recovery', async () => {
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

    fake.emitObservation(session.sessionId, {
      activity: 'strong',
      candidate: null,
      networkActivity: false,
    });

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

test('expired submitted generation reports uncertainty while observation continues', async () => {
  const fixture = await createFixture('sessionplane-expired-observation-');
  const { config, fake, service } = fixture;
  try {
    const { session } = await createSession(config.socketPath, 'main', 'expired');
    await send(config.socketPath, session.sessionId, 'expired', 1);

    await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.reason === 'session-deadline-unverified',
    );
    fake.emitObservation(session.sessionId, {
      candidate: {
        responseMessageId: 'assistant-after-deadline',
        answerText: 'Part one',
        terminalMarker: false,
        streamingMarker: true,
      },
      activity: 'strong',
    });
    const resumed = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.reason === 'assistant-generation-active',
    );
    assert.equal(resumed.providerState, 'generating');

    const expired = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.reason === 'session-deadline-unverified',
    );
    assert.equal(expired.providerState, 'unknown');
    assert.equal(expired.terminal, false);
    assert.equal(expired.promptSubmitted, true);
    assert.equal(fake.submitCount, 1);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test('future probe nextCheckAt suppresses repeated paced recovery calls until due', async () => {
  const fixture = await createFixture(
    'sessionplane-backend-pacing-',
    new FakeProviderAdapter(),
    {
      backendRecoveryAfterMs: 15,
      observationActiveSweepMs: 5,
      observationQuietSweepMs: 5,
      probeSuccessIntervalMs: 180,
    },
  );
  const { config, fake, service } = fixture;
  try {
    const { session } = await createSession(config.socketPath, 'main', 'pacing');
    fake.queueRecovery(session.sessionId, {
      kind: 'pending',
      observationTransport: 'fresh',
      responseMessageId: null,
      answerText: null,
      reason: 'backend-pending',
      retryAfterMs: null,
      nextCheckAt: null,
    });
    fake.queueRecovery(session.sessionId, {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: 'server-after-pacing',
      answerText: 'Recovered after pacing window',
      reason: 'backend-exact-final',
      retryAfterMs: null,
      nextCheckAt: null,
    });

    await send(config.socketPath, session.sessionId, 'paced-recovery');
    const paced = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.nextCheckAt !== null && snapshot.terminal === false,
    );
    assert.notEqual(paced.nextCheckAt, null);
    assert.equal(fake.recoveryCount, 1);

    const before = await rpc<{
      readonly metrics: Readonly<Record<string, number>>;
    }>(config.socketPath, 'system.health', {});
    await new Promise((resolve) => setTimeout(resolve, 70));
    const during = await rpc<{
      readonly metrics: Readonly<Record<string, number>>;
    }>(config.socketPath, 'system.health', {});
    assert.equal(
      during.metrics.backend_probe_deferred_total,
      before.metrics.backend_probe_deferred_total,
    );
    assert.equal(fake.recoveryCount, 1);

    const complete = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.terminal,
    );
    assert.equal(complete.answerText, 'Recovered after pacing window');
    assert.equal(fake.recoveryCount, 2);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('DOM completion clears a previously persisted backend nextCheckAt', async () => {
  const fixture = await createFixture(
    'sessionplane-dom-complete-clears-pacing-',
    new FakeProviderAdapter(),
    {
      backendRecoveryAfterMs: 15,
      observationActiveSweepMs: 5,
      observationQuietSweepMs: 5,
      probeSuccessIntervalMs: 5_000,
    },
  );
  const { config, fake, service } = fixture;
  try {
    const { session } = await createSession(config.socketPath, 'main', 'dom-clears-pacing');
    fake.queueRecovery(session.sessionId, {
      kind: 'pending',
      observationTransport: 'fresh',
      responseMessageId: null,
      answerText: null,
      reason: 'backend-pending',
      retryAfterMs: null,
      nextCheckAt: null,
    });
    await send(config.socketPath, session.sessionId, 'dom-clears-pacing');
    const paced = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.nextCheckAt !== null && !snapshot.terminal,
    );
    assert.notEqual(paced.nextCheckAt, null);

    fake.emitObservation(session.sessionId, {
      candidate: {
        responseMessageId: 'dom-final-after-pacing',
        answerText: 'DOM completed after backend pacing',
        terminalMarker: true,
        streamingMarker: false,
      },
      activity: 'none',
    });
    const complete = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.terminal,
    );
    assert.equal(complete.reason, 'dom-terminal-marker');
    assert.equal(complete.nextCheckAt, null);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('concurrent same-account recovery preserves each session final', async () => {
  const fake = new DelayedPerSessionRecoveryAdapter(80);
  const fixture = await createFixture('sessionplane-backend-isolation-', fake);
  const { config, service } = fixture;
  try {
    const alpha = await createSession(config.socketPath, 'alpha', 'isolation-alpha');
    const beta = await createSession(config.socketPath, 'beta', 'isolation-beta');

    await Promise.all([
      send(config.socketPath, alpha.session.sessionId, 'isolation-alpha'),
      send(config.socketPath, beta.session.sessionId, 'isolation-beta'),
    ]);

    const [alphaFinal, betaFinal] = await Promise.all([
      waitForSnapshot(config.socketPath, alpha.session.sessionId, (snapshot) => snapshot.terminal),
      waitForSnapshot(config.socketPath, beta.session.sessionId, (snapshot) => snapshot.terminal),
    ]);

    assert.equal(alphaFinal.answerText, `answer:${alpha.session.sessionId}`);
    assert.equal(betaFinal.answerText, `answer:${beta.session.sessionId}`);
    assert.equal(alphaFinal.responseMessageId, `response:${alpha.session.sessionId}`);
    assert.equal(betaFinal.responseMessageId, `response:${beta.session.sessionId}`);
    assert.equal(fake.recoveryCount, 2);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(
  prefix: string,
  fake: FakeProviderAdapter = new FakeProviderAdapter(),
  timing: {
    readonly observationActiveSweepMs?: number;
    readonly observationQuietSweepMs?: number;
    readonly backendRecoveryAfterMs?: number;
    readonly probeSuccessIntervalMs?: number;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: timing.observationActiveSweepMs ?? 10,
    observationQuietSweepMs: timing.observationQuietSweepMs ?? 10,
    observationQuietWindowMs: 5,
    backendRecoveryAfterMs: timing.backendRecoveryAfterMs ?? 30,
    probeSuccessIntervalMs: timing.probeSuccessIntervalMs ?? 1,
    probeMin429BackoffMs: 100,
    probeMax429BackoffMs: 100,
  });
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });
  return { root, config, fake, service };
}

class DelayedPerSessionRecoveryAdapter extends FakeProviderAdapter {
  readonly #delayMs: number;

  constructor(delayMs: number) {
    super('chatgpt');
    this.#delayMs = delayMs;
  }

  override async recover(request: ProviderRecoveryRequest): Promise<ProviderRecoveryResult> {
    this.recoveryCount += 1;
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    return {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: `response:${request.session.sessionId}`,
      answerText: `answer:${request.session.sessionId}`,
      reason: 'fake-session-isolated-final',
      retryAfterMs: null,
      nextCheckAt: null,
    };
  }
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

async function send(socketPath: string, sessionId: string, suffix: string, deadlineSec = 600): Promise<void> {
  await rpc(socketPath, 'session.send', {
    clientId: 'backend-client',
    requestId: `send-${suffix}`,
    sessionId,
    prompt: `Backend recovery ${suffix}`,
    sessionDeadlineSec: deadlineSec,
  });
}

async function waitForSnapshot(
  socketPath: string,
  sessionId: string,
  predicate: (snapshot: WaitSnapshot) => boolean,
): Promise<WaitSnapshot> {
  let cursor = 0;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
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
