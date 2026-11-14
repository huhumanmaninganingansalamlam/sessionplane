import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../../src/config.ts';
import { createSemanticCoreRuntime } from '../../src/core/semantic-core-runtime.ts';
import type { BackendJsonClient } from '../../src/providers/chatgpt/backend-recovery.ts';
import { startCore } from '../../src/main.ts';

import { ChatGptSemanticAdapter } from '../../src/providers/chatgpt/semantic-adapter.ts';
import { SemanticProviderRegistry } from '../../src/providers/semantic-provider-registry.ts';
import type {
  SemanticActRequest, SemanticActResult, SemanticExactQuery, SemanticObservation,
  SemanticProviderAdapter, SemanticTaskContext, SemanticVerification,
} from '../../src/providers/semantic-adapter.ts';

class FakeNonBrowserAdapter implements SemanticProviderAdapter {
  readonly providerKey = 'remote-fixture';
  readonly capabilities = {
    providerKey: this.providerKey, browserRequired: false, contractVersion: 1 as const,
    supports: ['conversation', 'artifact_read'] as const,
  };
  async observe(context: SemanticTaskContext): Promise<SemanticObservation> {
    assert.equal(context.pageLease, null, 'API/non-browser providers never fabricate Chrome leases');
    const result: SemanticObservation = {
      providerKey: this.providerKey, surface: 'unknown',
      snapshotId: 'remote-read', observedAt: new Date(0).toISOString(),
      capabilityManifest: this.capabilities, progress: 'idle', blocker: 'none',
      reason: null, questionText: null,
      turn: { submittedUserFound: true, laterUserFound: false,
        submittedUserMessageId: context.submittedUserMessageId,
        answerMessageId: null, partialAnswer: null },
      actions: [], evidenceBytes: 0,
    };
    return result;
  }
  async act(_request: SemanticActRequest): Promise<SemanticActResult> {
    return { kind: 'unsupported', reason: 'read-only-test-adapter' };
  }
  async verify(query: SemanticExactQuery): Promise<SemanticVerification> {
    return this.recover(query);
  }
  async recover(query: SemanticExactQuery): Promise<SemanticVerification> {
    assert.equal(query.context.pageLease, null);
    return { kind: 'exact_final', externalTurnId: query.context.submittedUserTurnId!,
      answerText: 'Other provider exact answer' };
  }
  async readArtifact(): Promise<{ kind: 'unavailable'; reason: string }> {
    return { kind: 'unavailable', reason: 'fixture-no-file' };
  }
}

