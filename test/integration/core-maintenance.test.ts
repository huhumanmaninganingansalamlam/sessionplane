import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright-core';
import { startCore } from '../../src/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { callRpc } from '../../src/cli/client.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

async function fixture(fake = new FakeProviderAdapter()) {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-maintenance-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
    observationActiveSweepMs: 10, observationQuietSweepMs: 20, observationQuietWindowMs: 10 });
  let exits = 0;
  const core = await startCore({ config, startBrowser: false, providerAdapters: [fake],
    handoverExit: () => { exits++; throw new Error('fixture exit'); } });
  const team = core.teamDirectory.createTeam({ clientId: 'maintenance-test' });
  const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
  const owner = { expectedPid: process.pid, expectedStartedAt: core.startedAt.toISOString() };
  const rpc = <T = unknown>(method: string, params: unknown = {}) => callRpc<T>({ socketPath: config.socketPath, method, params });
  const prepare = (drainTimeoutMs = 1000, leaseMs = 5000) => rpc<{ token: string; phase: string }>('system.maintenance.prepare', { ...owner, drainTimeoutMs, leaseMs });
  return { core, fake, session, owner, rpc, prepare, exits: () => exits,
    dispose: async () => { await core.close(); rmSync(root, { recursive: true, force: true }); } };
}

function page(url: string) {
  const callbacks = new Map<string, (...args: any[]) => void>();
  const fake = { url: () => url, isClosed: () => false, mainFrame: () => ({}),
    on: (event: string, callback: (...args: any[]) => void) => callbacks.set(event, callback), off: () => {},
    evaluate: async () => ({ kind: 'normal', reason: 'conversation-rendered', clicked: false, loadError: false }) } as unknown as Page;
  return { fake, callbacks };
}

test('maintenance drains a late observer before ready although the actor queue is empty', async () => {
  const fake = new FakeProviderAdapter();
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const open = fake.openObservation.bind(fake);
  fake.openObservation = async request => {
    const source = await open(request), observe = source.observe.bind(source);
    source.observe = async () => { entered.resolve(); await finish.promise; return observe(); };
    return source;
  };
  const f = await fixture(fake);
  try {
    await f.rpc('session.send', { clientId: 'maintenance-test', requestId: 'original', sessionId: f.session.sessionId,
      prompt: 'preserved original', sessionDeadlineSec: 600 });
    await entered.promise;
    assert.equal(f.core.actorScheduler.totalQueueDepth, 0);
    const preparing = f.prepare();
    await delay(30);
    assert.equal(f.core.maintenance.status().phase, 'draining');
    const newCall = { clientId: 'maintenance-test', requestId: 'must-not-be-issued', name: 'blocked' };
    await assert.rejects(f.rpc('team.create', newCall), /handover is draining/);
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE request_id='must-not-be-issued'").get()!.n, 0);
    finish.resolve();
    const lease = await preparing;
    assert.equal(lease.phase, 'ready');
    assert.equal(f.core.maintenance.status().activeOperations, 0);
    assert.equal(fake.submitCount, 1);
    const saved = f.core.database.raw.prepare('SELECT request_hash,prompt_submitted FROM outbox').all();
    await delay(30);
    assert.equal(f.core.maintenance.status().phase, 'ready');
    assert.deepEqual(f.core.database.raw.prepare('SELECT request_hash,prompt_submitted FROM outbox').all(), saved);
    await f.rpc('system.maintenance.resume', { ...f.owner, token: lease.token });
    assert.equal(f.core.maintenance.status().phase, 'running');
  } finally { finish.resolve(); await f.dispose(); }
});

