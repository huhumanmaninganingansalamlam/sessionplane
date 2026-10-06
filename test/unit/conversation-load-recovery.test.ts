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
  return { database, registry, scheduler, controls, clicks, probes, make, advance: (ms = 60_000) => { clock += ms; },
    dispose: async (...services: ConversationLoadRecovery[]) => { await Promise.all(services.map(s => s.close())); scheduler.close(); database.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('one coalesced global round-robin loop spaces simultaneous tab failures and preserves anchors/partial answers', async () => {
  const f = fixture(), service = f.make();
  const before = f.database.raw.prepare('SELECT * FROM generations').all();
  try {
    await Promise.all([service.sweep(), service.sweep(), service.sweep()]);
    assert.deepEqual(f.clicks, ['conversation-0']);
    await service.sweep(); assert.equal(f.clicks.length, 1);
    f.advance(); await service.sweep(); f.advance(); await service.sweep(); f.advance(); await service.sweep();
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
    f.advance(); await service.sweep(); const exhausted = service.repository.get(r.conversationId)!;
    assert.equal(exhausted.state, 'exhausted'); assert.ok(exhausted.notifiedAt);
    for (let n = 0; n < 3; n++) { f.advance(); await service.sweep(); }
    assert.equal(f.clicks.length, 2);
    assert.equal(f.database.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE json_extract(payload_json,'$.state')='exhausted'").get()!.n, 1);
  } finally { await f.dispose(service); }
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

test('429 Retry-After from a bound page defers all tabs and survives recovery owner restart', async () => {
  const f = fixture(2), service = f.make(); const resumed = f.make();
  try {
    await service.sweep();
    f.controls[0]!.response!({ status: () => 429, url: () => 'https://chatgpt.com/backend-api/conversation', headers: () => ({ 'retry-after': '600' }) });
    await service.close(); f.advance(60_000); await resumed.sweep(); assert.equal(f.clicks.length, 1);
    f.advance(540_000); await resumed.sweep(); assert.equal(f.clicks.length, 2);
  } finally { await f.dispose(service, resumed); }
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
