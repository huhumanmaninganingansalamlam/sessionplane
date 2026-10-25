import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

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

test('a preserved predecessor collects DOM finals but uses backend only for its explicit collector', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-displaced-observer-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
    observationActiveSweepMs: 10, observationQuietSweepMs: 10, observationQuietWindowMs: 10,
    backendRecoveryAfterMs: 10, probeSuccessIntervalMs: 1 });
  const fake = new FakeProviderAdapter();
  const reads = new Map<string, number>();
  const recover = fake.recover.bind(fake);
  fake.recover = async request => {
    reads.set(request.session.sessionId, (reads.get(request.session.sessionId) ?? 0) + 1);
    return recover(request);
  };
  const options = { config, startBrowser: false, providerAdapters: [fake], logger: silentLogger() };
  let core = await startCore(options);
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'preserved-observer' });
    const old = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const original = await core.submissionService.send({ clientId: 'preserved-observer', requestId: 'old',
      sessionId: old.sessionId, prompt: 'Preserved original question', sessionDeadlineSec: 600 });
    // The preserving replacement's routing operation leaves the old submission intact.
    const next = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await core.submissionService.send({ clientId: 'preserved-observer', requestId: 'next',
      sessionId: next.sessionId, prompt: 'Current product question', sessionDeadlineSec: 600 });
    const generation = core.database.raw.prepare('SELECT * FROM generations WHERE session_id=?').get(old.sessionId);
    const outbox = core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(old.sessionId);
    await core.close();
    reads.clear();
    core = await startCore(options);
    await delay(150);
    assert.ok((reads.get(next.sessionId) ?? 0) > 0, 'current request retains backend recovery');
    assert.equal(reads.get(old.sessionId) ?? 0, 0, 'restart must not give an ownerless predecessor a backend slot');
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(old.sessionId), outbox);
    const release = core.actorScheduler.actorFor(old.sessionId).retainCollector(String(outbox!.outbox_id), false);
    try {
      for (let i = 0; i < 100 && !reads.get(old.sessionId); i++) await delay(10);
      assert.ok((reads.get(old.sessionId) ?? 0) > 0, 'an explicit original owner can still recover backend results');
    } finally { release(); }
    const settledReads = reads.get(old.sessionId);
    await delay(100);
    assert.equal(reads.get(old.sessionId), settledReads, 'releasing the owner returns the predecessor to passive DOM collection');
    const preserved = core.teamDirectory.getSession(old.sessionId);
    assert.equal(preserved.submittedUserMessageId, original.submittedUserMessageId);
    assert.equal(preserved.terminal, false);
    assert.equal(core.database.raw.prepare('SELECT completed_at FROM generations WHERE session_id=?').get(old.sessionId)!.completed_at,
      generation!.completed_at);
    fake.emitObservation(old.sessionId, { activity: 'none', candidate: {
      responseMessageId: 'preserved-dom-final', answerText: 'Original answer', terminalMarker: true, streamingMarker: false,
    } });
    const final = await waitForSnapshot(config.socketPath, old.sessionId, snapshot => snapshot.terminal);
    assert.equal(final.responseMessageId, 'preserved-dom-final');
    assert.equal(final.submittedUserMessageId, original.submittedUserMessageId);
    assert.equal(core.teamDirectory.getCurrentSession(team.teamId, 'main').sessionId, next.sessionId);
    assert.equal(fake.submitCount, 2);
    assert.equal(fake.stopCount, 0);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

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

    const expired = await rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'observer-client',
      sessionId: session.sessionId,
      generation: 1,
      afterEventSequence: pending.latestEventSequence,
      waitMs: 25,
    });
    assert.equal(expired.waitExpired, true);
    assert.equal(expired.terminal, false);

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
    assert.equal(networkProgress.providerState, 'unknown');
    assert.equal(networkProgress.reason, 'provider-network-activity');
    assert.equal(networkProgress.errorCode, null);
    assert.equal(networkProgress.submittedUserMessageId, submitted.submittedUserMessageId);
    assert.equal(networkProgress.responseMessageId, null);

    fake.emitObservation(session.sessionId, {
      networkActivity: false,
      candidate: null,
      activity: 'strong',
    });
    const generating = await rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'observer-client',
      sessionId: session.sessionId,
      generation: 1,
      afterEventSequence: networkProgress.latestEventSequence,
      waitMs: 2_000,
    });
    assert.equal(generating.providerState, 'generating');
    assert.equal(generating.reason, 'provider-generation-activity');
    assert.equal(generating.terminal, false);

    fake.emitObservation(session.sessionId, {
      dialogKind: 'rate_limit',
      networkActivity: false,
    });
    const blocked = await rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'observer-client',
      sessionId: session.sessionId,
      generation: 1,
      afterEventSequence: generating.latestEventSequence,
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
