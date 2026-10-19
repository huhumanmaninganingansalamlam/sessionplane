import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-outcome-wait-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 600_000 });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const invoke = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    await invokeMcpTool({ name: 'sessionplane_' + name, arguments: args, socketPath: config.socketPath,
      timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes, ...(signal ? { signal } : {}) });
  const team = (await invoke('team_create', { requestId: 'team' })).structuredContent;
  const sent = (await invoke('send', { teamId: team.teamId,
    roleRef: (team.roles as any[])[0].roleRef, requestId: 'send', prompt: 'Wait for the existing answer' })).structuredContent;
  const untilSubscribed = async (sessionId: string) => {
    for (let i = 0; i < 100; i++) {
      if (core.actorScheduler.actorFor(sessionId).subscriberCount) return;
      await flush();
    }
    assert.fail('Wait did not subscribe');
  };
  return { core, fake, invoke, team, sent, untilSubscribed,
    close: async () => { await core.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('short workflow wait holds progress/429 for a full minute and cancellation only releases its subscription', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let returned = false;
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef], waitMs: 20_000 })
      .then(r => { returned = true; return r; });
    await f.untilSubscribed(f.sent.sessionId as string);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { reason: 'backend-http-429', observationTransport: 'deferred' });
    await flush();
    await flush();
    assert.equal(returned, false, 'Transient progress must not wake the model');
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { reason: 'provider-network-activity', observationTransport: 'dom' });
    await flush();
    await flush();
    assert.equal(returned, false, 'Hither provider-network-activity must stay inside the external wait');
    t.mock.timers.tick(59_999);
    await flush();
    assert.equal(returned, false, 'A sub-minute request must not expire early');
    t.mock.timers.tick(1);
    const result = (await waiting).structuredContent.results as any[];
    assert.equal(result[0].waitExpired, true);
    assert.equal(result[0].terminal, false);
    assert.equal(result[0].submittedUserMessageId, f.sent.submittedUserMessageId);
    assert.equal(result[0].conversationUsage, undefined);
    assert.equal(result[0].evidence, undefined);
    const view = (await f.invoke('team_get', { teamId: f.team.teamId, requestRef: f.sent.requestRef })).structuredContent.request as any;
    assert.notEqual(view.activity.lastGenerationStateChange?.eventType, 'generation.backend-deferred');
    assert.equal(view.activity.latestStoredArtifactChangeAt, null);

    const controller = new AbortController();
    const cancelled = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef], waitMs: 7_260_000 }, controller.signal);
    await f.untilSubscribed(f.sent.sessionId as string);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    for (let i = 0; i < 100 && f.core.actorScheduler.actorFor(f.sent.sessionId as string).subscriberCount; i++) await flush();
    assert.equal(f.core.actorScheduler.actorFor(f.sent.sessionId as string).subscriberCount, 0);
    assert.equal(f.core.teamDirectory.getSession(f.sent.sessionId as string).terminal, false);
    assert.equal(f.fake.submitCount, 1);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('one completed result wakes a multi-request long wait immediately; actual errors also wake without replay', async () => {
  const f = await fixture();
  try {
    const roles = (await f.invoke('role_create', { teamId: f.team.teamId, requestId: 'role', roleKey: 'other' })).structuredContent.roles as any[];
    const other = (await f.invoke('send', { teamId: f.team.teamId, roleRef: roles.find(r => r.roleKey === 'other').roleRef,
      requestId: 'other-send', prompt: 'Independent existing work' })).structuredContent;
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef, other.requestRef], waitMs: 7_260_000 });
    await f.untilSubscribed(f.sent.sessionId as string);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, {
      sessionState: 'complete', providerState: 'complete', responseMessageId: 'exact-final', answerText: 'Exact result',
    });
    const result = (await waiting).structuredContent.results as any[];
    assert.equal(result[0].answerText, 'Exact result');
    assert.equal(result[0].terminal, true);
    assert.equal(result[1].terminal, false);
    assert.equal(f.core.actorScheduler.actorFor(other.sessionId as string).subscriberCount, 0);
    const errorWait = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [other.requestRef], waitMs: 7_260_000 });
    await f.untilSubscribed(other.sessionId as string);
    await f.core.actorScheduler.updateGeneration(other.sessionId as string, 1,
      { providerState: 'blocked', reason: 'provider-actionable-alert' });
    const blocked = (await errorWait).structuredContent.results as any[];
    assert.equal(blocked[0].providerState, 'blocked');
    assert.equal(blocked[0].waitExpired, false);
    assert.equal(f.fake.submitCount, 2);
  } finally { await f.close(); }
});
