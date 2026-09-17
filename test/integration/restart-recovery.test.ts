import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface WaitSnapshot extends SessionSnapshot {
  readonly latestEventSequence: number;
}

test('service restart restores the same generation and observer without resending the prompt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-restart-recovery-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: 10,
    observationQuietSweepMs: 20,
    observationQuietWindowMs: 10,
    backendRecoveryAfterMs: 10_000,
  });
  const beforeRestart = new FakeProviderAdapter();
  let service: CoreService = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [beforeRestart],
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'restart-client',
      requestId: 'restart-team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'restart-client',
      requestId: 'restart-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const sendRequest = {
      clientId: 'restart-client',
      requestId: 'restart-send',
      sessionId: session.sessionId,
      prompt: 'Continue observing this exact generation after restart.',
      sessionDeadlineSec: 600,
    } as const;
    const submitted = await rpc<SessionSnapshot>(
      config.socketPath,
      'session.send',
      sendRequest,
    );
    assert.equal(submitted.generation, 1);
    assert.equal(beforeRestart.submitCount, 1);
    assert.equal(service.observationService.observerCount, 1);

    const outboxCount = service.database.raw
      .prepare('SELECT COUNT(*) AS count FROM outbox WHERE session_id = ?')
      .get(session.sessionId) as { count: number };
    assert.equal(Number(outboxCount.count), 1);

    await service.close();

    const afterRestart = new FakeProviderAdapter();
    afterRestart.emitObservation(session.sessionId, {
      candidate: {
        responseMessageId: 'restart-final-message',
        answerText: 'Recovered after service restart',
        terminalMarker: true,
        streamingMarker: false,
      },
      activity: 'none',
    });
    service = await startCore({
      config,
      startBrowser: false,
      providerAdapters: [afterRestart],
      logger: silentLogger(),
    });

    const complete = await waitForComplete(config.socketPath, session.sessionId, 1);
    assert.equal(complete.sessionId, session.sessionId);
    assert.equal(complete.generation, 1);
    assert.equal(complete.responseMessageId, 'restart-final-message');
    assert.equal(complete.answerText, 'Recovered after service restart');
    assert.equal(afterRestart.openCount, 0, 'startup recovery must not open a submission');
    assert.equal(afterRestart.submitCount, 0, 'startup recovery must not resend the prompt');
    assert.equal(afterRestart.observationOpenCount, 1);

    const replayed = await rpc<SessionSnapshot>(
      config.socketPath,
      'session.send',
      sendRequest,
    );
    assert.equal(replayed.sessionId, session.sessionId);
    assert.equal(replayed.generation, 1);
    assert.equal(afterRestart.submitCount, 0);
    const persistedOutboxCount = service.database.raw
      .prepare('SELECT COUNT(*) AS count FROM outbox WHERE session_id = ?')
      .get(session.sessionId) as { count: number };
    assert.equal(Number(persistedOutboxCount.count), 1);

    const metrics = service.metrics.snapshot({
      sessionActorCount: service.actorScheduler.actorCount,
      sessionActorQueueDepth: service.actorScheduler.totalQueueDepth,
      waitSubscriberCount: service.actorScheduler.totalSubscriberCount,
      observerCount: service.observationService.observerCount,
    });
    assert.equal(metrics.duplicate_submit_total, 0);
    assert.ok(Number(metrics.restart_recovery_latency_ms) >= 0);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('submission_unknown remains nonterminal across restart and is never resent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-restart-ambiguous-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const beforeRestart = new FakeProviderAdapter();
  beforeRestart.acknowledgementMode = 'missing';
  let service: CoreService = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [beforeRestart],
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'ambiguous-restart-client',
      requestId: 'ambiguous-restart-team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'ambiguous-restart-client',
      requestId: 'ambiguous-restart-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const request = {
      clientId: 'ambiguous-restart-client',
      requestId: 'ambiguous-restart-send',
      sessionId: session.sessionId,
      prompt: 'The exact acknowledgement will be hidden.',
      sessionDeadlineSec: 600,
    } as const;
    await assert.rejects(
      rpc(config.socketPath, 'session.send', request),
      hasRpcError('session.submission-unknown'),
    );
    assert.equal(beforeRestart.submitCount, 1);

    await service.close();
    const afterRestart = new FakeProviderAdapter();
    service = await startCore({
      config,
      startBrowser: false,
      providerAdapters: [afterRestart],
      logger: silentLogger(),
    });
    const restored = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'ambiguous-restart-client',
      sessionId: session.sessionId,
    });
    assert.equal(restored.generation, 1);
    assert.equal(restored.sessionState, 'observing');
    assert.equal(restored.errorCode, 'session.submission-unknown');
    assert.equal(restored.promptSubmitted, true);
    assert.equal(afterRestart.observationOpenCount, 0);

    await assert.rejects(
      rpc(config.socketPath, 'session.send', request),
      hasRpcError('session.submission-unknown'),
    );
    assert.equal(afterRestart.openCount, 0);
    assert.equal(afterRestart.submitCount, 0);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForComplete(
  socketPath: string,
  sessionId: string,
  generation: number,
): Promise<WaitSnapshot> {
  let cursor = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const snapshot = await rpc<WaitSnapshot>(socketPath, 'session.wait', {
      clientId: 'restart-client',
      sessionId,
      generation,
      afterEventSequence: cursor,
      waitMs: 50,
    });
    cursor = Math.max(cursor, snapshot.latestEventSequence);
    if (snapshot.terminal) {
      return snapshot;
    }
  }
  throw new Error('Timed out waiting for the restarted observer to complete');
}

function hasRpcError(errorCode: string) {
  return (error: unknown): boolean => {
    if (!(error instanceof RpcClientError)) {
      return false;
    }
    const data = error.data as Record<string, unknown>;
    return data.errorCode === errorCode;
  };
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