test('ChatGPT B-first and future browserless providers share a capability-negotiated port', async () => {
  const chatgpt = new ChatGptSemanticAdapter({
    isExactLease: () => false,
    resolvePage: () => { throw new Error('fixture must not open a Chrome page'); },
  });
  const remote = new FakeNonBrowserAdapter();
  const registry = new SemanticProviderRegistry([chatgpt, remote]);
  const b = registry.resolve('chatgpt', 'conversation');
  assert.equal(b.kind, 'available');
  if (b.kind === 'available') {
    assert.equal(b.adapter.capabilities.browserRequired, true);
    assert.equal(b.adapter.capabilities.contractVersion, 1);
  }
  assert.deepEqual(registry.resolve('remote-fixture', 'permission'), {
    kind: 'unsupported', reason: 'capability_not_supported',
  });
  assert.deepEqual(registry.resolve('missing-provider', 'conversation'), {
    kind: 'unsupported', reason: 'provider_not_registered',
  });
  const r = registry.resolve('remote-fixture', 'conversation');
  assert.equal(r.kind, 'available');
  if (r.kind !== 'available') throw new Error('missing provider');
  const context: SemanticTaskContext = {
    projectId: 'p', slotId: 'review', slotRevision: 2, taskId: 't',
    providerConversationId: 'other-convo', submittedUserMessageId: 'other-user',
    submittedUserTurnId: 'other-turn', pageLease: null,
  };
  assert.equal((await r.adapter.observe(context)).providerKey, 'remote-fixture');
  assert.deepEqual(await r.adapter.recover({ context, kind: 'final' }), {
    kind: 'exact_final', externalTurnId: 'other-turn',
    answerText: 'Other provider exact answer',
  });
  assert.throws(() => new SemanticProviderRegistry([chatgpt, chatgpt]),
    /Duplicate semantic provider/);
});
test('Core composes the semantic ChatGPT provider without launching a separate browser', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-composition-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  let core: Awaited<ReturnType<typeof startCore>> | null = null;
  try {
    core = await startCore({
      config, startBrowser: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    assert.equal(core.browserOwner, null);
    assert.ok(core.semanticTaskKernel, 'normal Core must assemble the durable semantic task execution port');
    assert.ok(core.semanticTaskArtifactReader,
      'Core must assemble the optional artifact boundary without legacy artifact runtime');
    assert.ok(core.semanticTaskRepository, 'the kernel must use the Core-owned durable journal');
    assert.equal(core.pageRegistry.listBindings().length, 0);
    const store = core.semanticTaskRepository;
    store.openProject({
      projectId: 'kernel-project', projectKey: 'kernel-fixture', displayName: 'Kernel fixture',
      clientId: 'kernel-client',
    });
    store.openSlot({
      projectId: 'kernel-project', clientId: 'kernel-client', slotId: 'main',
      roleKey: 'main', providerKey: 'chatgpt',
    });
    store.startTask({
      taskId: 'kernel-task', projectId: 'kernel-project', slotId: 'main',
      expectedSlotRevision: 1, clientId: 'kernel-client',
      requestId: 'kernel-start', prompt: 'One exact prompt',
    });
    assert.equal(store.dispatchClientId('kernel-task'), 'kernel-client');
    assert.equal(store.dispatchClientId('foreign-task'), null);
    store.observeConversation({
      projectId: 'kernel-project', clientId: 'kernel-client', slotId: 'main',
      expectedRevision: 1, taskId: 'kernel-task',
      providerConversationId: 'owned-conversation',
    });
    store.planAttempt({
      taskId: 'kernel-task', clientId: 'kernel-client',
      attemptId: 'kernel-attempt', kind: 'initial', turnKey: 'initial',
      content: 'One exact prompt',
    });
    await core.semanticTaskKernel.dispatch('kernel-task', 'kernel-client', 'kernel-attempt');
    assert.equal(store.getFullTask('kernel-task', 'kernel-client').attempts[0]?.state,
      'planned', 'absence of an owned page is known before an external attempt');
    assert.equal(store.getFullTask('kernel-task', 'kernel-client').events
      .filter(event => event.event.type === 'attempt.dispatched').length, 0);
    await core.semanticTaskKernel.dispatch('kernel-task', 'kernel-client', 'kernel-attempt');
    assert.equal(store.getFullTask('kernel-task', 'kernel-client').attempts[0]?.state,
      'planned', 'repeated preflight failures preserve one future safe send');
    assert.equal(store.getFullTask('kernel-task', 'kernel-client').events
      .filter(event => event.event.type === 'observation.deferred').length, 1);
    assert.equal(core.pageRegistry.listBindings().length, 0);
    const provider = core.semanticProviders.resolve('chatgpt', 'conversation');
    assert.equal(provider.kind, 'available',
      'normal Core composition must actually register the new semantic adapter');
    if (provider.kind !== 'available') throw new Error('semantic provider unregistered');
    assert.equal(provider.adapter.capabilities.contractVersion, 1);
    assert.deepEqual(await provider.adapter.recover({
      kind: 'final',
      context: {
        projectId: 'project', slotId: 'main', slotRevision: 1, taskId: 'task',
        providerConversationId: 'conversation', submittedUserMessageId: 'user',
        submittedUserTurnId: 'turn', pageLease: null,
      },
    }), { kind: 'unavailable', reason: 'backend-transport-unavailable' },
    'without an owned browser, recovery must not invent a profile or backend identity');
    assert.equal(core.pageRegistry.listBindings().length, 0);
  } finally {
    await core?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('Core-owned semantic Retry-After survives restart without an extra backend GET', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-restart-pacing-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const clientId = 'pacing-client', projectId = 'pacing-project', taskId = 'pacing-task';
  const conversationId = 'pacing-conversation', attemptId = 'pacing-attempt';
  const prompt = 'One original prompt';
  let now = 100_000;
  let conversationReads = 0;
  let authReads = 0;
  const client: BackendJsonClient = {
    authScope: {},
    async get(url) {
      if (url.endsWith('/api/auth/session')) {
        authReads++;
        return { status: 200, headers: {}, body: { accessToken: 'test-memory-only' } };
      }
      conversationReads++;
      if (conversationReads === 1) {
        return { status: 429, headers: { 'retry-after': '120' }, body: null };
      }
      return { status: 200, headers: {}, body: {
        id: conversationId, current_node: 'answer-node', mapping: {
          root: { id: 'root', parent: null, message: null, children: [] },
          'user-node': { id: 'user-node', parent: 'root', children: [],
            message: { id: 'pacing-user', turn_id: 'pacing-turn',
              author: { role: 'user' }, content: { parts: [prompt] } } },
          'answer-node': { id: 'answer-node', parent: 'user-node', children: [],
            message: { id: 'pacing-answer', author: { role: 'assistant' },
              channel: 'final', status: 'finished_successfully', end_turn: true,
              content: { parts: ['Recovered after due'] }, metadata: {} } },
        },
      } };
    },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  let core: Awaited<ReturnType<typeof startCore>> | null = null;
  try {
    core = await startCore({ config, startBrowser: false, logger });
    const store = core.semanticTaskRepository;
    store.openProject({ projectId, projectKey: 'retry-pacing.fixture',
      displayName: 'Retry pacing fixture', clientId });
    store.openSlot({ projectId, clientId, slotId: 'main', roleKey: 'main',
      providerKey: 'chatgpt' });
    store.startTask({ taskId, projectId, slotId: 'main', expectedSlotRevision: 1,
      clientId, requestId: 'pacing-request', prompt });
    store.observeConversation({ projectId, clientId, slotId: 'main',
      expectedRevision: 1, taskId, providerConversationId: conversationId });
    store.planAttempt({ taskId, clientId, attemptId, kind: 'initial',
      turnKey: 'initial', content: prompt });
    store.beginDispatch(taskId, clientId, attemptId);
    store.recordDispatchEvidence({ taskId, clientId, attemptId, evidence: {
      conversationId, messageId: 'pacing-user', parentMessageId: 'root',
      textHash: createHash('sha256').update(prompt).digest('hex'),
      observedAt: new Date(0).toISOString(),
    } });
    store.acknowledgeAttempt({ taskId, clientId, attemptId, externalTurnId: 'pacing-turn' });
    const runtime = () => createSemanticCoreRuntime({
      database: core!.database, browserOwner: null, pageRegistry: core!.pageRegistry,
      teamDirectory: core!.teamDirectory, pageMutationMutex: core!.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
      backendClientProvider: () => client,
      backendRecoveryNow: () => new Date(now),
    });
    const query = { taskId, clientId, attemptId, resultId: 'pacing-result', completeTask: true };
    assert.equal(await runtime().kernel.observeFinal(query), null);
    assert.equal(conversationReads, 1);
    assert.equal(store.backendReadNotBeforeMs('chatgpt', 'https://chatgpt.com'), now + 120_000);
    assert.equal(store.backendReadNotBeforeMs('chatgpt', 'https://chat.openai.com'), 0,
      'one origin must not inherit another origin\'s cooldown');
    assert.equal(store.extendBackendReadNotBeforeMs('chatgpt', 'https://chatgpt.com', now + 1_000),
      now + 120_000, 'an old caller cannot shorten a durable cooldown');
    assert.throws(() => store.extendBackendReadNotBeforeMs('chatgpt',
      'https://chatgpt.com', Number.MAX_SAFE_INTEGER + 1), /safe integer/);
    await core.close();
    core = null;

    core = await startCore({ config, startBrowser: false, logger });
    assert.equal(core.semanticTaskRepository.backendReadNotBeforeMs('chatgpt', 'https://chatgpt.com'),
      now + 120_000, 'pacing watermark is recovered from the same Core-owned SQLite');
    assert.equal(await runtime().kernel.observeFinal(query), null,
      'a restarted Core must preserve the original Retry-After, not query twice');
    assert.equal(conversationReads, 1, 'no backend GET before persisted Retry-After');
    assert.equal(authReads, 1, 'no auth GET needed during persisted backend cooldown');
    assert.equal(core.semanticTaskRepository.getTask(taskId, clientId).state, 'working');
    now += 120_001;
    const final = await runtime().kernel.observeFinal(query);
    assert.equal(final?.answerText, 'Recovered after due');
    assert.equal(conversationReads, 2);
    assert.equal(core.semanticTaskRepository.getTask(taskId, clientId).state, 'completed');
  } finally {
    await core?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('Core-owned semantic late ACK preserves 429 evidence across restart without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-late-ack-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const clientId = 'ack-client', projectId = 'ack-project', taskId = 'ack-task';
  const attemptId = 'ack-attempt', conversationId = 'ack-conversation';
  const prompt = 'Exact original question';
  let now = 100_000;
  let conversationReads = 0;
  const client: BackendJsonClient = {
    authScope: {},
    async get(url) {
      if (url.endsWith('/api/auth/session')) {
        return { status: 200, headers: {}, body: { accessToken: 'fixture-only-memory' } };
      }
      conversationReads++;
      if (conversationReads === 1) {
        return { status: 429, headers: { 'retry-after': '120' }, body: null };
      }
      return { status: 200, headers: {}, body: {
        id: conversationId, current_node: 'answer-node',
        mapping: {
          root: { id: 'root', parent: null, children: [], message: null },
          'user-node': { id: 'user-node', parent: 'root', children: [],
            message: { id: 'ack-user', turn_id: 'ack-turn', author: { role: 'user' },
              content: { parts: [prompt] } } },
          'answer-node': { id: 'answer-node', parent: 'user-node', children: [],
            message: { id: 'ack-answer', author: { role: 'assistant' },
              channel: 'final', status: 'finished_successfully', end_turn: true,
              content: { parts: ['Late ACK final'] }, metadata: {} } },
        },
      } };
    },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  let core: Awaited<ReturnType<typeof startCore>> | null = null;
  try {
    core = await startCore({ config, startBrowser: false, logger });
    const store = core.semanticTaskRepository;
    store.openProject({ projectId, clientId, projectKey: 'late-ack-fixture',
      displayName: 'Late ACK fixture' });
    store.openSlot({ projectId, clientId, slotId: 'main', roleKey: 'main',
      providerKey: 'chatgpt' });
    store.startTask({ taskId, projectId, clientId, slotId: 'main',
      expectedSlotRevision: 1, requestId: 'ack-request', prompt });
    store.observeConversation({ taskId, projectId, clientId, slotId: 'main',
      expectedRevision: 1, providerConversationId: conversationId });
    store.planAttempt({ taskId, clientId, attemptId, kind: 'initial',
      turnKey: 'initial', content: prompt });
    store.beginDispatch(taskId, clientId, attemptId);
    store.recordDispatchEvidence({ taskId, clientId, attemptId, evidence: {
      conversationId, messageId: 'ack-user', parentMessageId: 'root',
      textHash: createHash('sha256').update(prompt).digest('hex'),
      observedAt: new Date(0).toISOString(),
    } });
    store.markUncertain(taskId, clientId, attemptId, 'lost-ack');
    const runtime = () => createSemanticCoreRuntime({
      database: core!.database, browserOwner: null,
      pageRegistry: core!.pageRegistry, teamDirectory: core!.teamDirectory,
      pageMutationMutex: core!.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
      backendClientProvider: () => client, backendRecoveryNow: () => new Date(now),
    });
    const first = await runtime().kernel.recoverAck(taskId, clientId, attemptId);
    assert.equal(first.state, 'uncertain');
    assert.equal(conversationReads, 1);
    assert.ok(store.getFullTask(taskId, clientId).events.some(event =>
      event.event.type === 'observation.deferred' &&
      event.event.reason === 'ack:ack-attempt:pending:backend-http-429'));
    await core.close();
    core = null;

    core = await startCore({ config, startBrowser: false, logger });
    const waiting = await runtime().kernel.recoverAck(taskId, clientId, attemptId);
    assert.equal(waiting.state, 'uncertain');
    assert.equal(conversationReads, 1,
      'a restarted ACK collector cannot bypass a persisted Retry-After');
    now += 120_001;
    const recovered = await runtime().kernel.recoverAck(taskId, clientId, attemptId);
    assert.equal(recovered.state, 'working');
    assert.equal(core.semanticTaskRepository.getFullTask(taskId, clientId).attempts[0]?.externalTurnId,
      'ack-turn', 'only the original durable attempt receives its late ACK');
    assert.equal(conversationReads, 2, 'ACK never triggers a second POST');
    await runtime().kernel.recoverAck(taskId, clientId, attemptId);
    assert.equal(conversationReads, 2, 'acknowledged attempts are not probed again');
    assert.equal(core.pageRegistry.listBindings().length, 0);
  } finally {
    await core?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
