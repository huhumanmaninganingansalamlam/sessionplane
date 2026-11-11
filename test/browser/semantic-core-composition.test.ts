import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../../src/config.ts';
import { createSemanticCoreRuntime } from '../../src/core/semantic-core-runtime.ts';
import { startCore } from '../../src/main.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../../src/providers/chatgpt/backend-recovery.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('Core-assembled semantic ChatGPT sends once, persists exact ACK and FINAL with one owned page', {
  timeout: 90_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-core-integration-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    assert.equal(core.semanticProviders.resolve('chatgpt', 'permission').kind, 'available',
      'a provider can report a scoped permission without granting it');
    const team = core.teamDirectory.createTeam({ clientId: 'fixture-alice' });
    const roleKey = team.primaryRoleKey;
    const session = core.teamDirectory.createSession({
      teamId: team.teamId, roleKey, provider: 'chatgpt',
    });
    const generation = await core.actorScheduler.startGeneration({
      sessionId: session.sessionId, teamBriefVersion: 0,
      promptHash: sha('Exact integrated prompt'),
    });
    assert.equal(generation.generation, 1);

    const owned = await core.browserOwner!.createPage();
    const page = owned.page;
    await page.route('https://chatgpt.com/**', route => {
      if (route.request().method() !== 'GET') {
        return route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({ contentType: 'text/html', body:
        '<main><article data-message-author-role="user" data-message-id="previous-user">' +
        'Previous chat</article><section data-chatgpt-composer>' +
        '<div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
        '<button data-testid="send-button">Send</button></section></main><script>' +
        'window.sends=0;document.querySelector("button").onclick=()=>{' +
        'const editor=document.querySelector("#prompt-textarea");const text=editor.innerText;' +
        'window.sends++;fetch("/backend-api/f/conversation",{method:"POST",' +
        'headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
        'action:"next",conversation_id:"core-conv",parent_message_id:"root",' +
        'messages:[{id:"user-core",author:{role:"user"},content:{content_type:"text",parts:[text]}}]' +
        '})});editor.textContent="";};</script>',
      });
    });
    await page.goto('https://chatgpt.com/c/core-conv');
    const bound = core.pageRegistry.reservePage(owned.binding.pageKey, {
      sessionId: session.sessionId, generation: 1, conversationId: 'core-conv',
    });
    assert.equal(bound.state, 'owned');
    await core.actorScheduler.updateGeneration(session.sessionId, 1, {
      conversationId: 'core-conv', pageKey: bound.pageKey,
      sessionState: 'ready', providerState: 'idle',
    });
    const store = core.semanticTaskRepository;
    store.openProject({
      projectId: team.teamId, projectKey: 'core-assembled.fixture',
      displayName: 'Core semantic fixture', clientId: 'fixture-alice',
    });
    store.openSlot({
      projectId: team.teamId, clientId: 'fixture-alice',
      slotId: roleKey, roleKey, providerKey: 'chatgpt',
    });
    store.startTask({
      taskId: 'exact-task', projectId: team.teamId, slotId: roleKey,
      expectedSlotRevision: 1, clientId: 'fixture-alice', requestId: 'start-once',
      prompt: 'Exact integrated prompt',
    });
    store.observeConversation({
      projectId: team.teamId, clientId: 'fixture-alice', slotId: roleKey,
      expectedRevision: 1, taskId: 'exact-task', providerConversationId: 'core-conv',
    });
    store.planAttempt({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-once',
      kind: 'initial', turnKey: 'initial', content: 'Exact integrated prompt',
    });
    let detailReads = 0;
    let virtualNow = 100_000;
    const payload = {
      id: 'core-conv', current_node: 'assistant-node', mapping: {
        root: { id: 'root', parent: null, children: [], message: null },
        'user-node': { id: 'user-node', parent: 'root', children: [], message: {
          id: 'user-core', turn_id: 'turn-core', author: { role: 'user' },
          content: { parts: ['Exact integrated prompt'] },
        } },
        'assistant-node': { id: 'assistant-node', parent: 'user-node', children: [], message: {
          id: 'assistant-core', author: { role: 'assistant' }, channel: 'final',
          status: 'finished_successfully', end_turn: true,
          content: { parts: ['Exact integrated answer'] }, metadata: {},
        } },
      },
    };
    const client: BackendJsonClient = {
      authScope: {},
      async get(url) {
        if (url.endsWith('/api/auth/session')) {
          return { status: 200, headers: {}, body: { accessToken: 'fixture-memory-only' } };
        }
        assert.ok(url.includes('core-conv'));
        detailReads++;
        return { status: 200, headers: {}, body: payload };
      },
    };
    // The production factory is the same one used by startCore; only the
    // HTTP response and recovery clock are replaced for this offline fixture.
    const runtime = createSemanticCoreRuntime({
      database: core.database, browserOwner: core.browserOwner,
      pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
      pageMutationMutex: core.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
      backendClientProvider: () => client,
      backendRecovery: new ChatGptBackendRecovery({
        requestTimeoutMs: 500, tokenCacheTtlMs: 10_000,
        now: () => new Date(virtualNow),
      }),
    });
    const attemptBinding = runtime.bindAttemptSession({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-once',
      sessionId: session.sessionId, generation: 1, conversationId: 'core-conv',
    });
    assert.equal(attemptBinding.generation, 1);
    const dispatched = await runtime.kernel.dispatch(
      'exact-task', 'fixture-alice', 'attempt-once',
    );
    assert.equal(dispatched.state, 'working', 'canonical ACK must complete after the one POST');
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    const attempt = runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts[0]!;
    assert.equal(attempt.state, 'acknowledged');
    assert.equal(attempt.externalTurnId, 'turn-core');
    const proof = runtime.repository.getDispatchEvidence({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-once',
    });
    assert.equal(proof?.conversationId, 'core-conv');
    assert.equal(proof?.messageId, 'user-core');
    assert.equal(proof?.textHash, sha('Exact integrated prompt'));
    await assert.rejects(runtime.kernel.dispatch(
      'exact-task', 'fixture-alice', 'attempt-once',
    ), /Mutation already attempted/, 'the same committed intent cannot send twice');
    virtualNow += 5_001;
    const final = await runtime.kernel.observeFinal({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-once',
      resultId: 'exact-result', completeTask: true,
    });
    assert.equal(final?.answerText, 'Exact integrated answer');
    assert.equal(runtime.repository.getTask('exact-task', 'fixture-alice').state, 'completed');
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts.length, 1);
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    assert.ok(detailReads >= 2, 'ACK and FINAL are independent reads');
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('Core never sends a previous semantic Task after the owned session generation advances', {
  timeout: 45_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-stale-generation-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'fixture-alice' });
    const roleKey = team.primaryRoleKey;
    const session = core.teamDirectory.createSession({
      teamId: team.teamId, roleKey, provider: 'chatgpt',
    });
    await core.actorScheduler.startGeneration({
      sessionId: session.sessionId, teamBriefVersion: 0, promptHash: sha('Old exact intent'),
    });
    const owned = await core.browserOwner!.createPage();
    const page = owned.page;
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body:
        '<main><article data-message-author-role="user" data-message-id="earlier-user">' +
        'Earlier chat</article><section data-chatgpt-composer>' +
        '<div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
        '<button data-testid="send-button" onclick="window.sends++">Send</button>' +
        '</section></main><script>window.sends=0;</script>',
    }));
    await page.goto('https://chatgpt.com/c/core-stale');
    core.pageRegistry.reservePage(owned.binding.pageKey, {
      sessionId: session.sessionId, generation: 1, conversationId: 'core-stale',
    });
    await core.actorScheduler.updateGeneration(session.sessionId, 1, {
      conversationId: 'core-stale', pageKey: owned.binding.pageKey,
      sessionState: 'ready', providerState: 'idle',
    });
    const store = core.semanticTaskRepository;
    store.openProject({
      projectId: team.teamId, projectKey: 'semantic-stale-generation',
      displayName: 'Semantic stale fixture', clientId: 'fixture-alice',
    });
    store.openSlot({
      projectId: team.teamId, clientId: 'fixture-alice',
      slotId: roleKey, roleKey, providerKey: 'chatgpt',
    });
    store.startTask({
      taskId: 'old-task', projectId: team.teamId, slotId: roleKey,
      expectedSlotRevision: 1, clientId: 'fixture-alice',
      requestId: 'old-start', prompt: 'Old exact intent',
    });
    store.observeConversation({
      projectId: team.teamId, clientId: 'fixture-alice', slotId: roleKey,
      expectedRevision: 1, taskId: 'old-task', providerConversationId: 'core-stale',
    });
    store.planAttempt({
      taskId: 'old-task', clientId: 'fixture-alice',
      attemptId: 'old-attempt', kind: 'initial', turnKey: 'root',
      content: 'Old exact intent',
    });
    const priorBinding = core.semanticTaskBindAttemptSession({
      taskId: 'old-task', clientId: 'fixture-alice', attemptId: 'old-attempt',
      sessionId: session.sessionId, generation: 1, conversationId: 'core-stale',
    });
    assert.equal(priorBinding.generation, 1);
    assert.deepEqual(core.semanticTaskBindAttemptSession({
      taskId: 'old-task', clientId: 'fixture-alice', attemptId: 'old-attempt',
      sessionId: session.sessionId, generation: 1, conversationId: 'core-stale',
    }), priorBinding, 'the same generation binding is idempotent');

    // The legacy session is now on another generation, but the new Task
    // still has the same slot revision and provider conversation ID.
    const newer = await core.actorScheduler.startGeneration({
      sessionId: session.sessionId, teamBriefVersion: 0, promptHash: sha('New human task'),
    });
    assert.equal(newer.generation, 2);
    core.pageRegistry.reservePage(owned.binding.pageKey, {
      sessionId: session.sessionId, generation: 2, conversationId: 'core-stale',
    });
    await core.actorScheduler.updateGeneration(session.sessionId, 2, {
      conversationId: 'core-stale', pageKey: owned.binding.pageKey,
      sessionState: 'ready', providerState: 'idle',
    });
    assert.throws(() => core.semanticTaskBindAttemptSession({
      taskId: 'old-task', clientId: 'fixture-alice', attemptId: 'old-attempt',
      sessionId: session.sessionId, generation: 2, conversationId: 'core-stale',
    }), /cannot be rebound/, 'a newer owned page never rewrites the earlier attempt');
    assert.deepEqual(core.semanticTaskRepository.getAttemptSessionBinding({
      taskId: 'old-task', clientId: 'fixture-alice', attemptId: 'old-attempt',
    }), priorBinding);
    const runtime = createSemanticCoreRuntime({
      database: core.database, browserOwner: core.browserOwner,
      pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
      pageMutationMutex: core.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
      backendClientProvider: () => ({
        async get(url) {
          return url.endsWith('/api/auth/session')
            ? { status: 200, headers: {}, body: { accessToken: 'fixture-only' } }
            : { status: 404, headers: {}, body: null };
        },
      }),
    });
    await runtime.kernel.dispatch('old-task', 'fixture-alice', 'old-attempt');
    assert.equal(await page.evaluate(() => (window as any).sends), 0,
      'a previous Task must not click the newer generation after the legacy session advances');
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
