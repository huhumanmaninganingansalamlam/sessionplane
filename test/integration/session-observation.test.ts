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

test('core-owned observation continues after wait expiry and publishes exact final once', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-observation-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: 20,
    observationQuietSweepMs: 40,
    observationQuietWindowMs: 30,
  });
  const fake = new FakeProviderAdapter();
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'observer-client',
      requestId: 'observer-team',
      name: 'Observer Team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'observer-client',
      requestId: 'observer-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const submitted = await rpc<SessionSnapshot>(config.socketPath, 'session.send', {
      clientId: 'observer-client',
      requestId: 'observer-send',
      sessionId: session.sessionId,
      prompt: 'Observe this exact generation.',
      sessionDeadlineSec: 600,
    });
    assert.equal(submitted.generation, 1);
    assert.equal(submitted.promptSubmitted, true);

    const pending = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.sessionState === 'observing' && snapshot.providerState === 'pending',
    );
    assert.equal(service.observationService.observerCount, 1);

    const expired = await rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'observer-client',
      sessionId: session.sessionId,
      generation: 1,
      afterEventSequence: pending.latestEventSequence,
      waitMs: 25,
    });
    assert.equal(expired.waitExpired, true);
    assert.equal(expired.terminal, false);
    assert.equal(service.observationService.observerCount, 1);

    fake.emitObservation(session.sessionId, {
      networkActivity: true,
      candidate: null,
      activity: 'none',
    });
    const networkProgress = await rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'observer-client',
      sessionId: session.sessionId,
      generation: 1,
      afterEventSequence: expired.latestEventSequence,
      waitMs: 2_000,
    });
    assert.equal(networkProgress.waitExpired, false);
    assert.equal(networkProgress.terminal, false);
    assert.equal(networkProgress.providerState, 'generating');
    assert.equal(networkProgress.responseMessageId, null);

    fake.emitObservation(session.sessionId, {
      dialogKind: 'rate_limit',
      networkActivity: false,
    });
    const blocked = await rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'observer-client',
      sessionId: session.sessionId,
      generation: 1,
      afterEventSequence: networkProgress.latestEventSequence,
      waitMs: 2_000,
    });
    assert.equal(blocked.providerState, 'blocked');
    assert.equal(blocked.terminal, false);
    assert.equal(blocked.errorCode, null);

    fake.emitObservation(session.sessionId, {
      dialogKind: null,
      candidate: {
        responseMessageId: 'assistant-final-1',
        answerText: 'Exact final answer',
        terminalMarker: true,
        streamingMarker: false,
      },
      activity: 'none',
    });
    const complete = await rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'observer-client',
      sessionId: session.sessionId,
      generation: 1,
      afterEventSequence: blocked.latestEventSequence,
      waitMs: 2_000,
    });
    assert.equal(complete.waitExpired, false);
    assert.equal(complete.terminal, true);
    assert.equal(complete.sessionState, 'complete');
    assert.equal(complete.providerState, 'complete');
    assert.equal(complete.responseMessageId, 'assistant-final-1');
    assert.equal(complete.answerText, 'Exact final answer');

    await waitFor(() => service.observationService.observerCount === 0);
    assert.equal(fake.observationOpenCount, 1);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForSnapshot(
  socketPath: string,
  sessionId: string,
  predicate: (snapshot: WaitSnapshot) => boolean,
): Promise<WaitSnapshot> {
  let cursor = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await rpc<WaitSnapshot>(socketPath, 'session.wait', {
      clientId: 'observer-client',
      sessionId,
      afterEventSequence: cursor,
      waitMs: 50,
    });
    cursor = Math.max(cursor, snapshot.latestEventSequence);
    if (predicate(snapshot)) {
      return snapshot;
    }
  }
  throw new Error('Timed out waiting for the expected session snapshot');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the expected condition');
}

async function rpc<Result>(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<Result> {
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
