import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../../src/config.ts';
import { callRpc } from '../../src/cli/client.ts';
import { createSemanticCoreRuntime } from '../../src/core/semantic-core-runtime.ts';
import { startCore } from '../../src/main.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../../src/providers/chatgpt/backend-recovery.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

test('Core-assembled semantic ChatGPT sends initial and continuation once each with exact ACK and FINAL', {
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
        'window.sends++;const messageId=window.sends===1?"user-core":"user-continue";' +
        'const parentId=window.sends===1?"root":"assistant-node";' +
        'fetch("/backend-api/f/conversation",{method:"POST",' +
        'headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
        'action:"next",conversation_id:"core-conv",parent_message_id:parentId,' +
        'messages:[{id:messageId,author:{role:"user"},content:{content_type:"text",parts:[text]}}]' +
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
    const continuationPayload = {
      ...payload, current_node: 'assistant-continue-node',
      mapping: {
        ...payload.mapping,
        'user-continue-node': {
          id: 'user-continue-node', parent: 'assistant-node', children: [],
          message: { id: 'user-continue', turn_id: 'turn-continue',
            author: { role: 'user' }, content: { parts: ['계속'] } },
        },
        'assistant-continue-node': {
          id: 'assistant-continue-node', parent: 'user-continue-node', children: [],
          message: { id: 'assistant-continue', author: { role: 'assistant' },
            channel: 'final', status: 'finished_successfully', end_turn: true,
            content: { parts: ['Continued exact answer'] }, metadata: {} },
        },
      },
    };
    let continuedBackend = false;
    const client: BackendJsonClient = {
      authScope: {},
      async get(url) {
        if (url.endsWith('/api/auth/session')) {
          return { status: 200, headers: {}, body: { accessToken: 'fixture-memory-only' } };
        }
        assert.ok(url.includes('core-conv'));
        detailReads++;
        return { status: 200, headers: {}, body: continuedBackend ? continuationPayload : payload };
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
    await runtime.kernel.dispatch('exact-task', 'fixture-alice', 'attempt-once');
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts[0]!.state,
      'planned', 'the same exact request cannot be spent before its session binding');
    assert.equal(await page.evaluate(() => (window as any).sends), 0);
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').events
      .filter(event => event.event.type === 'observation.deferred').length, 1);
    const attemptBinding = runtime.bindAttemptSession({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-once',
      sessionId: session.sessionId, generation: 1, conversationId: 'core-conv',
    });
    assert.equal(attemptBinding.generation, 1);
    // A provider-owned question can arrive before any send. The same planned
    // attempt must survive until the blocker is resolved: no POST happened.
    await page.locator('main').evaluate(main => {
      const panel = document.createElement('section');
      panel.setAttribute('data-codex-composer-request-navigation', 'true');
      panel.setAttribute('data-user-input-auto-resolution', 'true');
      panel.innerHTML = '<h3>Provider choice pending</h3>' +
        '<div role="radiogroup"><button type="button" role="radio" aria-label="Proceed">Proceed</button>' +
        '<button type="button" role="radio" aria-label="Pause">Pause</button></div>';
      main.append(panel);
    });
    await runtime.kernel.dispatch('exact-task', 'fixture-alice', 'attempt-once');
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts[0]!.state,
      'planned', 'a visible provider question before POST cannot consume the attempt');
    assert.equal(await page.evaluate(() => (window as any).sends), 0);
    await page.locator('[data-codex-composer-request-navigation]').evaluate(panel => panel.remove());
    await page.locator('main').evaluate(main => {
      const stream = document.createElement('article');
      stream.setAttribute('data-message-author-role', 'assistant');
      stream.setAttribute('data-message-id', 'ongoing-provider-stream');
      stream.setAttribute('data-is-streaming', 'true');
      stream.textContent = 'Generating';
      main.append(stream);
    });
    await runtime.kernel.dispatch('exact-task', 'fixture-alice', 'attempt-once');
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts[0]!.state,
      'planned', 'an already generating provider cannot consume a future send');
    assert.equal(await page.evaluate(() => (window as any).sends), 0);
    await page.locator('[data-message-id="ongoing-provider-stream"]').evaluate(node => node.remove());
    await page.locator('#prompt-textarea').fill('Human-owned draft');
    await runtime.kernel.dispatch('exact-task', 'fixture-alice', 'attempt-once');
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts[0]!.state,
      'planned', 'a foreign draft with no exact content proof cannot consume the attempt');
    assert.equal(await page.evaluate(() => (window as any).sends), 0,
      'preflight must not click a foreign draft');
    await page.locator('#prompt-textarea').evaluate(editor => {
      editor.replaceChildren();
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    });
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
      resultId: 'exact-result', completeTask: false,
    });
    assert.equal(final?.answerText, 'Exact integrated answer');
    assert.equal(runtime.repository.getTask('exact-task', 'fixture-alice').state, 'working');
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts.length, 1);
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    assert.ok(detailReads >= 2, 'ACK and FINAL are independent reads');

    // A continuation must inherit the exact previous ACK only before its own
    // POST. Its new ACK and FINAL then bind to the new attempt, not the parent.
    await page.locator('main').evaluate(main => {
      const submitted = document.createElement('article');
      submitted.setAttribute('data-message-author-role', 'user');
      submitted.setAttribute('data-message-id', 'user-core');
      submitted.setAttribute('data-turn-id', 'turn-core');
      submitted.textContent = 'Exact integrated prompt';
      main.querySelector('[data-message-id="previous-user"]')!.after(submitted);
    });
    runtime.repository.planAttempt({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-continue',
      kind: 'continuation', turnKey: 'continue-1', content: '계속',
    });
    runtime.bindAttemptSession({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-continue',
      sessionId: session.sessionId, generation: 1, conversationId: 'core-conv',
    });
    // While the next send is still planned, a provider-owned question must
    // suspend dispatch and automatically publish one agent-owned decision.
    await page.locator('main').evaluate(main => {
      (window as any).decisionClicks = 0;
      const panel = document.createElement('section');
      panel.setAttribute('data-codex-composer-request-navigation', 'true');
      panel.setAttribute('data-user-input-auto-resolution', 'true');
      panel.innerHTML = '<h3>Provider choice pending</h3>' +
        '<div role="radiogroup"><button type="button" role="radio" ' +
        'aria-label="Proceed">Proceed</button>' +
        '<button type="button" role="radio" aria-label="Decline" disabled>Decline</button></div>';
      panel.querySelector('button')!.addEventListener('click', () => {
        (window as any).decisionClicks++;
        panel.remove();
      });
      main.append(panel);
    });
    await runtime.kernel.dispatch('exact-task', 'fixture-alice', 'attempt-continue');
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts
      .find(attempt => attempt.attemptId === 'attempt-continue')?.state, 'planned');
    assert.equal(runtime.repository.getTask('exact-task', 'fixture-alice').state,
      'agent_input_required');
    assert.equal(await page.evaluate(() => (window as any).sends), 1,
      'a pending agent question never consumes or sends the continuation');
    const pendingQuestion = runtime.decisionGateway.get('exact-task', 'fixture-alice');
    assert.equal(pendingQuestion?.kind, 'provider_question');
    assert.equal(pendingQuestion?.options[0]?.purpose, 'answer_question');
    // A repeated dispatch while the agent is deciding must not re-observe
    // and invalidate the packet's still-live actionRef.
    await runtime.kernel.dispatch('exact-task', 'fixture-alice', 'attempt-continue');
    assert.equal(runtime.decisionGateway.get('exact-task', 'fixture-alice')?.decisionId,
      pendingQuestion?.decisionId);
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    assert.equal(await page.evaluate(() => (window as any).decisionClicks), 0);
    assert.deepEqual(await runtime.decisionGateway.decide({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-continue',
      decisionId: pendingQuestion!.decisionId, requestId: 'choose-before-continue',
      actionRef: pendingQuestion!.options[0]!.actionRef, input: 'Proceed',
    }), { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).decisionClicks), 1);
    assert.equal(runtime.repository.getTask('exact-task', 'fixture-alice').state, 'working');
    continuedBackend = true;
    virtualNow += 5_001;
    await runtime.kernel.dispatch('exact-task', 'fixture-alice', 'attempt-continue');
    const continued = runtime.repository.getFullTask('exact-task', 'fixture-alice')
      .attempts.find(row => row.attemptId === 'attempt-continue')!;
    assert.equal(continued.state, 'acknowledged',
      'a planned continuation must use the previously finalized turn as its UI anchor');
    assert.equal(continued.externalTurnId, 'turn-continue');
    assert.equal(await page.evaluate(() => (window as any).sends), 2);
    const continuationEvidence = runtime.repository.getDispatchEvidence({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-continue',
    });
    assert.equal(continuationEvidence?.messageId, 'user-continue');
    assert.equal(continuationEvidence?.textHash, sha('계속'));
    virtualNow += 5_001;
    const continuedFinal = await runtime.kernel.observeFinal({
      taskId: 'exact-task', clientId: 'fixture-alice', attemptId: 'attempt-continue',
      resultId: 'continued-result', completeTask: true,
    });
    assert.equal(continuedFinal?.answerText, 'Continued exact answer');
    assert.equal(runtime.repository.getTask('exact-task', 'fixture-alice').state, 'completed');
    assert.equal(runtime.repository.getFullTask('exact-task', 'fixture-alice').attempts.length, 2);
    assert.equal(await page.evaluate(() => (window as any).sends), 2);
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
test('Core accepts only the exact resolved question decision once', {
  timeout: 45_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-decision-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const clientId = 'decision-owner';
    const team = core.teamDirectory.createTeam({ clientId });
    const roleKey = team.primaryRoleKey;
    const session = core.teamDirectory.createSession({
      teamId: team.teamId, roleKey, provider: 'chatgpt',
    });
    await core.actorScheduler.startGeneration({
      sessionId: session.sessionId, teamBriefVersion: 0, promptHash: sha('Question prompt'),
    });
    const created = await core.browserOwner!.createPage();
    const page = created.page;
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html',
      body: '<main><div data-message-author-role="user" data-message-id="decision-user" ' +
        'data-turn-id="decision-turn">Question prompt</div>' +
        '<section data-codex-composer-request-navigation="true" ' +
        'data-user-input-auto-resolution="true"><h3>Choose implementation</h3>' +
        '<div role="radiogroup"><button type="button" role="radio" aria-label="Proceed" ' +
        'onclick="window.applied++;this.closest(\'section\').remove()">Proceed</button>' +
        '<button type="button" role="radio" aria-label="Decline" disabled>Decline</button>' +
        '</div></section><div id="prompt-textarea" contenteditable="true"></div></main>' +
        '<script>window.applied=0;</script>',
    }));
    await page.goto('https://chatgpt.com/c/decision-conv');
    const binding = core.pageRegistry.reservePage(created.binding.pageKey, {
      sessionId: session.sessionId, generation: 1, conversationId: 'decision-conv',
    });
    await core.actorScheduler.updateGeneration(session.sessionId, 1, {
      conversationId: 'decision-conv', pageKey: binding.pageKey,
      submittedUserMessageId: 'decision-user', submittedUserTurnId: 'decision-turn',
      sessionState: 'observing', providerState: 'question', submissionState: 'submitted',
      promptSubmitted: true,
    });
    const store = core.semanticTaskRepository;
    store.openProject({
      projectId: team.teamId, projectKey: 'decision-core', displayName: 'Decision Core',
      clientId,
    });
    store.openSlot({ projectId: team.teamId, clientId, slotId: roleKey,
      roleKey, providerKey: 'chatgpt' });
    store.startTask({ taskId: 'decision-task', projectId: team.teamId, clientId,
      slotId: roleKey, expectedSlotRevision: 1, requestId: 'decision-request',
      prompt: 'Question prompt' });
    store.observeConversation({ taskId: 'decision-task', projectId: team.teamId,
      clientId, slotId: roleKey, expectedRevision: 1,
      providerConversationId: 'decision-conv' });
    store.planAttempt({ taskId: 'decision-task', clientId, attemptId: 'decision-attempt',
      kind: 'initial', turnKey: 'initial', content: 'Question prompt' });
    core.semanticTaskBindAttemptSession({
      taskId: 'decision-task', clientId, attemptId: 'decision-attempt',
      sessionId: session.sessionId, generation: 1, conversationId: 'decision-conv',
    });
    store.beginDispatch('decision-task', clientId, 'decision-attempt');
    store.recordDispatchEvidence({
      taskId: 'decision-task', clientId, attemptId: 'decision-attempt',
      evidence: { conversationId: 'decision-conv', messageId: 'decision-user',
        parentMessageId: 'root', textHash: sha('Question prompt'),
        observedAt: new Date().toISOString() },
    });
    store.acknowledgeAttempt({
      taskId: 'decision-task', clientId, attemptId: 'decision-attempt',
      externalTurnId: 'decision-turn',
    });
    const decisionContext = {
      projectId: team.teamId, slotId: roleKey, slotRevision: 1, taskId: 'decision-task',
      providerConversationId: 'decision-conv', submittedUserMessageId: 'decision-user',
      submittedUserTurnId: 'decision-turn',
      pageLease: { projectId: team.teamId, slotId: roleKey, slotRevision: 1,
        taskId: 'decision-task', pageKey: binding.pageKey, targetId: binding.targetId!,
        bindingEpoch: binding.bindingEpoch },
    };
    const resolved = core.semanticProviders.resolve('chatgpt', 'question');
    assert.equal(resolved.kind, 'available');
    if (resolved.kind !== 'available') throw new Error('Question provider not registered');
    const adapter = resolved.adapter;
    const observation = await adapter.observe(decisionContext);
    assert.equal(observation.blocker, 'provider_question');
    const action = observation.actions.find(a => a.purpose === 'answer_question')!;
    assert.ok(action);
    const makeContext = () => JSON.stringify({
      kind: 'semantic_action', context: decisionContext, purpose: action.purpose,
      snapshotId: observation.snapshotId, actionRef: action.actionRef,
      evidenceHash: action.evidenceHash,
    });
    const selected = 'Proceed';
    store.requireDecision({ taskId: 'decision-task', clientId,
      decisionId: 'wrong-option', audience: 'agent', contextJson: makeContext() });
    store.resolveDecision({ taskId: 'decision-task', clientId,
      decisionId: 'wrong-option', resolutionJson: JSON.stringify({
        kind: 'semantic_action', input: 'Decline',
      }) });
    const denied = await adapter.act({
      context: decisionContext, snapshotId: observation.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      input: selected, authorizedDecisionId: 'wrong-option',
    });
    assert.equal(denied.kind, 'authorization_required');
    assert.equal(await page.evaluate(() => (window as any).applied), 0);
    // Production Core now publishes a durable agent packet rather than
    // requiring the caller to hand-assemble provider selector evidence.
    const packet = await core.semanticDecisionGateway.inspect({
      taskId: 'decision-task', clientId, attemptId: 'decision-attempt',
    });
    assert.equal(packet?.kind, 'provider_question');
    assert.equal(packet?.humanOnly, false);
    assert.deepEqual(core.semanticDecisionGateway.get('decision-task', clientId), packet);
    assert.equal(packet?.options[0]?.purpose, 'answer_question');
    assert.equal(packet?.options[0]?.inputSchema.kind, 'option');
    const choice = {
      taskId: 'decision-task', clientId, attemptId: 'decision-attempt',
      requestId: 'approved-choice', decisionId: packet!.decisionId,
      actionRef: packet!.options[0]!.actionRef, input: selected,
    };
    const applied = await core.semanticDecisionGateway.decide(choice);
    assert.deepEqual(applied, { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).applied), 1);
    assert.equal(store.getFullTask('decision-task', clientId).decisions
      .find(d => d.decisionId === packet!.decisionId)?.actionConsumed, true);
    assert.deepEqual(await core.semanticDecisionGateway.decide(choice),
      { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).applied), 1);
    // Model disclosure and selection require two distinct durable decisions.
    // A question decision cannot silently authorize a model change.
    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="decision-user" data-turn-id="decision-turn">Question prompt</div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button id="model-trigger" aria-label="Model" aria-haspopup="menu" ' +
      'aria-controls="model-menu" aria-expanded="false" type="button">Current</button>' +
      '<div role="menu" id="model-menu" hidden>' +
      '<button role="menuitemradio" aria-checked="true">Default</button>' +
      '<button role="menuitemradio" aria-checked="false">Pro</button></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.modelOpens=0;window.modelChanges=0;' +
      'document.querySelector("#model-trigger").onclick=()=>{window.modelOpens++;' +
      'document.querySelector("#model-trigger").setAttribute("aria-expanded","true");' +
      'document.querySelector("#model-menu").hidden=false;};' +
      'document.querySelectorAll("[role=menuitemradio]").forEach(button=>button.onclick=()=>{' +
      'window.modelChanges++;document.querySelectorAll("[role=menuitemradio]")' +
      '.forEach(other=>other.setAttribute("aria-checked",String(other===button)));});' +
      '</script>');
    const closedModel = await adapter.observe(decisionContext);
    assert.equal(closedModel.blocker, 'none');
    const openModel = closedModel.actions.find(a => a.purpose === 'open_model_chooser')!;
    assert.ok(openModel);
    store.requireDecision({ taskId: 'decision-task', clientId,
      decisionId: 'model-open', audience: 'agent', contextJson: JSON.stringify({
        kind: 'semantic_action', context: decisionContext, purpose: openModel.purpose,
        snapshotId: closedModel.snapshotId, actionRef: openModel.actionRef,
        evidenceHash: openModel.evidenceHash,
      }) });
    store.resolveDecision({ taskId: 'decision-task', clientId,
      decisionId: 'model-open', resolutionJson: JSON.stringify({
        kind: 'semantic_action', input: null,
      }) });
    assert.deepEqual(await adapter.act({
      context: decisionContext, snapshotId: closedModel.snapshotId,
      actionRef: openModel.actionRef, evidenceHash: openModel.evidenceHash,
      authorizedDecisionId: 'model-open',
    }), { kind: 'performed', effect: 'model_menu_opened' });
    assert.equal(await page.evaluate(() => (window as any).modelOpens), 1);
    const openedModel = await adapter.observe(decisionContext);
    const chooseModel = openedModel.actions.find(a => a.purpose === 'choose_model')!;
    assert.ok(chooseModel && chooseModel.input.kind === 'option');
    store.requireDecision({ taskId: 'decision-task', clientId,
      decisionId: 'model-select', audience: 'agent', contextJson: JSON.stringify({
        kind: 'semantic_action', context: decisionContext, purpose: chooseModel.purpose,
        snapshotId: openedModel.snapshotId, actionRef: chooseModel.actionRef,
        evidenceHash: chooseModel.evidenceHash,
      }) });
    store.resolveDecision({ taskId: 'decision-task', clientId,
      decisionId: 'model-select', resolutionJson: JSON.stringify({
        kind: 'semantic_action', input: 'Pro',
      }) });
    assert.deepEqual(await adapter.act({
      context: decisionContext, snapshotId: openedModel.snapshotId,
      actionRef: chooseModel.actionRef, evidenceHash: chooseModel.evidenceHash,
      input: 'Pro', authorizedDecisionId: 'model-select',
    }), { kind: 'performed', effect: 'model_selected' });
    assert.equal(await page.evaluate(() => (window as any).modelChanges), 1);
    const finalDecisions = store.getFullTask('decision-task', clientId).decisions;
    assert.ok(['model-open', 'model-select'].every(id =>
      finalDecisions.find(d => d.decisionId === id)?.actionConsumed));
    // A provider stream Retry is also a one-shot external effect, not a
    // repeat of the journaled prompt or a general model decision.
    await page.setContent('<main><div data-message-author-role="user" ' +
      'data-message-id="decision-user" data-turn-id="decision-turn">Question prompt</div>' +
      '<div role="alert">Error in message stream <button id="retry">Retry</button></div>' +
      '<div id="prompt-textarea" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.retries=0;document.querySelector("#retry").onclick=()=>{' +
      'window.retries++;document.querySelector("[role=alert]").remove();};</script>');
    const retryObserved = await adapter.observe(decisionContext);
    assert.equal(retryObserved.blocker, 'provider_retry');
    const retryAction = retryObserved.actions.find(a => a.purpose === 'retry')!;
    assert.ok(retryAction && retryAction.risk === 'retry_once');
    store.requireDecision({ taskId: 'decision-task', clientId,
      decisionId: 'stream-retry', audience: 'agent', contextJson: JSON.stringify({
        kind: 'semantic_action', context: decisionContext, purpose: retryAction.purpose,
        snapshotId: retryObserved.snapshotId, actionRef: retryAction.actionRef,
        evidenceHash: retryAction.evidenceHash,
      }) });
    store.resolveDecision({ taskId: 'decision-task', clientId,
      decisionId: 'stream-retry', resolutionJson: JSON.stringify({
        kind: 'semantic_action', input: null,
      }) });
    const retried = await adapter.act({
      context: decisionContext, snapshotId: retryObserved.snapshotId,
      actionRef: retryAction.actionRef, evidenceHash: retryAction.evidenceHash,
      authorizedDecisionId: 'stream-retry',
    });
    assert.deepEqual(retried, {
      kind: 'uncertain', reason: 'retry-clicked-provider-progress-unverified',
    });
    assert.equal(await page.evaluate(() => (window as any).retries), 1);
    assert.equal(store.getFullTask('decision-task', clientId).decisions
      .find(d => d.decisionId === 'stream-retry')?.actionConsumed, true);
    assert.equal((await adapter.act({
      context: decisionContext, snapshotId: retryObserved.snapshotId,
      actionRef: retryAction.actionRef, evidenceHash: retryAction.evidenceHash,
      authorizedDecisionId: 'stream-retry',
    })).kind, 'stale');
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('Core recovers historical ChatGPT ACK and FINAL after cancel and slot replacement without a page', {
  timeout: 25_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-historical-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, startBrowser: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const clientId = 'historical-client';
    const team = core.teamDirectory.createTeam({ clientId });
    const slotId = team.primaryRoleKey;
    const session = core.teamDirectory.createSession({
      teamId: team.teamId, roleKey: slotId, provider: 'chatgpt',
    });
    const store = core.semanticTaskRepository;
    store.openProject({
      projectId: team.teamId, projectKey: 'historical-final', displayName: 'Historical',
      clientId,
    });
    store.openSlot({
      projectId: team.teamId, clientId, slotId, roleKey: slotId, providerKey: 'chatgpt',
    });
    store.startTask({
      taskId: 'historical-task', projectId: team.teamId, slotId, clientId,
      expectedSlotRevision: 1, requestId: 'historical-request',
      prompt: 'Historical task prompt',
    });
    store.observeConversation({
      taskId: 'historical-task', projectId: team.teamId, slotId, clientId,
      expectedRevision: 1, providerConversationId: 'historical-conversation',
    });
    store.planAttempt({
      taskId: 'historical-task', clientId, attemptId: 'historical-attempt',
      kind: 'initial', turnKey: 'initial', content: 'Historical task prompt',
    });
    // An original send has already occurred; no browser is needed for recovery.
    store.bindAttemptSession({
      taskId: 'historical-task', clientId, attemptId: 'historical-attempt',
      sessionId: session.sessionId, generation: 1, conversationId: 'historical-conversation',
    });
    store.beginDispatch('historical-task', clientId, 'historical-attempt');
    store.recordDispatchEvidence({
      taskId: 'historical-task', clientId, attemptId: 'historical-attempt',
      evidence: {
        conversationId: 'historical-conversation', messageId: 'historical-user',
        parentMessageId: 'root', textHash: sha('Historical task prompt'),
        observedAt: '2026-11-11T09:00:00.000Z',
      },
    });
    store.markUncertain('historical-task', clientId, 'historical-attempt', 'lost-ack');
    store.requestCancel('historical-task', clientId);
    store.planAttempt({
      taskId: 'historical-task', clientId, attemptId: 'historical-stop',
      kind: 'stop', turnKey: 'stop', content: '',
    });
    store.beginDispatch('historical-task', clientId, 'historical-stop');
    store.acknowledgeAttempt({
      taskId: 'historical-task', clientId, attemptId: 'historical-stop',
      externalTurnId: 'confirmed-stop',
    });
    store.confirmCancel('historical-task', clientId);
    const replacement = store.replaceBinding({
      projectId: team.teamId, clientId, slotId, expectedRevision: 1,
      providerKey: 'alternate-provider', providerConversationId: 'different-conversation',
    });
    assert.equal(replacement.revision, 2);
    const successor = store.startTask({
      taskId: 'successor-task', projectId: team.teamId, slotId, clientId,
      expectedSlotRevision: 2, requestId: 'successor-request',
      prompt: 'Unrelated new prompt',
    });
    assert.equal(store.getSlot(team.teamId, slotId, clientId).activeTaskId, 'successor-task');
    let detailReads = 0;
    const payload = {
      id: 'historical-conversation', current_node: 'answer-node',
      mapping: {
        root: { id: 'root', parent: null, children: [], message: null },
        'user-node': { id: 'user-node', parent: 'root', children: [], message: {
          id: 'historical-user', turn_id: 'historical-turn',
          author: { role: 'user' }, content: { parts: ['Historical task prompt'] },
        } },
        'answer-node': { id: 'answer-node', parent: 'user-node', children: [],
          message: {
            id: 'historical-answer', author: { role: 'assistant' },
            channel: 'final', status: 'finished_successfully', end_turn: true,
            content: { parts: ['Late exact answer'] }, metadata: {},
          },
        },
      },
    };
    const client: BackendJsonClient = {
      authScope: {},
      async get(url) {
        if (url.endsWith('/api/auth/session')) {
          return { status: 200, headers: {}, body: { accessToken: 'fixture-only' } };
        }
        assert.ok(url.includes('historical-conversation'),
          'a replacement conversation must never supply the old answer');
        detailReads++;
        return { status: 200, headers: {}, body: payload };
      },
    };
    let virtualNow = 100_000;
    const runtime = createSemanticCoreRuntime({
      database: core.database, browserOwner: null,
      pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
      pageMutationMutex: core.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
      backendClientProvider: () => client,
      backendRecovery: new ChatGptBackendRecovery({
        requestTimeoutMs: 500, tokenCacheTtlMs: 10_000,
        now: () => new Date(virtualNow),
      }),
    });
    assert.equal(core.pageRegistry.listBindings().length, 0);
    await runtime.kernel.recoverAck('historical-task', clientId, 'historical-attempt');
    assert.equal(store.getFullTask('historical-task', clientId).attempts
      .find(a => a.attemptId === 'historical-attempt')?.state, 'acknowledged',
    'late original ACK must attach despite another current slot revision');
    const deferred = await runtime.kernel.observeFinal({
      taskId: 'historical-task', clientId, attemptId: 'historical-attempt',
      resultId: 'historical-result', completeTask: true,
    });
    assert.equal(deferred, null, 'back-to-back FINAL reads honor backend pacing');
    assert.equal(detailReads, 1, 'a waiting FINAL never consumes another backend slot');
    const deferredEvents = store.getFullTask('historical-task', clientId).events
      .filter(entry => entry.event.type === 'observation.deferred');
    assert.equal(deferredEvents.length, 1,
      'a paced canonical FINAL must leave one durable per-attempt reason');
    assert.match((deferredEvents[0]!.event as { reason: string }).reason,
      /^final:historical-attempt:pending:/);
    virtualNow += 5_001;
    const final = await runtime.kernel.observeFinal({
      taskId: 'historical-task', clientId, attemptId: 'historical-attempt',
      resultId: 'historical-result', completeTask: true,
    });
    assert.equal(final?.answerText, 'Late exact answer');
    assert.equal(store.getTask('historical-task', clientId).state, 'canceled');
    assert.equal(store.getTask('successor-task', clientId).state, successor.state);
    assert.equal(store.getSlot(team.teamId, slotId, clientId).activeTaskId, 'successor-task');
    assert.equal(store.getSlot(team.teamId, slotId, clientId).providerConversationId,
      'different-conversation');
    assert.ok(detailReads >= 2, 'ACK and FINAL each use the historical identity');
    assert.equal(core.pageRegistry.listBindings().length, 0);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('Core-owned approved 20-minute continuation sends one exact POST without a waiting client', {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-core-managed-browser-'));
  const core = await startCore({
    config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }),
    browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const clientId = 'managed-browser-owner';
    const team = core.teamDirectory.createTeam({ clientId });
    const slotId = team.primaryRoleKey;
    const session = core.teamDirectory.createSession({
      teamId: team.teamId, roleKey: slotId, provider: 'chatgpt',
    });
    await core.actorScheduler.startGeneration({
      sessionId: session.sessionId, teamBriefVersion: 0, promptHash: sha('Root question'),
    });
    const owned = await core.browserOwner!.createPage();
    const page = owned.page;
    await page.route('https://chatgpt.com/**', route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: '<main><article data-message-author-role="user" ' +
          'data-message-id="user-root" data-turn-id="turn-root">Root question</article>' +
          '<section data-chatgpt-composer><div id="prompt-textarea" ' +
          'contenteditable="true" role="textbox"></div>' +
          '<button data-testid="send-button" type="button">Send</button></section>' +
          '</main><script>window.sends=0;' +
          'document.querySelector("button").onclick=()=>{' +
          'const editor=document.querySelector("#prompt-textarea");' +
          'const text=editor.innerText;window.sends++;' +
          'fetch("/backend-api/f/conversation",{method:"POST",' +
          'headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
          'action:"next",conversation_id:"managed-conversation",parent_message_id:"assistant-root",' +
          'messages:[{id:"user-managed",author:{role:"user"},' +
          'content:{content_type:"text",parts:[text]}}]})});editor.textContent="";};</script>',
      });
    });
    await page.goto('https://chatgpt.com/c/managed-conversation');
    const bound = core.pageRegistry.reservePage(owned.binding.pageKey, {
      sessionId: session.sessionId, generation: 1, conversationId: 'managed-conversation',
    });
    assert.equal(bound.state, 'owned');
    await core.actorScheduler.updateGeneration(session.sessionId, 1, {
      conversationId: 'managed-conversation', pageKey: bound.pageKey,
      sessionState: 'ready', providerState: 'idle',
    });
    const repository = core.semanticTaskRepository;
    repository.openProject({
      projectId: team.teamId, projectKey: 'managed-browser-fixture',
      displayName: 'Managed browser fixture', clientId,
    });
    repository.openSlot({
      projectId: team.teamId, clientId, slotId, roleKey: slotId, providerKey: 'chatgpt',
    });
    repository.startTask({
      taskId: 'managed-task', projectId: team.teamId, slotId,
      expectedSlotRevision: 1, clientId,
      requestId: 'managed-start', prompt: 'Root question',
    });
    repository.observeConversation({
      projectId: team.teamId, clientId, slotId, expectedRevision: 1,
      taskId: 'managed-task', providerConversationId: 'managed-conversation',
    });
    repository.planAttempt({
      taskId: 'managed-task', clientId, attemptId: 'managed-original',
      kind: 'initial', turnKey: 'original', content: 'Root question',
    });
    core.semanticTaskBindAttemptSession({
      taskId: 'managed-task', clientId, attemptId: 'managed-original',
      sessionId: session.sessionId, generation: 1, conversationId: 'managed-conversation',
    });
    repository.beginDispatch('managed-task', clientId, 'managed-original');
    repository.recordDispatchEvidence({
      taskId: 'managed-task', clientId, attemptId: 'managed-original',
      evidence: {
        conversationId: 'managed-conversation', messageId: 'user-root',
        parentMessageId: 'root', textHash: sha('Root question'),
        observedAt: new Date().toISOString(),
      },
    });
    repository.acknowledgeAttempt({
      taskId: 'managed-task', clientId, attemptId: 'managed-original',
      externalTurnId: 'turn-root',
    });
    repository.recordFinal({
      taskId: 'managed-task', clientId, attemptId: 'managed-original',
      externalTurnId: 'turn-root', resultId: 'managed-original-result',
      answerText: 'More work remains', completeTask: false,
    });
    const payload = {
      id: 'managed-conversation', current_node: 'assistant-managed',
      mapping: {
        root: { id: 'root', parent: null, children: [], message: null },
        'user-root-node': {
          id: 'user-root-node', parent: 'root', children: [],
          message: { id: 'user-root', turn_id: 'turn-root',
            author: { role: 'user' }, content: { parts: ['Root question'] } },
        },
        'assistant-root': {
          id: 'assistant-root', parent: 'user-root-node', children: [],
          message: { id: 'assistant-root', author: { role: 'assistant' },
            channel: 'final', status: 'finished_successfully', end_turn: true,
            content: { parts: ['More work remains'] }, metadata: {} },
        },
        'user-managed-node': {
          id: 'user-managed-node', parent: 'assistant-root', children: [],
          message: { id: 'user-managed', turn_id: 'turn-managed',
            author: { role: 'user' }, content: { parts: ['계속'] } },
        },
        'assistant-managed': {
          id: 'assistant-managed', parent: 'user-managed-node', children: [],
          message: { id: 'assistant-managed', author: { role: 'assistant' },
            channel: 'final', status: 'finished_successfully', end_turn: true,
            content: { parts: ['Managed final response'] }, metadata: {} },
        },
      },
    };
    const backend: BackendJsonClient = {
      async get(url) {
        return url.endsWith('/api/auth/session')
          ? { status: 200, headers: {}, body: { accessToken: 'fixture-only' } }
          : { status: 200, headers: {}, body: payload };
      },
    };
    const prior = repository.getFullTask('managed-task', clientId).attempts[0]!;
    let clock = Date.parse(prior.acknowledgedAt!);
    const runtime = createSemanticCoreRuntime({
      database: core.database, browserOwner: core.browserOwner,
      pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
      pageMutationMutex: core.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
      backendClientProvider: () => backend, continuationNow: () => new Date(clock),
      backendRecovery: new ChatGptBackendRecovery({
        requestTimeoutMs: 500, tokenCacheTtlMs: 10_000,
        now: () => new Date(clock),
      }),
    });
    assert.throws(() => runtime.managedContinuation.activate({
      taskId: 'managed-task', clientId, sourceAttemptId: 'managed-original',
      approvalRef: 'explicit-approved-continuation', message: 'Change the model',
    }), /exact approved literal/, 'ChatGPT cannot turn an approved Continue into another prompt');
    const due = runtime.managedContinuation.activate({
      taskId: 'managed-task', clientId, sourceAttemptId: 'managed-original',
      approvalRef: 'explicit-approved-continuation', message: '계속',
    });
    assert.equal(Date.parse(due.dueAt), clock + 1_200_000);
    clock += 1_200_000 - 1;
    assert.equal((await runtime.managedContinuation.tick()).timersClaimed, 0);
    assert.equal(await page.evaluate(() => (window as any).sends), 0);
    clock++;
    assert.deepEqual(await runtime.managedContinuation.tick(), {
      timersClaimed: 1, dispatchesAttempted: 1, deferred: 0,
    });
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    const exact = repository.getFullTask('managed-task', clientId).attempts[1]!;
    assert.equal(exact.kind, 'continuation');
    assert.equal(exact.content, '계속');
    assert.equal(exact.state, 'acknowledged');
    assert.equal(exact.externalTurnId, 'turn-managed');
    assert.equal(repository.getAttemptSessionBinding({
      taskId: 'managed-task', clientId, attemptId: exact.attemptId,
    })?.sessionId, session.sessionId);
    assert.equal(repository.getDispatchEvidence({
      taskId: 'managed-task', clientId, attemptId: exact.attemptId,
    })?.messageId, 'user-managed');
    clock += 5_001; // independent canonical FINAL GET after the ACK read interval
    const final = await runtime.kernel.observeFinal({
      taskId: 'managed-task', clientId, attemptId: exact.attemptId,
      resultId: 'managed-final', completeTask: true,
    });
    assert.equal(final?.answerText, 'Managed final response');
    assert.equal(repository.getTask('managed-task', clientId).state, 'completed');
    assert.equal((await runtime.managedContinuation.tick()).timersClaimed, 0);
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    await runtime.managedContinuation.close();
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('Core restart marks interrupted semantic dispatch uncertain without a new POST', {
  timeout: 45_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-semantic-restart-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  let core = await startCore({ config, startBrowser: false, logger });
  try {
    const store = core.semanticTaskRepository;
    store.openProject({
      projectId: 'crash-project', projectKey: 'semantic-restart-fixture',
      displayName: 'Crash fixture', clientId: 'alice',
    });
    store.openSlot({
      projectId: 'crash-project', clientId: 'alice',
      slotId: 'main', roleKey: 'Main', providerKey: 'chatgpt',
    });
    store.startTask({
      taskId: 'crashed-task', projectId: 'crash-project',
      slotId: 'main', expectedSlotRevision: 1, clientId: 'alice',
      requestId: 'crashed-request', prompt: 'Do not replay',
    });
    store.planAttempt({
      taskId: 'crashed-task', clientId: 'alice',
      attemptId: 'crashed-attempt', kind: 'initial', turnKey: 'root',
      content: 'Do not replay',
    });
    store.beginDispatch('crashed-task', 'alice', 'crashed-attempt');
    assert.equal(store.getFullTask('crashed-task', 'alice').attempts[0]!.state,
      'dispatched');
    await core.close();
    core = await startCore({ config, startBrowser: false, logger });
    const recovered = core.semanticTaskRepository.getFullTask('crashed-task', 'alice');
    assert.equal(recovered.attempts[0]!.state, 'uncertain');
    assert.equal(recovered.task.state, 'uncertain');
    assert.equal(recovered.events
      .filter(event => event.event.type === 'attempt.uncertain').length, 1);
    await assert.rejects(core.semanticTaskKernel.dispatch(
      'crashed-task', 'alice', 'crashed-attempt',
    ), /Mutation already attempted/, 'Core restart cannot send the original prompt');
    assert.equal(core.semanticTaskRepository.getFullTask(
      'crashed-task', 'alice').attempts.length, 1);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('public task.start uses Core-owned verified existing conversation for one initial POST', {
  timeout: 70_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-public-owned-initial-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const clientId = 'public-sender-fixture';
    const project = await callRpc<any>({
      socketPath: config.socketPath, method: 'project.open',
      params: {
        clientId, requestId: 'create-owned-project',
        projectKey: 'owned-conversation-project', displayName: 'Owned project',
        provider: 'chatgpt', surfaceIntent: 'chat',
      }, timeoutMs: 10_000,
    });
    const task = await callRpc<any>({
      socketPath: config.socketPath, method: 'task.start',
      params: {
        clientId, requestId: 'start-once-owned',
        projectId: project.projectId,
        expectedConversationRevision: project.conversationRevision,
        prompt: 'Public exact first question',
      }, timeoutMs: 10_000,
    });
    const store = core.semanticTaskRepository;
    const attempt = store.getFullTask(task.taskId, clientId).attempts[0]!;
    assert.equal(attempt.state, 'planned');
    // A new project without a verified provider conversation cannot send.
    let virtualNow = 1_000_000;
    const payload = {
      id: 'public-owned-conversation', current_node: 'answer-node',
      mapping: {
        root: { id: 'root', parent: null, children: [], message: null },
        'user-node': {
          id: 'user-node', parent: 'root', children: [],
          message: { id: 'public-exact-message', turn_id: 'public-exact-turn',
            author: { role: 'user' },
            content: { parts: ['Public exact first question'] } },
        },
        'answer-node': {
          id: 'answer-node', parent: 'user-node', children: [],
          message: { id: 'answer', author: { role: 'assistant' },
            channel: 'final', status: 'finished_successfully', end_turn: true,
            content: { parts: ['Public answer produced once'] }, metadata: {} },
        },
      },
    };
    const backend: BackendJsonClient = {
      authScope: {},
      async get(url) {
        return url.endsWith('/api/auth/session')
          ? { status: 200, headers: {}, body: { accessToken: 'fixture-only' } }
          : { status: 200, headers: {}, body: payload };
      },
    };
    const runtime = createSemanticCoreRuntime({
      database: core.database, browserOwner: core.browserOwner,
      pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
      pageMutationMutex: core.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
      backendClientProvider: () => backend,
      backendRecovery: new ChatGptBackendRecovery({
        requestTimeoutMs: 500, tokenCacheTtlMs: 10_000,
        now: () => new Date(virtualNow),
      }),
      continuationNow: () => new Date(virtualNow),
    });
    await runtime.managedContinuation.tick();
    assert.equal(store.getFullTask(task.taskId, clientId).attempts[0]!.state, 'planned');
    const session = core.teamDirectory.getCurrentSession(project.projectId, 'main');
    await core.actorScheduler.startGeneration({
      sessionId: session.sessionId, teamBriefVersion: 0,
      promptHash: sha('Public exact first question'),
    });
    const owned = await core.browserOwner!.createPage();
    const page = owned.page;
    await page.route('https://chatgpt.com/**', route => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 202, contentType: 'application/json', body: '{}',
        });
      }
      return route.fulfill({ contentType: 'text/html', body:
        '<main><article data-message-author-role="user" ' +
        'data-message-id="previous-user">Previous content</article>' +
        '<section data-chatgpt-composer>' +
        '<div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
        '<button data-testid="send-button" type="button">Send</button>' +
        '</section></main><script>' +
        'window.sends=0;document.querySelector("button").onclick=()=>{' +
        'const editor=document.querySelector("#prompt-textarea");' +
        'window.sends++;fetch("/backend-api/f/conversation",{method:"POST",' +
        'headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
        'action:"next",conversation_id:"public-owned-conversation",' +
        'parent_message_id:"root",messages:[{id:"public-exact-message",' +
        'author:{role:"user"},content:{content_type:"text",parts:[editor.innerText]}}]' +
        '})});editor.textContent="";};</script>',
      });
    });
    await page.goto('https://chatgpt.com/c/public-owned-conversation');
    core.pageRegistry.reservePage(owned.binding.pageKey, {
      sessionId: session.sessionId, generation: 1,
      conversationId: 'public-owned-conversation',
    });
    await core.actorScheduler.updateGeneration(session.sessionId, 1, {
      conversationId: 'public-owned-conversation', pageKey: owned.binding.pageKey,
      sessionState: 'ready', providerState: 'idle',
    });
    store.observeConversation({
      projectId: project.projectId, slotId: 'main', expectedRevision: 1,
      clientId, taskId: task.taskId,
      providerConversationId: 'public-owned-conversation',
    });
    await runtime.managedContinuation.tick();
    const dispatched = store.getFullTask(task.taskId, clientId).attempts[0]!;
    assert.equal(dispatched.state, 'acknowledged',
      'no caller manually binds attempt or dispatches a provider POST');
    assert.equal(dispatched.externalTurnId, 'public-exact-turn');
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    assert.equal(store.getDispatchEvidence({
      taskId: task.taskId, clientId, attemptId: attempt.attemptId,
    })?.messageId, 'public-exact-message');
    virtualNow += 5_001;
    await runtime.managedContinuation.tick();
    assert.equal(store.getTask(task.taskId, clientId).state, 'completed');
    assert.equal(store.getFullTask(task.taskId, clientId).results[0]?.answerText,
      'Public answer produced once');
    await runtime.managedContinuation.tick();
    assert.equal(await page.evaluate(() => (window as any).sends), 1);
    await runtime.managedContinuation.close();
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test('public task.start with explicit Pro intent emits agent model decision before any POST', {
  timeout: 45_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sessionplane-public-pro-intent-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({
    config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  try {
    const clientId = 'public-model-agent';
    const project = await callRpc<any>({
      socketPath: config.socketPath, method: 'project.open',
      params: {
        clientId, requestId: 'open-model-project',
        projectKey: 'model-pro-project', displayName: 'Requested Pro',
        provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
      }, timeoutMs: 10_000,
    });
    const task = await callRpc<any>({
      socketPath: config.socketPath, method: 'task.start',
      params: {
        clientId, requestId: 'start-model-task',
        projectId: project.projectId,
        expectedConversationRevision: project.conversationRevision,
        prompt: 'Do not submit under an unknown model',
      }, timeoutMs: 10_000,
    });
    const session = core.teamDirectory.getCurrentSession(project.projectId, 'main');
    await core.actorScheduler.startGeneration({
      sessionId: session.sessionId, teamBriefVersion: 0,
      promptHash: sha('Do not submit under an unknown model'),
    });
    const owned = await core.browserOwner!.createPage();
    const page = owned.page;
    await page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body:
        '<main><article data-message-author-role="user">Prior chat</article>' +
        '<section data-chatgpt-composer><div id="prompt-textarea" ' +
        'role="textbox" contenteditable="true"></div>' +
        '<button data-testid="send-button" type="button" ' +
        'onclick="window.sends++">Send</button></section>' +
        '<button id="model-trigger" aria-label="Model" aria-haspopup="menu" ' +
        'aria-controls="model-menu" aria-expanded="false" type="button">Current</button>' +
        '<div id="model-menu" role="menu" hidden>' +
        '<button role="menuitemradio" aria-checked="true">Default</button>' +
        '<button role="menuitemradio" aria-checked="false">Pro</button></div>' +
        '</main><script>window.sends=0;</script>',
    }));
    await page.goto('https://chatgpt.com/c/public-pro-conversation');
    core.pageRegistry.reservePage(owned.binding.pageKey, {
      sessionId: session.sessionId, generation: 1,
      conversationId: 'public-pro-conversation',
    });
    await core.actorScheduler.updateGeneration(session.sessionId, 1, {
      conversationId: 'public-pro-conversation',
      pageKey: owned.binding.pageKey, sessionState: 'ready', providerState: 'idle',
    });
    core.semanticTaskRepository.observeConversation({
      projectId: project.projectId, slotId: 'main', expectedRevision: 1,
      clientId, taskId: task.taskId,
      providerConversationId: 'public-pro-conversation',
    });
    await core.semanticManagedContinuation.tick();
    const full = core.semanticTaskRepository.getFullTask(task.taskId, clientId);
    assert.equal(full.task.state, 'agent_input_required');
    assert.equal(full.attempts[0]!.state, 'planned');
    assert.equal(await page.evaluate(() => (window as any).sends), 0);
    const packet = core.semanticDecisionGateway.get(task.taskId, clientId);
    assert.equal(packet?.kind, 'model_choice');
    assert.equal(packet?.requestedModel, 'Pro');
    assert.equal(packet?.options[0]?.purpose, 'open_model_chooser');
    assert.equal(packet?.humanOnly, false);
    await core.semanticManagedContinuation.tick();
    assert.equal(core.semanticDecisionGateway.get(task.taskId, clientId)?.decisionId,
      packet?.decisionId);
    assert.equal(await page.evaluate(() => (window as any).sends), 0);
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
