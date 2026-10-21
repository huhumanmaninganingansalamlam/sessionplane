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
import { SessionRepository } from '../../src/storage/session-repository.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import { CoreMaintenance } from '../../src/core/maintenance.ts';
import { inspectChatGptPageReady } from '../../src/providers/chatgpt/submission.ts';

async function fixture(fake = new FakeProviderAdapter(), observationTimeoutMs = 10_000) {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-maintenance-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
    observationActiveSweepMs: 10, observationQuietSweepMs: 20, observationQuietWindowMs: 10,
    backendRequestTimeoutMs: observationTimeoutMs });
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

test('coordinated maintenance lets admitted work finish and defers a new call without dispatch or cancellation', async () => {
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
    let lease = await f.rpc<{ phase: string; token: string }>('system.maintenance.quiesce', f.owner);
    assert.equal(f.core.maintenance.status().phase, 'draining');
    const newCall = { clientId: 'maintenance-test', requestId: 'must-not-be-issued', name: 'blocked' };
    const deferred = callRpc<{ teamId: string }>({ socketPath: f.core.config.socketPath,
      method: 'team.create', params: newCall, timeoutMs: 50 });
    await delay(150);
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE request_id='must-not-be-issued'").get()!.n, 0);
    finish.resolve();
    while (lease.phase !== 'ready') {
      await delay(10);
      lease = await f.rpc('system.maintenance.quiesce', { ...f.owner, token: lease.token });
    }
    assert.equal(lease.phase, 'ready');
    assert.equal(f.core.maintenance.status().activeOperations, 0);
    assert.equal(fake.submitCount, 1);
    const saved = f.core.database.raw.prepare('SELECT request_hash,prompt_submitted FROM outbox').all();
    await delay(30);
    assert.equal(f.core.maintenance.status().phase, 'ready');
    assert.deepEqual(f.core.database.raw.prepare('SELECT request_hash,prompt_submitted FROM outbox').all(), saved);
    await f.rpc('system.maintenance.resume', { ...f.owner, token: lease.token });
    assert.ok((await deferred).teamId);
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE request_id='must-not-be-issued'").get()!.n, 1);
    assert.equal(f.core.maintenance.status().phase, 'running');
  } finally { finish.resolve(); await f.dispose(); }
});

test('stalled passive Chat readiness count times out and releases admission without disabling its checks', async t => {
  const maintenance = new CoreMaintenance(), entered = Promise.withResolvers<void>(), count = Promise.withResolvers<number>();
  const page = { waitForLoadState: async () => {}, waitForTimeout: async () => {}, evaluate: async () => null,
    locator: () => ({ count: () => { entered.resolve(); return count.promise; } }) } as unknown as Page;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const reading = maintenance.rpc(() => inspectChatGptPageReady(page, 'exact-page'));
    await entered.promise;
    const rejected = assert.rejects(reading, /Passive provider readiness observation timed out/);
    const lease = maintenance.quiesce(undefined, () => true);
    assert.equal(lease.phase, 'draining');
    t.mock.timers.tick(5001); await rejected;
    assert.equal(maintenance.quiesce(lease.token, () => true).phase, 'ready');
    count.resolve(0);
    await count.promise;
    assert.equal(maintenance.status().activeOperations, 0);
  } finally { count.resolve(0); maintenance.resume(); t.mock.timers.reset(); }
});

