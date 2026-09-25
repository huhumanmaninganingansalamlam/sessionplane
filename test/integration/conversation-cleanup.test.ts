import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import type { ProviderRecoveryRequest, ProviderSubmissionRequest } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('conversation deletion protects unresolved work, retains answers and persists uncertain outcomes', async () => {
  class DeletingProvider extends FakeProviderAdapter {
    deleted = new Set<string>();
    loseAcknowledgement = false;
    confirmDeletion = false;
    duringPrepare: (() => Promise<void>) | null = null;
    override async openSubmission(request: ProviderSubmissionRequest) {
      const operation = await super.openSubmission(request);
      return { ...operation, prepare: async () => {
        await operation.prepare();
        await this.duringPrepare?.();
      } };
    }
    async openDeletion({ session }: ProviderRecoveryRequest) {
      return {
        alreadyDeleted: this.confirmDeletion && this.deleted.has(session.conversationId!),
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
    const successor = await rpc<SessionSnapshot>('session.create', {
      requestId: 'replace-active', teamId: active.teamId, roleKey: active.roleKey, provider: 'chatgpt',
    });
    assert.equal((await rpc<SessionSnapshot>('session.get', { sessionId: active.sessionId })).terminal, false);
    fake.emitObservation(active.sessionId, { candidate: { responseMessageId: 'old-final',
      answerText: 'Answer from predecessor', terminalMarker: true, streamingMarker: false }, activity: 'none' });
    let recovered = active;
    for (let attempt = 0; attempt < 100 && !recovered.terminal; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      recovered = await rpc<SessionSnapshot>('session.wait', { sessionId: active.sessionId, generation: 1, waitMs: 10 });
    }
    assert.equal(recovered.answerText, 'Answer from predecessor');
    await assert.rejects(rpc('session.send', { requestId: 'send-to-predecessor', sessionId: active.sessionId, prompt: 'Wrong route' }),
      (error: unknown) => JSON.stringify(error).includes('session.generation-superseded'));
    assert.equal((await rpc<{ deleted: boolean }>('session.delete', deletion(recovered, 'delete-predecessor'))).deleted, true);
    assert.equal((await rpc<SessionSnapshot>('session.get', { teamId: active.teamId, roleKey: active.roleKey })).sessionId, successor.sessionId);
    const waiting = rpc<SessionSnapshot>('session.wait', { sessionId: successor.sessionId, generation: 0, waitMs: 2000 });
    await rpc('session.create', { requestId: 'replace-unsubmitted', teamId: active.teamId,
      roleKey: active.roleKey, provider: 'chatgpt' });
    const superseded = await waiting;
    assert.equal(superseded.sessionState, 'superseded');
    assert.equal(superseded.waitExpired, false);
    await rpc('team.role.create', { requestId: 'role-retirement', teamId: active.teamId,
      roleKey: 'expert.retiring', roleType: 'expert', reportsToRoleKey: 'main' });
    const retiring = await rpc<SessionSnapshot>('session.create', { requestId: 'retiring-session',
      teamId: active.teamId, roleKey: 'expert.retiring', provider: 'chatgpt' });
    await rpc('session.send', { requestId: 'retiring-send', sessionId: retiring.sessionId, prompt: 'Retiring role review' });
    await rpc('team.role.retire', { requestId: 'retire-role', teamId: active.teamId, roleKey: 'expert.retiring' });
    assert.equal((await rpc<SessionSnapshot>('session.get', { sessionId: retiring.sessionId })).terminal, false);
    fake.emitObservation(retiring.sessionId, { candidate: { responseMessageId: 'retired-role-final',
      answerText: 'Retrieved after role retirement', terminalMarker: true, streamingMarker: false }, activity: 'none' });
    let retiredFinal = await rpc<SessionSnapshot>('session.get', { sessionId: retiring.sessionId });
    for (let attempt = 0; attempt < 100 && !retiredFinal.terminal; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      retiredFinal = await rpc<SessionSnapshot>('session.wait', { sessionId: retiring.sessionId, generation: 1, waitMs: 10 });
    }
    assert.equal(retiredFinal.answerText, 'Retrieved after role retirement');
    await assert.rejects(rpc('session.send', { requestId: 'retired-role-send', sessionId: retiring.sessionId, prompt: 'Rejected' }),
      (error: unknown) => JSON.stringify(error).includes('session.generation-superseded'));
    assert.equal((await rpc<{ deleted: boolean }>('session.delete', deletion(retiredFinal, 'delete-retired-role'))).deleted, true);
    await rpc('team.role.create', { requestId: 'role-preparing', teamId: active.teamId,
      roleKey: 'expert.preparing', roleType: 'expert', reportsToRoleKey: 'main' });
    const preparing = await rpc<SessionSnapshot>('session.create', { requestId: 'preparing-session',
      teamId: active.teamId, roleKey: 'expert.preparing', provider: 'chatgpt' });
    fake.duringPrepare = async () => { await rpc('team.role.retire', { requestId: 'retire-during-prepare',
      teamId: active.teamId, roleKey: 'expert.preparing' }); };
    await assert.rejects(rpc('session.send', { requestId: 'preparing-send', sessionId: preparing.sessionId, prompt: 'Must not submit' }),
      (error: unknown) => JSON.stringify(error).includes('session.generation-superseded'));
    fake.duringPrepare = null;
    const notSubmitted = await rpc<SessionSnapshot>('session.get', { sessionId: preparing.sessionId });
    assert.equal(notSubmitted.promptSubmitted, false);
    assert.equal(notSubmitted.submissionState, 'failed_pre_submit');
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
    fake.confirmDeletion = true;
    const reconciled = await rpc<{ deleted: boolean }>('session.delete', deletion(uncertain, 'uncertain'));
    assert.equal(reconciled.deleted, true);
    assert.equal((await rpc<SessionSnapshot>('session.get', { sessionId: uncertain.sessionId })).sessionState, 'superseded');
    fake.loseAcknowledgement = false;
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
    await core.close();
    const oldDatabase = new DatabaseSync(config.databasePath);
    oldDatabase.prepare("UPDATE sessions SET session_state = 'superseded' WHERE session_id = ?").run(ambiguous.sessionId);
    oldDatabase.close();
    core = await startCore(options);
    const restored = await rpc<SessionSnapshot>('session.get', { sessionId: ambiguous.sessionId });
    assert.equal(restored.terminal, false);
    assert.equal(restored.generation, ambiguous.generation);
    assert.equal(restored.submissionState, 'submission_unknown');
    await assert.rejects(rpc('session.delete', { ...deletion(uncertain, 'wrong-generation'), generation: 2 }),
      (error: unknown) => JSON.stringify(error).includes('session.conversation-mismatch'));
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
