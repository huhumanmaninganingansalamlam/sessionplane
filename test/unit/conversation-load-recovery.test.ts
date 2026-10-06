import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { ConversationLoadRecovery } from '../../src/core/conversation-load-recovery.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TeamDirectory } from '../../src/core/team-directory.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { PageMutationMutex } from '../../src/browser/page-mutex.ts';
import { ActorScheduler } from '../../src/scheduler/actor-scheduler.ts';
import { ProbeCoordinator } from '../../src/scheduler/probe-coordinator.ts';
import type { LoadSurface } from '../../src/providers/chatgpt/conversation-load-recovery.ts';
import { ConversationLoadRecoveryRepository } from '../../src/storage/conversation-load-recovery-repository.ts';
import { startCore } from '../../src/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { OutboxRepository } from '../../src/storage/outbox-repository.ts';
import { PassThrough } from 'node:stream';
import { runMcpServer } from '../../src/mcp/server.ts';

function fixture(count = 3) {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-load-recovery-'));
  const database = SessionPlaneDatabase.open(path.join(root, 'state.sqlite'));
  const directory = new TeamDirectory(database);
  const registry = new PageRegistry();
  const scheduler = new ActorScheduler(database);
  let clock = Date.parse('2026-10-06T00:00:00Z');
  const now = () => clock;
  const probes = new ProbeCoordinator({ database, now: () => new Date(clock), successIntervalMs: 30_000,
    min429BackoffMs: 60_000, max429BackoffMs: 900_000, jitterRatio: 0 });
  const clicks: string[] = [];
  const controls: { id: string; sessionId: string; pageKey: string; surface: LoadSurface; beforeClick?: () => void; response?: (r: unknown) => void }[] = [];
  for (let n = 0; n < count; n++) {
    const team = directory.createTeam({ clientId: 'fixture' });
    const session = directory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const control = { id: `conversation-${n}`, sessionId: session.sessionId, pageKey: '',
      surface: { kind: 'retry', reason: 'conversation-load-retry', clicked: false, loadError: true } as LoadSurface } as typeof controls[number];
    const fake = { url: () => `https://chatgpt.com/c/${control.id}`, isClosed: () => false,
      mainFrame: () => ({}), on: (event: string, cb: (r: unknown) => void) => { if (event === 'response') control.response = cb; },
      off: () => {}, evaluate: async (_: unknown, input: { click: boolean }) => {
        if (input.click) control.beforeClick?.();
        const clicked = input.click && control.surface.kind === 'retry';
        if (clicked) clicks.push(control.id);
        return { ...control.surface, clicked };
      } } as unknown as Page;
    control.pageKey = registry.registerPage(fake).pageKey;
    database.raw.prepare('UPDATE sessions SET current_generation=1, conversation_id=?, page_key=? WHERE session_id=?')
      .run(control.id, control.pageKey, session.sessionId);
    database.raw.prepare(`INSERT INTO generations(session_id,generation,team_brief_version,prompt_hash,submission_state,
      submitted_user_message_id, answer_text, prompt_submitted) VALUES (?,1,0,'original-hash','submission_unknown','retained-anchor','retained-partial',1)`)
      .run(session.sessionId);
    registry.bindPage(control.pageKey, { sessionId: session.sessionId, generation: 1, conversationId: control.id });
    controls.push(control);
  }
  const make = () => new ConversationLoadRecovery({ database, registry, scheduler, probes,
    pageMutex: new PageMutationMutex(), chatgptUrl: 'https://chatgpt.com' }, now);
  return { database, registry, scheduler, controls, clicks, probes, make, advance: (ms = 5_000) => { clock += ms; },
    dispose: async (...services: ConversationLoadRecovery[]) => { await Promise.all(services.map(s => s.close())); scheduler.close(); database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('one coalesced global round-robin loop spaces simultaneous tab failures and preserves anchors/partial answers', async () => {
  const f = fixture(), service = f.make();
  const before = f.database.raw.prepare('SELECT * FROM generations').all();
  try {
    await Promise.all([service.sweep(), service.sweep(), service.sweep()]);
    assert.deepEqual(f.clicks, ['conversation-0']);
    f.advance(4_999); await service.sweep(); assert.equal(f.clicks.length, 1);
    f.advance(1); await service.sweep(); f.advance(); await service.sweep(); f.advance(); await service.sweep();
    assert.deepEqual(f.clicks, ['conversation-0', 'conversation-1', 'conversation-2', 'conversation-0']);
    assert.deepEqual(f.database.raw.prepare('SELECT * FROM generations').all(), before);
  } finally { await f.dispose(service); }
});

test('99 to100 never clicks101, exhaustion notice is durable and emitted once', async () => {
  const f = fixture(1), service = f.make();
  try {
    await service.sweep(); const r = service.repository.get('conversation-0')!;
    r.attempts = 99; service.repository.save(r);
    f.advance(); await service.sweep(); assert.equal(service.repository.get(r.conversationId)!.attempts, 100);
    const before = f.database.raw.prepare('SELECT * FROM generations').all();
    f.advance(); await service.sweep(); const exhausted = service.repository.get(r.conversationId)!;
    assert.deepEqual(f.database.raw.prepare('SELECT * FROM generations').all(), before);
    assert.equal(exhausted.state, 'exhausted'); assert.ok(exhausted.notifiedAt);
    for (let n = 0; n < 3; n++) { f.advance(); await service.sweep(); }
    assert.equal(f.clicks.length, 2);
    assert.equal(f.database.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload_json,'$.state')='exhausted'").get()!.n, 1);
  } finally { await f.dispose(service); }
});

test('isolated MCP get/wait displays required user review without terminalizing or resending', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-load-notice-mcp-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, startBrowser: false, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'notice-fixture' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const generation = await core.actorScheduler.startGeneration({ sessionId: session.sessionId, teamBriefVersion: 0, promptHash: 'original-hash' });
    await core.actorScheduler.updateGeneration(session.sessionId, generation.generation, {
      sessionState: 'observing', providerState: 'unknown', submissionState: 'submission_unknown',
      promptSubmitted: true, submittedUserMessageId: 'original-anchor', conversationId: 'fixture-conversation',
      answerText: 'retained-partial'.repeat(5000),
    });
    const request = new OutboxRepository(core.database).insert({ clientId: 'notice-fixture', requestId: 'original-request',
      teamId: team.teamId, roleId: session.roleId, sessionId: session.sessionId, generation: generation.generation,
      payloadJson: '{}', requestHash: 'original-request-hash', createdAt: new Date().toISOString() });
    const repo = core.conversationLoadRecovery.repository;
    const record = { conversationId: 'fixture-conversation', url: 'https://chatgpt.com/c/fixture-conversation',
      sessionId: session.sessionId, pageKey: 'fixture-page', bindingEpoch: 1, attempts: 100,
      state: 'exhausted' as const, reason: '100-load-retries-exhausted', lastOutcome: 'clicked' as const,
      lastCheckedAt: '2026-10-06T00:00:00Z', lastAttemptAt: '2026-10-06T00:00:00Z', notifiedAt: '2026-10-06T00:01:00Z' };
    repo.save(record);
    const before = core.database.raw.prepare('SELECT * FROM generations').all();
    const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: `sessionplane_${name}`,
      arguments: args, socketPath: config.socketPath, timeoutMs: 3000, maxLineBytes: config.rpcMaxLineBytes });
    const teamResult = await invoke('team_get', { teamId: team.teamId });
    const required = (teamResult.structuredContent.roles as Record<string, any>[])[0]!;
    assert.equal(required.requestRef, request.outboxId); assert.equal(required.recovery.url, record.url);
    assert.match(JSON.stringify(teamResult.structuredContent), /User review required/);
    const exact = await invoke('team_get', { teamId: team.teamId, requestRef: request.outboxId });
    const waited = await invoke('wait', { teamId: team.teamId, requestRefs: [request.outboxId], waitMs: 30_000 });
    for (const result of [exact.structuredContent.request, (waited.structuredContent.results as Record<string, unknown>[])[0]!]) {
      const value = result as Record<string, any>;
      assert.equal(value.status, 'recovery_required'); assert.equal(value.recovery.state, 'exhausted');
      assert.equal(value.userActionRequired, true); assert.equal(value.recovery.url, record.url);
      assert.equal(value.recovery.attempts, 100); assert.equal(value.recovery.reason, '100-load-retries-exhausted');
      assert.equal(value.submissionState, 'submission_unknown');
      assert.equal(value.promptSubmitted, true); assert.equal(value.terminal, false);
      assert.equal(value.submittedUserMessageId, 'original-anchor'); assert.equal(value.waitExpired, false);
    }
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations').all(), before);
    assert.equal(core.database.raw.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 1);
    const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
    let wire = ''; output.on('data', chunk => { wire += String(chunk); });
    const server = runMcpServer({ config, input, output, error });
    input.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sessionplane_team_get', arguments: { teamId: team.teamId, requestRef: request.outboxId } } },
    ].map(value => JSON.stringify(value) + '\n').join(''));
    await server;
    const response = wire.trim().split('\n').map(line => JSON.parse(line)).find(value => value.id === 2);
    const visible = JSON.parse(response.result.content[0].text);
    assert.equal(visible.truncatedInText, true);
    assert.equal(visible.recoveryRequired.length, 1, 'role and exact result display the same required user review');
    assert.equal(visible.recoveryRequired[0].userActionRequired, true);
    assert.equal(visible.recoveryRequired[0].recovery.url, record.url);
    assert.match(visible.recoveryRequired[0].message, /Review the original conversation/);
    assert.equal(response.result.structuredContent.request.submittedUserMessageId, 'original-anchor');
    repo.save({ ...record, state: 'recovered', reason: 'conversation-rendered' });
    assert.equal(((await invoke('team_get', { teamId: team.teamId })).structuredContent.roles as Record<string, any>[])[0]!.userActionRequired, undefined);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('restart and page rebinding retain attempt count, global deadline and fair next tab', async () => {
  const f = fixture(2), first = f.make(); let second: ConversationLoadRecovery | undefined;
  try {
    await first.sweep(); const deadline = first.repository.nextAllowedAt(); await first.close();
    const binding = f.registry.getBinding(f.controls[0]!.pageKey);
    f.registry.bindPage(binding.pageKey, { sessionId: binding.sessionId!, generation: 1, conversationId: binding.conversationId! });
    second = f.make(); await second.sweep(); assert.equal(f.clicks.length, 1);
    assert.equal(second.repository.nextAllowedAt(), deadline);
    assert.equal(second.repository.get('conversation-0')!.attempts, 1);
    f.advance(); await second.sweep(); assert.deepEqual(f.clicks, ['conversation-0', 'conversation-1']);
  } finally { await f.dispose(first, ...(second ? [second] : [])); }
});

