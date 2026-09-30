import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('stop absence and unacknowledged mutation remain unresolved across workflow reads and restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-stop-outcomes-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
    observationActiveSweepMs: 5, observationQuietSweepMs: 5, backendRecoveryAfterMs: 60_000 });
  const fake = new FakeProviderAdapter();
  const options = { config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } };
  let core = await startCore(options);
  const rpc = <T>(method: string, params: object) => callRpc<T>({ socketPath: config.socketPath,
    method, params: method.startsWith('workflow.') ? params : { clientId: 'stop-fixture', ...params }, timeoutMs: 5_000 });
  const rejects = (code: string, outcome: string) => (error: unknown) => {
    assert.ok(error instanceof RpcClientError);
    const data = error.data as { errorCode: string; details: { outcome: string; snapshot: SessionSnapshot } };
    assert.equal(data.errorCode, code);
    assert.equal(data.details.outcome, outcome);
    assert.equal(data.details.snapshot.terminal, false);
    return true;
  };
  try {
    for (const mode of ['unknown', 'throws'] as const) {
      const team = await rpc<{ teamId: string }>('team.create', { requestId: 'team-' + mode });
      const session = await rpc<SessionSnapshot>('session.create', { requestId: 'session-' + mode,
        teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
      await rpc('session.send', { requestId: 'send-' + mode, sessionId: session.sessionId, prompt: mode });
      const requestRef = (core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id = ?')
        .get(session.sessionId) as { outbox_id: string }).outbox_id;
      const stop = { teamId: team.teamId, requestRef, requestId: 'stop-' + mode };
      fake.stopControlAvailable = false;
      const before = fake.stopCount;
      await assert.rejects(rpc('workflow.stop', stop), rejects('provider.stop-unavailable', 'not_attempted'));
      assert.equal(fake.stopCount, before);
      assert.equal(core.teamDirectory.getSession(session.sessionId).terminal, false);

      fake.stopControlAvailable = true;
      fake.stopThrows = mode === 'throws';
      fake.stopOutcome = 'unknown';
      await assert.rejects(rpc('workflow.stop', stop), rejects('provider.stop-unknown', 'unknown'));
      assert.equal(fake.stopCount, before + 1);
      await core.close();
      core = await startCore(options);
      for (const requestId of [stop.requestId, 'another-' + mode]) {
        await assert.rejects(rpc('workflow.stop', { ...stop, requestId }), rejects('provider.stop-unknown', 'unknown'));
      }
      assert.equal(fake.stopCount, before + 1);
      const read = await rpc<{ request: SessionSnapshot & { stopOutcome: { state: string } } }>(
        'workflow.team_get', { teamId: team.teamId, requestRef });
      assert.equal(read.request.terminal, false);
      assert.equal(read.request.submissionState, 'submitted');
      assert.equal(read.request.stopOutcome.state, 'unknown');
      const waited = await rpc<{ results: Array<SessionSnapshot & { stopOutcome: { state: string } }> }>(
        'workflow.wait', { teamId: team.teamId, requestRefs: [requestRef], waitMs: 5 });
      assert.equal(waited.results[0]!.terminal, false);
      assert.equal(waited.results[0]!.stopOutcome.state, 'unknown');
      fake.emitObservation(session.sessionId, { activity: 'none', candidate: {
        responseMessageId: 'final-' + mode, answerText: 'Exact final after uncertain stop',
        terminalMarker: true, streamingMarker: false } });
      for (let i = 0; i < 100 && !core.teamDirectory.getSession(session.sessionId).terminal; i++) {
        await rpc('session.wait', { sessionId: session.sessionId, generation: 1, waitMs: 10 });
      }
      assert.equal(core.teamDirectory.getSession(session.sessionId).sessionState, 'complete');
      assert.equal(fake.submitCount, mode === 'unknown' ? 1 : 2);
      if (mode === 'throws') {
        await rpc('session.send', { requestId: 'next-generation', sessionId: session.sessionId, prompt: 'New fixture work' });
        await assert.rejects(rpc('workflow.stop', stop), (error: unknown) => {
          assert.ok(error instanceof RpcClientError);
          const data = error.data as { errorCode: string; details: { snapshot: SessionSnapshot } };
          assert.equal(data.errorCode, 'provider.stop-unknown');
          assert.equal(data.details.snapshot.generation, 1);
          return true;
        });
        assert.equal(core.teamDirectory.getSession(session.sessionId).generation, 2);
        assert.equal(core.teamDirectory.getSession(session.sessionId).terminal, false);
        assert.equal(fake.stopCount, before + 1);
      }
    }
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an unavailable stop cannot turn ambiguous submission into definite cancellation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-stop-ambiguous-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.acknowledgementMode = 'missing';
  fake.stopControlAvailable = false;
  const core = await startCore({ config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = <T>(method: string, params: object) => callRpc<T>({ socketPath: config.socketPath,
    method, params: { clientId: 'ambiguous-stop', ...params }, timeoutMs: 5_000 });
  try {
    const team = await rpc<{ teamId: string }>('team.create', { requestId: 'team' });
    const session = await rpc<SessionSnapshot>('session.create', { requestId: 'session',
      teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await assert.rejects(rpc('session.send', { requestId: 'send', sessionId: session.sessionId, prompt: 'Unknown acceptance' }));
    await assert.rejects(rpc('session.stop', { requestId: 'stop', sessionId: session.sessionId }),
      (error: unknown) => error instanceof RpcClientError &&
        (error.data as { errorCode: string }).errorCode === 'provider.stop-unavailable');
    const current = core.teamDirectory.getSession(session.sessionId);
    assert.equal(current.submissionState, 'submission_unknown');
    assert.equal(current.terminal, false);
    assert.equal(current.promptSubmitted, true);
    assert.equal(fake.submitCount, 1);
    assert.equal(fake.stopCount, 0);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
