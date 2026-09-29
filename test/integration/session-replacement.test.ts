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

class DeletingProvider extends FakeProviderAdapter {
  readonly deleted = new Set<string>();
  deleteCount = 0;
  loseAcknowledgement = false;
  confirmDeletion = false;
  async openDeletion({ session }: ProviderRecoveryRequest) {
    return {
      alreadyDeleted: this.confirmDeletion && this.deleted.has(session.conversationId!),
      deleteOnce: async () => {
        this.deleteCount++;
        this.deleted.add(session.conversationId!);
        if (this.loseAcknowledgement) throw new Error('Lost deletion acknowledgement');
        return true;
      },
      close: async () => {},
    };
  }
}

test('replacement attempts deletion once, continues on failure, and never resurrects retired work', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-replacement-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const adapter = new DeletingProvider();
  const options = { config, startBrowser: false, providerAdapters: [adapter],
    logger: { debug() {}, info() {}, warn() {}, error() {} } };
  let core = await startCore(options);
  const rpc = <T>(method: string, params: object) => callRpc<T>({ socketPath: config.socketPath,
    method, params, timeoutMs: 5000 });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'replacement-test' });
    const old = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const submitted = await rpc<SessionSnapshot>('session.send', { clientId: 'replacement-test', requestId: 'send',
      sessionId: old.sessionId, prompt: 'Pending work to discard' });
    adapter.loseAcknowledgement = true;
    const replace = { teamId: team.teamId, roleRef: old.sessionId + ':1', requestId: 'replace' };
    const replaced = await rpc<{ roles: Array<{ currentSessionId: string }> }>('workflow.session_replace', replace);
    const successor = replaced.roles[0]!.currentSessionId;
    assert.notEqual(successor, old.sessionId);
    assert.equal(core.teamDirectory.getSession(successor).predecessorSessionId, old.sessionId);
    assert.equal(core.teamDirectory.getSession(old.sessionId).sessionState, 'superseded');
    assert.equal(core.teamDirectory.getSession(old.sessionId).submissionState, 'submitted');
    assert.equal(core.observationService.observerCount, 0);
    await rpc('workflow.session_replace', replace);
    assert.equal(core.teamDirectory.getCurrentSession(team.teamId, 'main').sessionId, successor);
    assert.equal(adapter.deleteCount, 1);
    await core.close();
    core = await startCore(options);
    assert.equal(core.teamDirectory.getSession(old.sessionId).sessionState, 'superseded');
    assert.equal(core.observationService.observerCount, 0);
    assert.equal(core.pageBindings.listForSession(old.sessionId).length, 0);
    assert.equal(adapter.deleted.has(submitted.conversationId!), true);

    // Raw session.create shares replacement semantics, including completion and retry.
    adapter.loseAcknowledgement = false;
    await rpc('session.send', { clientId: 'replacement-test', requestId: 'send-successor', sessionId: successor, prompt: 'Second request' });
    const input = { clientId: 'replacement-test', requestId: 'raw-replace', teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' };
    const next = await rpc<SessionSnapshot>('session.create', input);
    assert.equal(next.predecessorSessionId, successor);
    assert.equal(adapter.deleteCount, 2);
    assert.deepEqual(await rpc('session.create', input), next);

    // An unacknowledged home has no provider identity that can be deleted.
    adapter.acknowledgementMode = 'missing';
    await assert.rejects(rpc('session.send', { clientId: 'replacement-test', requestId: 'ambiguous', sessionId: next.sessionId, prompt: 'Uncertain' }));
    await rpc('workflow.session_replace', { teamId: team.teamId, roleRef: next.sessionId + ':1', requestId: 'unknown-replace' });
    assert.notEqual(core.teamDirectory.getCurrentSession(team.teamId, 'main').sessionId, next.sessionId);
    assert.equal(core.teamDirectory.getSession(next.sessionId).sessionState, 'superseded');
    await core.close();
    core = await startCore(options);
    assert.equal(core.teamDirectory.getSession(next.sessionId).sessionState, 'superseded');
    assert.equal(core.observationService.observerCount, 0);
    assert.equal(adapter.deleteCount, 2);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// Exercise the shared boundary without an RPC socket or browser.
test('best-effort replacement survives deletion failure and persistent recovery', async () => {
  const { SessionPlaneDatabase } = await import('../../src/storage/database.ts');
  const { SessionRepository } = await import('../../src/storage/session-repository.ts');
  const { TeamDirectory } = await import('../../src/core/team-directory.ts');
  const { ConversationCleanupService } = await import('../../src/core/conversation-cleanup-service.ts');
  const { ActorScheduler } = await import('../../src/scheduler/actor-scheduler.ts');
  const { ProviderAdapterRegistry } = await import('../../src/providers/provider-adapter.ts');
  const { PageRegistry } = await import('../../src/browser/page-registry.ts');
  const { PageMutationMutex } = await import('../../src/browser/page-mutex.ts');
  const root = mkdtempSync(path.join(tmpdir(), 'replacement-boundary-'));
  let database = SessionPlaneDatabase.open(path.join(root, 'state.db'));
  const retired: string[] = [];
  try {
    const directory = new TeamDirectory(database);
    const scheduler = new ActorScheduler(database);
    const adapter = new DeletingProvider();
    const cleanup = new ConversationCleanupService({ database, directory, scheduler,
      adapters: new ProviderAdapterRegistry([adapter]), registry: new PageRegistry(),
      pageMutex: new PageMutationMutex(), onDeleted: id => retired.push(id) });
    const team = directory.createTeam({ clientId: 'boundary' });
    for (const mode of ['success', 'unknown-ack', 'open-failure', 'rejected', 'no-identity']) {
      const old = directory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
      await scheduler.startGeneration({ sessionId: old.sessionId, teamBriefVersion: 0, promptHash: mode });
      database.raw.prepare("UPDATE generations SET submission_state = 'submission_unknown', prompt_submitted = 1 WHERE session_id = ?").run(old.sessionId);
      database.raw.prepare("UPDATE sessions SET conversation_id = ?, session_state = 'observing' WHERE session_id = ?")
        .run(mode === 'no-identity' ? null : old.sessionId, old.sessionId);
      let attempts = 0;
      adapter.openDeletion = async () => {
        attempts++;
        if (mode === 'open-failure') throw new Error('Provider unavailable');
        return { alreadyDeleted: false, deleteOnce: async () => {
          if (mode === 'unknown-ack') throw new Error('Lost acknowledgement');
          return mode !== 'rejected';
        }, close: async () => {} };
      };
      const input = { clientId: 'boundary', requestId: mode, method: 'session.create', payload: { mode },
        teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' };
      const next = await cleanup.replace(input);
      assert.equal(next.predecessorSessionId, old.sessionId);
      assert.equal(directory.getCurrentSession(team.teamId, 'main').sessionId, next.sessionId);
      assert.equal(directory.getSession(old.sessionId).sessionState, 'superseded');
      assert.equal(directory.getSession(old.sessionId).submissionState, 'submission_unknown');
      assert.ok(retired.includes(old.sessionId));
      assert.deepEqual(await cleanup.replace(input), next);
      assert.equal(attempts, mode === 'no-identity' ? 0 : 1);
    }
    database.close();
    database = SessionPlaneDatabase.open(path.join(root, 'state.db'));
    assert.equal(new SessionRepository(database.raw).restorePendingRetiredSessions(['chatgpt']), 0);
    for (const id of retired) assert.equal(new SessionRepository(database.raw).getSnapshot(id)!.sessionState, 'superseded');
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