test('timed-out renderer observation no longer holds drain and late evidence cannot finish a paused request', async () => {
  const fake = new FakeProviderAdapter(), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const open = fake.openObservation.bind(fake);
  fake.openObservation = async request => {
    const source = await open(request), observe = source.observe.bind(source);
    source.observe = async () => { entered.resolve(); await finish.promise; return observe(); };
    return source;
  };
  const f = await fixture(fake, 30);
  try {
    await f.rpc('session.send', { clientId: 'maintenance-test', requestId: 'retained', sessionId: f.session.sessionId,
      prompt: 'Retain ACK and live provider', sessionDeadlineSec: 600 });
    await entered.promise;
    const requests = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    let lease = await f.rpc<{phase: string; token: string}>('system.maintenance.quiesce', f.owner);
    assert.equal(lease.phase, 'draining', 'The bounded observation must finish before handover');
    await delay(60);
    lease = await f.rpc('system.maintenance.quiesce', { ...f.owner, token: lease.token });
    assert.equal(lease.phase, 'ready', 'Unsettled raw read is not a live mutation');
    const generations = f.core.database.raw.prepare('SELECT * FROM generations').all();
    finish.resolve();
    await delay(30);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM generations').all(), generations);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM outbox').all(), requests);
    assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).terminal, false);
    assert.equal(f.fake.submitCount, 1); assert.equal(f.fake.stopCount, 0);
    await assert.rejects(f.rpc('system.maintenance.commit', { ...f.owner, token: lease.token }), /Internal error/);
    assert.equal(f.exits(), 1);
  } finally { finish.resolve(); await f.dispose(); }
});

test('unfinished opted-in observation hands over only after the actual recovery operation drains', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  try {
    await f.rpc('session.send', { clientId: 'maintenance-test', requestId: 'original', sessionId: f.session.sessionId,
      prompt: 'preserved original', sessionDeadlineSec: 600 });
    // Model the persisted opt-in request without changing the provider generation.
    f.core.database.raw.prepare("UPDATE outbox SET payload_json=json_set(payload_json,'$.thinkingFailureRecovery',json('true'))").run();
    const snapshot = new SessionRepository(f.core.database.raw).getSnapshot(f.session.sessionId)!;
    const original = f.core.database.raw.prepare('SELECT * FROM outbox').all();
    const generations = f.core.database.raw.prepare('SELECT * FROM generations').all();
    f.core.receipts.execute({ clientId: 'maintenance-test', requestId: `thinking-failure-configuration:${original[0]!.outbox_id}`,
      method: 'session.thinking-failure.configuration', payload: {}, operation: () => ({ model: {} }) });
    f.core.thinkingFailureRecovery.services.ui.reconcileFailure = async () => { entered.resolve(); await finish.promise; return {}; };
    const recovery = f.core.thinkingFailureRecovery.observe({ ...snapshot, errorCode: 'provider.actionable-alert' });
    await entered.promise;
    let lease = await f.rpc<{ phase: string; token: string }>('system.maintenance.quiesce', f.owner);
    assert.equal(lease.phase, 'draining');
    assert.ok(f.core.maintenance.status().activeOperations > 0);
    finish.resolve(); await recovery;
    while (lease.phase !== 'ready') {
      await delay(10);
      lease = await f.rpc('system.maintenance.quiesce', { ...f.owner, token: lease.token });
    }
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM outbox').all(), original);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM generations').all(), generations);
    assert.equal(f.fake.stopCount, 0);
    await f.rpc('system.maintenance.resume', { ...f.owner, token: lease.token });
    f.core.thinkingFailureRecovery.restore();
    await delay(20);
    assert.equal(f.fake.submitCount, 1);
    const health = await f.rpc<{maintenance: {durableRecoveryHandover: boolean}}>('system.health');
    assert.equal(health.maintenance.durableRecoveryHandover, true);
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


test('handover releases an admitted long read wait without stopping the provider generation', async () => {
  const f = await fixture();
  try {
    await f.rpc('session.send', { clientId: 'maintenance-test', requestId: 'long-read', sessionId: f.session.sessionId,
      prompt: 'preserved original', sessionDeadlineSec: 600 });
    const waiting = f.rpc<any>('workflow.wait', { teamId: f.session.teamId,
      requestRefs: [f.core.database.raw.prepare('SELECT outbox_id FROM outbox').get()!.outbox_id],
      waitMs: 1800000, untilResult: false });
    while (!f.core.actorScheduler.actorFor(f.session.sessionId).subscriberCount) await delay(1);
    const lease = await f.prepare();
    const returned = await waiting;
    assert.equal(lease.phase, 'ready');
    assert.equal(returned.results[0].terminal, false);
    assert.equal(f.fake.stopCount, 0);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).generation, 1);
    await f.rpc('system.maintenance.resume', { ...f.owner, token: lease.token });
  } finally { await f.dispose(); }
});