test('manual/scheduled success immediately ends recovery, drafts/generation/missing buttons stay held', async () => {
  const f = fixture(1), service = f.make();
  try {
    for (const reason of ['manual-draft', 'generation-active', 'load-retry-button-unavailable', 'verification-or-permission']) {
      f.controls[0]!.surface = { kind: 'held', reason, clicked: false, loadError: true };
      f.advance(); await service.sweep(); assert.equal(f.clicks.length, 0);
      assert.equal(service.repository.get('conversation-0')!.reason, reason);
    }
    f.controls[0]!.surface = { kind: 'retry', reason: 'conversation-load-retry', clicked: false, loadError: true };
    f.advance(); await service.sweep(); assert.equal(f.clicks.length, 1);
    f.controls[0]!.surface = { kind: 'normal', reason: 'conversation-rendered', clicked: false, loadError: false };
    await service.sweep(); assert.equal(service.repository.get('conversation-0')!.state, 'recovered');
    f.advance(); await service.sweep(); assert.equal(f.clicks.length, 1);
  } finally { await f.dispose(service); }
});

test('changed surface in the last click guard dispatches nothing and retains request data', async () => {
  const f = fixture(1), service = f.make();
  try {
    f.controls[0]!.beforeClick = () => { f.controls[0]!.surface = { kind: 'held', reason: 'manual-draft', clicked: false, loadError: true }; };
    await service.sweep(); assert.equal(f.clicks.length, 0);
    assert.equal(service.repository.get('conversation-0')!.attempts, 0);
    assert.equal(service.repository.get('conversation-0')!.lastOutcome, 'not-clicked');
  } finally { await f.dispose(service); }
});

