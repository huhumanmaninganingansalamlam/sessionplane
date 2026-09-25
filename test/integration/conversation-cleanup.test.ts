import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import type { ProviderRecoveryRequest } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('conversation deletion protects unresolved work, retains answers and persists uncertain outcomes', async () => {
  class DeletingProvider extends FakeProviderAdapter {
    deleted = new Set<string>();
    loseAcknowledgement = false;
    async openDeletion({ session }: ProviderRecoveryRequest) {
      return {
        deleteOnce: async () => {
          assert.ok(!this.deleted.has(session.conversationId!));
          this.deleted.add(session.conversationId!);
          if (this.loseAcknowledgement) throw new Error('Connection lost after provider deletion');
          return true;
        },
        close: async () => {},
      };
    }
  }
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cleanup-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
    observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
  const fake = new DeletingProvider();
  const options = { config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } };
  let core = await startCore(options);
  let sequence = 0;
  const rpc = <T>(method: string, params: object) => callRpc<T>({
    socketPath: config.socketPath, method, params: { clientId: 'cleanup-client', ...params }, timeoutMs: 5000,
  });
  const create = async () => {
    const id = String(++sequence);
    const team = await rpc<{ teamId: string }>('team.create', { requestId: 'team-' + id, name: id });
    const session = await rpc<SessionSnapshot>('session.create', {
      requestId: 'session-' + id, teamId: team.teamId, roleKey: 'main', provider: 'chatgpt',
    });
    await rpc('session.send', { requestId: 'send-' + id, sessionId: session.sessionId, prompt: id });
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await rpc<SessionSnapshot>('session.wait', { sessionId: session.sessionId, generation: 1, waitMs: 10 });
      if (fake.autoFinalText === null || state.terminal) return state;
    }
    throw new Error('Final was not observed');
  };
  const deletion = (session: SessionSnapshot, requestId: string) => ({ requestId,
    sessionId: session.sessionId, generation: session.generation,
    conversationId: session.conversationId, outputsRetrieved: true });
  try {
    const active = await create();
    await assert.rejects(rpc('session.delete', deletion(active, 'active')),
      (error: unknown) => JSON.stringify(error).includes('session.cleanup-not-ready'));
    assert.equal(fake.deleted.size, 0);
    fake.autoFinalText = 'Retrieved answer';
    const complete = await create();
    assert.equal(complete.answerText, 'Retrieved answer');
    const input = deletion(complete, 'complete');
    const result = await rpc<{ deleted: boolean }>('session.delete', input);
    assert.equal(result.deleted, true);
    assert.ok(fake.deleted.has(complete.conversationId!));
    assert.deepEqual(await rpc('session.delete', input), result);
    const retained = await rpc<SessionSnapshot>('session.get', { sessionId: complete.sessionId });
    assert.equal(retained.answerText, complete.answerText);
    assert.equal(retained.sessionState, 'superseded');
    const uncertain = await create();
    fake.loseAcknowledgement = true;
    const unknown = await rpc<{ errorCode: string }>('session.delete', deletion(uncertain, 'uncertain'));
    assert.equal(unknown.errorCode, 'provider.deletion-unknown');
    await core.close();
    core = await startCore(options);
    assert.deepEqual(await rpc('session.delete', deletion(uncertain, 'uncertain-new-id')), unknown);
    assert.deepEqual(await rpc('session.delete', deletion(uncertain, 'uncertain')), unknown);
    await assert.rejects(rpc('session.send', { requestId: 'send-after-delete',
      sessionId: uncertain.sessionId, prompt: 'Followup' }),
      (error: unknown) => JSON.stringify(error).includes('session.cleanup-pending'));
    const predecessor = await create();
    fake.autoFinalText = null;
    fake.acknowledgementMode = 'missing';
    await assert.rejects(rpc('session.send', { requestId: 'ambiguous-followup',
      sessionId: predecessor.sessionId, prompt: 'Unacknowledged followup' }),
      (error: unknown) => JSON.stringify(error).includes('session.submission-unknown'));
    const ambiguous = await rpc<SessionSnapshot>('session.get', { sessionId: predecessor.sessionId });
    await rpc('session.create', { requestId: 'replace-ambiguous', teamId: ambiguous.teamId,
      roleKey: ambiguous.roleKey, provider: 'chatgpt' });
    await assert.rejects(rpc('session.delete', deletion(ambiguous, 'ambiguous')),
      (error: unknown) => JSON.stringify(error).includes('session.cleanup-not-ready'));
    await assert.rejects(rpc('session.delete', { ...deletion(uncertain, 'wrong-generation'), generation: 2 }),
      (error: unknown) => JSON.stringify(error).includes('session.conversation-mismatch'));
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