test('late binding and passive429 writes revoke a ready lease before persisting; stale commit cannot exit', async () => {
  const f = await fixture();
  try {
    const p = page('https://chatgpt.com/c/maintenance-fixture');
    const binding = f.core.pageRegistry.registerPage(p.fake);
    await f.core.actorScheduler.startGeneration({ sessionId: f.session.sessionId, teamBriefVersion: 0, promptHash: 'retained' });
    await f.core.actorScheduler.updateGeneration(f.session.sessionId, 1, { pageKey: binding.pageKey,
      conversationId: 'maintenance-fixture', submissionState: 'prepared', sessionState: 'ready', promptSubmitted: false });
    f.core.pageRegistry.bindPage(binding.pageKey, { sessionId: f.session.sessionId, generation: 1, conversationId: 'maintenance-fixture' });
    await f.core.conversationLoadRecovery.sweep();
    const before = f.core.database.raw.prepare('SELECT * FROM generations').all();
    let lease = await f.prepare();
    await f.core.conversationLoadRecovery.sweep();
    assert.equal(f.core.maintenance.status().phase, 'ready');
    f.core.pageRegistry.refreshPage(binding.pageKey);
    assert.equal(f.core.maintenance.status().phase, 'running');
    await assert.rejects(f.rpc('system.maintenance.commit', { ...f.owner, token: lease.token }), /readiness changed/);
    lease = await f.prepare();
    p.callbacks.get('response')!({ status: () => 429,
      url: () => 'https://chatgpt.com/backend-api/conversation/maintenance-fixture',
      headers: () => ({ 'retry-after': '35' }), request: () => ({ method: () => 'GET' }) });
    assert.equal(f.core.maintenance.status().phase, 'running');
    assert.ok(f.core.database.raw.prepare("SELECT * FROM probe_budget WHERE scope='chatgpt:conversation-detail:maintenance-fixture'").get());
    await assert.rejects(f.rpc('system.maintenance.commit', { ...f.owner, token: lease.token }), /readiness changed/);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM generations').all(), before);
    assert.equal(f.exits(), 0);
    const valid = await f.prepare();
    await assert.rejects(f.rpc('system.maintenance.commit', { ...f.owner, token: valid.token }), /Internal error/);
    assert.equal(f.exits(), 1); // injected exit runs only for the current quiescent lease
  } finally { await f.dispose(); }
});

test('drain failure and lost-caller lease expiry resume normal service without cancelling unknown work', async () => {
  const fake = new FakeProviderAdapter(); fake.acknowledgementMode = 'missing';
  const f = await fixture(fake), finish = Promise.withResolvers<void>();
  try {
    await assert.rejects(f.rpc('session.send', { clientId: 'maintenance-test', requestId: 'unknown',
      sessionId: f.session.sessionId, prompt: 'retain unknown', sessionDeadlineSec: 600 }));
    const original = f.core.database.raw.prepare('SELECT request_hash,submission_state,prompt_submitted FROM outbox').all();
    const pending = f.core.actorScheduler.actorFor(f.session.sessionId).enqueue(() => finish.promise);
    await assert.rejects(f.prepare(30, 1000), /drain expired/);
    assert.equal(f.core.maintenance.status().phase, 'running');
    finish.resolve(); await pending;
    const lease = await f.prepare(1000, 1100);
    const recoveries = fake.acknowledgementRecoveryCount;
    await delay(50);
    assert.equal(fake.acknowledgementRecoveryCount, recoveries);
    await delay(1100);
    assert.equal(f.core.maintenance.status().phase, 'running');
    await assert.rejects(f.rpc('system.maintenance.commit', { ...f.owner, token: lease.token }), /readiness changed/);
    const created = await f.rpc<{teamId: string}>('team.create', { clientId: 'maintenance-test', requestId: 'resumed', name: 'resumed' });
    assert.ok(created.teamId);
    assert.deepEqual(f.core.database.raw.prepare('SELECT request_hash,submission_state,prompt_submitted FROM outbox').all(), original);
    assert.equal(fake.submitCount, 1); assert.equal(fake.stopCount, 0); assert.equal(f.exits(), 0);
  } finally { finish.resolve(); await f.dispose(); }
});