test('list429 keeps sanitized scoped evidence across restart without holding unrelated UI recovery', async () => {
  const f = fixture(2), service = f.make(); const resumed = f.make();
  const before = f.database.raw.prepare('SELECT * FROM generations').all();
  try {
    await service.sweep();
    const response = (headers: Record<string, string>) => ({ status: () => 429,
      url: () => 'https://chatgpt.com/backend-api/f/conversations/private-id?token=private-query',
      request: () => ({ method: () => 'GET' }), headers: () => headers,
      body: () => { throw Error('Response bodies must never be collected'); } });
    f.controls[0]!.response!(response({ 'retry-after': '600', 'ratelimit-remaining': '0', 'x-ratelimit-scope': 'endpoint',
      'x-ratelimit-reset-requests': '1m2s', 'ratelimit-limit': 'private-label',
      'set-cookie': 'private-cookie', authorization: 'private-token', 'x-extra': 'private-extra' }));
    const evidence = () => f.database.raw.prepare("SELECT payload_json FROM events WHERE event_type='provider.rate-limit-observed' ORDER BY sequence").all()
      .map(r => JSON.parse(r.payload_json as string));
    assert.equal(evidence().length, 1);
    assert.deepEqual(evidence()[0].headers, { 'ratelimit-remaining': '0', 'x-ratelimit-reset-requests': '1m2s',
      'x-ratelimit-scope': 'endpoint', 'retry-after': '600' });
    assert.equal(evidence()[0].endpointCategory, 'conversation-list');
    assert.equal(evidence()[0].method, 'GET');
    assert.equal(evidence()[0].serverScope, 'endpoint');
    assert.equal(evidence()[0].policyScope, 'chatgpt:conversation-list');
    assert.equal(evidence()[0].retryAfterSource, 'valid-header');
    await service.close(); f.advance(); await resumed.sweep(); assert.equal(f.clicks.length, 2);
    assert.equal(resumed.repository.pacing().account, null);
    assert.equal(resumed.repository.serviceNextAllowedAt('conversation-0'), null);
    f.controls[1]!.response!(response({}));
    assert.equal(evidence()[1].retryAfterSource, 'header-absent-fallback');
    assert.equal(evidence()[1].fallbackMs, 900_000);
    assert.equal(evidence()[1].policyUntil, '2026-10-06T00:15:05.000Z');
    assert.equal(evidence()[1].effectiveUntil, '2026-10-06T00:00:10.000Z');
    f.controls[1]!.response!(response({ 'retry-after': 'private-invalid' }));
    assert.equal(evidence()[2].retryAfterSource, 'header-invalid-fallback');
    assert.deepEqual(evidence()[2].headers, {});
    assert.ok(!JSON.stringify(evidence()).includes('private-'));
    await resumed.sweep(); assert.equal(f.clicks.length, 2);
    assert.deepEqual(f.database.raw.prepare('SELECT * FROM generations').all(), before);
  } finally { await f.dispose(service, resumed); }
});

