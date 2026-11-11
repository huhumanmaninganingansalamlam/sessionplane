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
    store.requireDecision({ taskId: 'decision-task', clientId,
      decisionId: 'approved-choice', audience: 'agent', contextJson: makeContext() });
    store.resolveDecision({ taskId: 'decision-task', clientId,
      decisionId: 'approved-choice', resolutionJson: JSON.stringify({
        kind: 'semantic_action', input: selected,
      }) });
    const applied = await adapter.act({
      context: decisionContext, snapshotId: observation.snapshotId,
      actionRef: action.actionRef, evidenceHash: action.evidenceHash,
      input: selected, authorizedDecisionId: 'approved-choice',
    });
    assert.deepEqual(applied, { kind: 'performed', effect: 'question_answered' });
    assert.equal(await page.evaluate(() => (window as any).applied), 1);
    assert.equal(store.getFullTask('decision-task', clientId).decisions
      .find(d => d.decisionId === 'approved-choice')?.actionConsumed, true);
    assert.equal((await adapter.act({ context: decisionContext,
      snapshotId: observation.snapshotId, actionRef: action.actionRef,
      evidenceHash: action.evidenceHash, input: selected,
      authorizedDecisionId: 'approved-choice' })).kind, 'stale');
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
