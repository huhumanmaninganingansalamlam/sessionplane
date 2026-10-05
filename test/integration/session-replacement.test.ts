import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import { ProviderSubmissionError, type ProviderRecoveryRequest } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import type { ReplacementCleanup } from '../../src/core/conversation-cleanup-service.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { ReceiptRepository } from '../../src/storage/receipt-repository.ts';
import { OutboxRepository } from '../../src/storage/outbox-repository.ts';

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

test('explicit preserving replacement retains the stable role, unsent draft and chat across restart', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-preserving-replacement-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const adapter = new DeletingProvider();
  const open = adapter.openSubmission.bind(adapter);
  t.mock.method(adapter, 'openSubmission', async (...args: Parameters<typeof open>) => ({
    ...await open(...args), prepareForObservation: async () => {},
  }));
  adapter.prepareError = new ProviderSubmissionError('provider.preparation-required', 'Conversation cannot load');
  const options = { config, startBrowser: false, providerAdapters: [adapter],
    logger: { debug() {}, info() {}, warn() {}, error() {} } };
  let core = await startCore(options);
  const rpc = <T>(method: string, params: object) => callRpc<T>({ socketPath: config.socketPath,
    method, params, timeoutMs: 5000 });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'preserving-test' });
    const old = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await assert.rejects(core.submissionService.send({ clientId: `team:${team.teamId}`, requestId: 'old-draft',
      sessionId: old.sessionId, prompt: 'Old candidate hash; never submit', sessionDeadlineSec: 600 }),
      (e: { errorCode: string }) => e.errorCode === 'provider.preparation-required');
    // Model a known conversation whose latest prepared request has no provider submission.
    core.database.raw.prepare('UPDATE sessions SET conversation_id = ? WHERE session_id = ?').run('preserved-chat', old.sessionId);
    core.pageBindings.upsert({ pageKey: 'retained-page', bindingEpoch: 2, sessionId: old.sessionId,
      generation: 1, conversationId: 'preserved-chat', state: 'bound',
      url: 'https://chatgpt.com/c/preserved-chat', lastSeenAt: new Date().toISOString(), targetId: null });
    const draft = new OutboxRepository(core.database).getByRequest(`team:${team.teamId}`, 'old-draft')!;
    const generation = core.database.raw.prepare('SELECT * FROM generations WHERE session_id = ?').get(old.sessionId);
    const bindings = core.pageBindings.listForSession(old.sessionId);
    const input = { teamId: team.teamId, roleRef: old.sessionId + ':1', requestId: 'preserve', preserveConversation: true };

    await assert.rejects(rpc('workflow.session_replace', { ...input, roleRef: old.sessionId + ':0' }),
      (e: unknown) => JSON.stringify(e).includes('session.generation-superseded'));
    // Reject submitted, UNKNOWN, partially filled and inconsistent acknowledgement evidence.
    for (const state of ['submitted', 'submission_unknown', 'submit_attempted', 'composer_filled']) {
      core.database.raw.prepare('UPDATE generations SET submission_state = ? WHERE session_id = ?').run(state, old.sessionId);
      await assert.rejects(rpc('workflow.session_replace', input),
        (e: unknown) => JSON.stringify(e).includes('session.preservation-not-ready'));
    }
    core.database.raw.prepare("UPDATE generations SET submission_state = 'prepared', submitted_user_message_id = 'unexpected-anchor' WHERE session_id = ?").run(old.sessionId);
    await assert.rejects(rpc('workflow.session_replace', input),
      (e: unknown) => JSON.stringify(e).includes('session.preservation-not-ready'));
    core.database.raw.prepare('UPDATE generations SET submitted_user_message_id = NULL WHERE session_id = ?').run(old.sessionId);
    core.database.raw.prepare('UPDATE outbox SET prompt_submitted = 1 WHERE outbox_id = ?').run(draft.outboxId);
    await assert.rejects(rpc('workflow.session_replace', input),
      (e: unknown) => JSON.stringify(e).includes('session.preservation-not-ready'));
    core.database.raw.prepare('UPDATE outbox SET prompt_submitted = 0 WHERE outbox_id = ?').run(draft.outboxId);
    assert.equal(core.teamDirectory.getCurrentSession(team.teamId, 'main').sessionId, old.sessionId);

    core.receipts.record({ clientId: 'fixture', requestId: 'prior-delete', method: 'session.delete',
      requestHash: 'fixture', status: 'attempted', result: { conversationId: 'preserved-chat' } });
    await assert.rejects(rpc('workflow.session_replace', input),
      (e: unknown) => JSON.stringify(e).includes('session.cleanup-pending'));
    core.database.raw.prepare("DELETE FROM request_receipts WHERE client_id = 'fixture' AND request_id = 'prior-delete'").run();

    // A submission already queued on the actor must win over a prior prepared snapshot.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const actor = core.actorScheduler.actorFor(old.sessionId);
    const queuedMutation = actor.enqueue(async () => {
      await held;
      core.database.raw.prepare("UPDATE generations SET submission_state = 'submission_unknown', prompt_submitted = 1 WHERE session_id = ?").run(old.sessionId);
    });
    const replacement = rpc('workflow.session_replace', input);
    const rejected = assert.rejects(replacement,
      (e: unknown) => JSON.stringify(e).includes('session.preservation-not-ready'));
    try {
      const deadline = Date.now() + 2000;
      while (core.actorScheduler.totalQueueDepth < 2 && Date.now() < deadline) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      assert.ok(core.actorScheduler.totalQueueDepth >= 2, 'Replacement queues behind the existing mutation');
    } finally { release(); }
    await queuedMutation;
    await rejected;
    core.database.raw.prepare("UPDATE generations SET submission_state = 'prepared', prompt_submitted = 0 WHERE session_id = ?").run(old.sessionId);

    const result = await rpc<{ replacement: { sessionId: string; cleanup: ReplacementCleanup } }>('workflow.session_replace', input);
    const next = core.teamDirectory.getCurrentSession(team.teamId, 'main');
    assert.equal(next.sessionId, result.replacement.sessionId);
    assert.equal(next.roleId, old.roleId);
    assert.equal(next.predecessorSessionId, old.sessionId);
    assert.equal(next.generation, 0);
    assert.equal(next.conversationId, null);
    assert.equal(next.promptSubmitted, false);
    assert.equal(core.teamDirectory.getTeam(team.teamId).roles.length, 1);
    assert.equal(result.replacement.cleanup.outcome, 'preserved');
    assert.equal(result.replacement.cleanup.deletionRequestId, null);
    assert.equal(result.replacement.cleanup.deletionReceipt, null);
    assert.equal(core.teamDirectory.getSession(old.sessionId).sessionState, 'superseded');
    assert.deepEqual(new OutboxRepository(core.database).getById(draft.outboxId), draft);
    assert.deepEqual(core.database.raw.prepare('SELECT * FROM generations WHERE session_id = ?').get(old.sessionId), generation);
    assert.deepEqual(core.pageBindings.listForSession(old.sessionId), bindings);
    const read = await rpc<{ request: { promptSubmitted: boolean; submissionState: string; conversationId: string } }>(
      'workflow.team_get', { teamId: team.teamId, requestRef: draft.outboxId });
    assert.equal(read.request.promptSubmitted, false);
    assert.equal(read.request.submissionState, 'prepared');
    assert.equal(read.request.conversationId, 'preserved-chat');
    await assert.rejects(rpc('workflow.session_replace', { ...input, preserveConversation: undefined }),
      (e: unknown) => JSON.stringify(e).includes('input.idempotency-conflict'));
    await assert.rejects(core.submissionService.resumePreparation({ clientId: draft.clientId,
      requestId: draft.requestId, sessionId: old.sessionId, generation: 1 }),
      (e: { errorCode: string }) => e.errorCode === 'session.generation-superseded');
    const opened = adapter.openCount;
    await core.close();
    core = await startCore(options);
    assert.deepEqual((await rpc<typeof result>('workflow.session_replace', input)).replacement, result.replacement);
    assert.deepEqual(new OutboxRepository(core.database).getById(draft.outboxId), draft);
    assert.deepEqual(core.pageBindings.listForSession(old.sessionId), bindings);
    assert.equal(core.teamDirectory.getCurrentSession(team.teamId, 'main').sessionId, next.sessionId);
    assert.equal(adapter.openCount, opened);
    assert.equal(adapter.submitCount, 0);
    assert.equal(adapter.deleteCount, 0);
    assert.equal(adapter.stopCount, 0);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

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
    const replaced = await rpc<{ roles: Array<{ currentSessionId: string }>;
      replacement: { requestId: string; sessionId: string; cleanup: ReplacementCleanup } }>('workflow.session_replace', replace);
    const successor = replaced.roles[0]!.currentSessionId;
    assert.notEqual(successor, old.sessionId);
    assert.equal(core.teamDirectory.getSession(successor).predecessorSessionId, old.sessionId);
    assert.equal(core.teamDirectory.getSession(old.sessionId).sessionState, 'superseded');
    assert.equal(core.teamDirectory.getSession(old.sessionId).submissionState, 'submitted');
    assert.equal(core.observationService.observerCount, 0);
    assert.equal(replaced.replacement.requestId, replace.requestId);
    assert.equal(replaced.replacement.sessionId, successor);
    assert.deepEqual(replaced.replacement.cleanup, {
      predecessorSessionId: old.sessionId, predecessorGeneration: 1,
      conversationId: submitted.conversationId, deletionRequestId: 'replacement-delete:replace',
      deletionReceipt: { clientId: `team:${team.teamId}`, requestId: 'replacement-delete:replace', status: 'attempted' },
      outcome: 'uncertain', errorCode: 'provider.deletion-unknown',
    });
    const replay = await rpc<typeof replaced>('workflow.session_replace', replace);
    assert.deepEqual(replay.replacement, replaced.replacement);
    assert.equal(core.teamDirectory.getCurrentSession(team.teamId, 'main').sessionId, successor);
    assert.equal(adapter.deleteCount, 1);
    await core.close();
    core = await startCore(options);
    assert.equal(core.teamDirectory.getSession(old.sessionId).sessionState, 'superseded');
    assert.equal(core.observationService.observerCount, 0);
    assert.equal(core.pageBindings.listForSession(old.sessionId).length, 0);
    assert.equal(adapter.deleted.has(submitted.conversationId!), true);

    // The existing same-team custom-role path does not replace or clean up main.
    await rpc('workflow.role_create', { teamId: team.teamId, requestId: 'preserving-handoff',
      roleKey: 'main.continuation', roleType: 'custom', provider: 'chatgpt' });
    assert.equal(core.teamDirectory.getCurrentSession(team.teamId, 'main').sessionId, successor);
    assert.equal(adapter.deleteCount, 1);
    assert.equal(core.teamDirectory.getSession(old.sessionId).conversationId, submitted.conversationId);

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
    let historicalInput: Parameters<typeof cleanup.replace>[0] | undefined;
    for (const mode of ['success', 'unknown-ack', 'open-failure', 'rejected', 'no-identity', 'wrong-receipt', 'ambiguous-receipt']) {
      const old = directory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
      await scheduler.startGeneration({ sessionId: old.sessionId, teamBriefVersion: 0, promptHash: mode });
      database.raw.prepare("UPDATE generations SET submission_state = 'submission_unknown', prompt_submitted = 1 WHERE session_id = ?").run(old.sessionId);
      database.raw.prepare("UPDATE sessions SET conversation_id = ?, session_state = 'observing' WHERE session_id = ?")
        .run(mode === 'no-identity' ? null : old.sessionId, old.sessionId);
      let attempts = 0;
      adapter.openDeletion = async () => {
        attempts++;
        if (mode === 'open-failure') throw new SessionPlaneDomainError('provider.unavailable', 'Provider unavailable');
        return { alreadyDeleted: false, deleteOnce: async () => {
          if (mode === 'unknown-ack') throw new Error('Lost acknowledgement');
          return mode !== 'rejected';
        }, close: async () => {} };
      };
      const input = { clientId: 'boundary', requestId: mode, method: 'session.create', payload: { mode },
        teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' };
      const receipts = new ReceiptRepository(database);
      if (mode === 'wrong-receipt') receipts.record({ clientId: 'other', requestId: 'unrelated-deletion',
        method: 'session.delete', requestHash: 'fixture', status: 'complete', result: {
          sessionId: 'other-session', generation: 1, conversationId: old.sessionId,
          requestOk: true, deleted: true, errorCode: null,
        } });
      if (mode === 'ambiguous-receipt') receipts.record({ clientId: 'other', requestId: 'ambiguous-deletion',
        method: 'session.delete', requestHash: 'fixture', status: 'attempted', result: {
          sessionId: old.sessionId, generation: 1, conversationId: old.sessionId,
          requestOk: false, deleted: true, errorCode: null,
        } });
      const next = await cleanup.replace(input);
      assert.equal(next.predecessorSessionId, old.sessionId);
      assert.equal(directory.getCurrentSession(team.teamId, 'main').sessionId, next.sessionId);
      assert.equal(directory.getSession(old.sessionId).sessionState, 'superseded');
      assert.equal(directory.getSession(old.sessionId).submissionState, 'submission_unknown');
      assert.ok(retired.includes(old.sessionId));
      assert.equal(next.cleanup.predecessorSessionId, old.sessionId);
      assert.equal(next.cleanup.predecessorGeneration, 1);
      assert.equal(next.cleanup.conversationId, mode === 'no-identity' ? null : old.sessionId);
      assert.equal(next.cleanup.outcome, mode === 'success' ? 'confirmed'
        : mode === 'rejected' ? 'refused' : ['unknown-ack', 'wrong-receipt', 'ambiguous-receipt'].includes(mode) ? 'uncertain' : 'not-attempted');
      assert.equal(next.cleanup.errorCode, mode === 'unknown-ack' || mode === 'ambiguous-receipt' ? 'provider.deletion-unknown'
        : mode === 'rejected' ? 'provider.deletion-rejected' : mode === 'open-failure' ? 'provider.unavailable'
          : mode === 'wrong-receipt' ? 'session.conversation-mismatch' : null);
      assert.equal(next.cleanup.deletionRequestId, mode === 'no-identity' ? null : 'replacement-delete:' + mode);
      assert.deepEqual(next.cleanup.deletionReceipt, mode === 'no-identity' || mode === 'open-failure' ? null
        : mode === 'wrong-receipt' ? { clientId: 'other', requestId: 'unrelated-deletion', status: 'complete' }
          : mode === 'ambiguous-receipt' ? { clientId: 'other', requestId: 'ambiguous-deletion', status: 'attempted' }
          : { clientId: 'boundary', requestId: 'replacement-delete:' + mode, status: mode === 'unknown-ack' ? 'attempted' : 'complete' });
      assert.deepEqual(JSON.parse(receipts.get('boundary', mode)!.resultJson).cleanup, next.cleanup);
      assert.deepEqual(await cleanup.replace(input), next);
      assert.equal(attempts, mode === 'no-identity' || mode === 'wrong-receipt' ? 0 : 1);
      if (mode === 'open-failure') {
        historicalInput = input;
        const { cleanup: ignored, ...historical } = next;
        database.raw.prepare('UPDATE request_receipts SET result_json = ? WHERE client_id = ? AND request_id = ?')
          .run(JSON.stringify(historical), 'boundary', mode);
        const stored = receipts.get('boundary', mode)!.resultJson;
        assert.equal((await cleanup.replace(input)).cleanup.outcome, 'unknown');
        assert.equal(receipts.get('boundary', mode)!.resultJson, stored);
        assert.equal(attempts, 1);
      }
    }
    database.close();
    database = SessionPlaneDatabase.open(path.join(root, 'state.db'));
    assert.equal(new SessionRepository(database.raw).restorePendingRetiredSessions(['chatgpt']), 0);
    for (const id of retired) assert.equal(new SessionRepository(database.raw).getSnapshot(id)!.sessionState, 'superseded');
    const restored = new ConversationCleanupService({ database, directory: new TeamDirectory(database),
      scheduler: new ActorScheduler(database), adapters: new ProviderAdapterRegistry([adapter]),
      registry: new PageRegistry(), pageMutex: new PageMutationMutex(), onDeleted: () => {} });
    adapter.openDeletion = async () => { assert.fail('Historical replay must not contact the provider'); };
    const stored = new ReceiptRepository(database).get('boundary', 'open-failure')!.resultJson;
    const historical = await restored.replace(historicalInput!);
    assert.deepEqual(historical.cleanup, { predecessorSessionId: historical.predecessorSessionId,
      predecessorGeneration: null, conversationId: null, deletionRequestId: null,
      deletionReceipt: null, outcome: 'unknown', errorCode: 'provider.deletion-unknown' });
    assert.equal(new ReceiptRepository(database).get('boundary', 'open-failure')!.resultJson, stored);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