test('backend cadence stays separate; explicit refresh and UI retries share only their durable5s gap', async () => {
  const f = fixture(1), service = f.make();
  try {
    const before = f.database.raw.prepare('SELECT * FROM generations').all();
    await f.probes.run('chatgpt:default', async () => ({kind:'pending', observationTransport:'fresh',
      responseMessageId:null,answerText:null,reason:'fixture',retryAfterMs:null,nextCheckAt:null}));
    assert.equal(service.repository.reserveRefresh('2026-10-06T00:00:00.000Z', 5_000), true);
    assert.equal(service.repository.reserveRefresh('2026-10-06T00:00:04.999Z', 5_000), false);
    await service.sweep(); assert.equal(f.clicks.length, 0);
    f.advance(); await service.sweep(); assert.equal(f.clicks.length, 1);
    assert.deepEqual(f.database.raw.prepare('SELECT * FROM generations').all(), before);
  } finally { await f.dispose(service); }
});

test('a cooldown arriving during the actor wait defers the click without spending an attempt', async () => {
  const f = fixture(1), service = f.make();
  let release!: () => void;
  try {
    const before = f.database.raw.prepare('SELECT * FROM generations').all();
    const held = f.scheduler.actorFor(f.controls[0]!.sessionId).enqueue(() => new Promise<void>(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const sweep = service.sweep();
    await new Promise(resolve => setImmediate(resolve));
    f.probes.defer('chatgpt:default', '2026-10-06T00:15:00.000Z');
    release(); await Promise.all([held, sweep]);
    assert.deepEqual(f.clicks, []);
    const waiting = service.repository.get('conversation-0')!;
    assert.equal(waiting.reason, 'service-or-ui-cooldown');
    assert.equal(waiting.attempts, 0);
    assert.equal(waiting.lastAttemptAt, null);
    f.advance(900_000); await service.sweep();
    assert.deepEqual(f.clicks, ['conversation-0']);
    assert.deepEqual(f.database.raw.prepare('SELECT * FROM generations').all(), before);
  } finally { release?.(); await f.dispose(service); }
});

test('closing/reopening SQLite preserves100-attempt receipt and global spacing without altering original data', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-load-db-restart-'));
  const file = path.join(root, 'state.sqlite');
  const first = SessionPlaneDatabase.open(file); const repo = new ConversationLoadRecoveryRepository(first);
  const record = { conversationId: 'retained-conversation', url: 'https://chatgpt.com/c/retained-conversation',
    sessionId: 'retained-session', pageKey: 'old-page', bindingEpoch: 2, attempts: 100,
    state: 'exhausted' as const, reason: '100-load-retries-exhausted', lastOutcome: 'clicked' as const,
    lastCheckedAt: '2026-10-06T00:00:00.000Z', lastAttemptAt: '2026-10-06T00:00:00.000Z', notifiedAt: '2026-10-06T00:01:00.000Z' };
  repo.save(record); repo.defer('2026-10-06T00:15:00.000Z', record.lastCheckedAt); first.close();
  const second = SessionPlaneDatabase.open(file);
  try { const restored = new ConversationLoadRecoveryRepository(second); assert.deepEqual(restored.get(record.conversationId), record);
    assert.equal(restored.nextAllowedAt(), '2026-10-06T00:15:00.000Z');
    assert.equal(restored.reserveTurn(record, '2026-10-06T00:10:00.000Z', 60_000), false);
  } finally { second.close(); rmSync(root, { recursive: true, force: true }); }
});

test('detail Retry-After holds only its conversation; explicit broad scope holds all recovery until expiry', async () => {
  const f=fixture(2), service=f.make();
  try {
    await service.sweep();
    const response=(path:string,headers:Record<string,string>)=>({status:()=>429,url:()=>`https://chatgpt.com${path}`,
      request:()=>({method:()=> 'GET'}),headers:()=>headers});
    f.controls[0]!.response!(response('/backend-api/conversation/conversation-0',{'retry-after':'12'}));
    f.advance();await service.sweep();assert.deepEqual(f.clicks,['conversation-0','conversation-1']);
    f.advance();await service.sweep();assert.equal(f.clicks.length,2);
    assert.equal(service.repository.get('conversation-0')!.attempts,1);
    f.controls[1]!.response!(response('/backend-api/conversations',{'retry-after':'20','ratelimit-scope':'account'}));
    f.advance(19_999);await service.sweep();assert.equal(f.clicks.length,2);
    f.advance(1);await service.sweep();assert.equal(f.clicks.length,3);
  } finally { await f.dispose(service); }
});
