import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../../src/config.ts';
import { callRpc } from '../../src/cli/client.ts';
import { createSemanticCoreRuntime } from '../../src/core/semantic-core-runtime.ts';
import { ChatGptBackendRecovery } from '../../src/providers/chatgpt/backend-recovery.ts';
import { startCore } from '../../src/main.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Four distinct public projects get four different background CDP targets.
 * Nothing here authenticates to ChatGPT or sends actual prompts. One Core
 * journal, BrowserOwner, page registry and actor scheduler own all four.
 */
test('four public projects prepare four independent background Main roots without focus or cross-project dispatch', {
  timeout: 100_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sp-four-projects-l2-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, browserHeadless: true, logger });
  let runtime: ReturnType<typeof createSemanticCoreRuntime> | undefined;
  try {
    await core.semanticManagedContinuation.close();
    const owner = core.browserOwner!;
    let userForegroundChanges = 0;
    const originalFocus = owner.focusPage.bind(owner);
    owner.focusPage = async (...args) => {
      userForegroundChanges++;
      throw new Error('No background project may focus the user tab');
    };
    const bootstrap = await owner.createPage();
    await bootstrap.page.context().route('https://chatgpt.com/**', route => {
      if (route.request().method() !== 'GET') {
        return route.fulfill({ status: 403, contentType: 'application/json',
          body: '{"error":"unapproved-send"}' });
      }
      return route.fulfill({ contentType: 'text/html',
        body: '<meta charset="utf-8"><main><section data-chatgpt-composer>' +
          '<div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
          '<button data-testid="send-button" disabled>Send</button>' +
          '<button id="model-trigger" aria-label="ChatGPT 모델 선택" aria-haspopup="menu" ' +
          'aria-expanded="false" data-state="closed">추론 수준<br>Instant</button>' +
          '</section></main>' });
    });
    runtime = createSemanticCoreRuntime({
      database: core.database, browserOwner: owner,
      pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
      actorScheduler: core.actorScheduler, pageMutationMutex: core.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
    });
    const clientId = 'owned-four-background-projects';
    const projects: Array<{
      projectId: string; taskId: string; sessionId: string; pageKey: string;
      targetId: string; conversationRevision: number;
    }> = [];
    const created: Array<{ projectId: string; taskId: string; revision: number }> = [];
    for (let index = 0; index < 4; index++) {
      const project = await callRpc<any>({
        socketPath: config.socketPath, method: 'project.open',
        params: { clientId, requestId: 'open-' + index,
          projectKey: 'independent-fixture-project-' + index,
          displayName: 'Project ' + index, provider: 'chatgpt', surfaceIntent: 'chat' },
      });
      const start = await callRpc<any>({
        socketPath: config.socketPath, method: 'task.start',
        params: { clientId, requestId: 'start-' + index,
          projectId: project.projectId, expectedConversationRevision: project.conversationRevision,
          prompt: 'Independent private fixture prompt ' + index },
      });
      created.push({ projectId: project.projectId, taskId: start.taskId,
        revision: project.conversationRevision });
    }
    for (let attempts = 0; attempts < 12; attempts++) {
      await runtime.managedContinuation.tick();
      if (created.every(({ projectId }) =>
        core.teamDirectory.getCurrentSession(projectId, 'main').pageKey !== null)) break;
    }
    for (const { projectId, taskId, revision } of created) {
      const session = core.teamDirectory.getCurrentSession(projectId, 'main');
      assert.ok(session.pageKey, 'Public project must allocate its own Main background page');
      assert.equal(session.generation, 1);
      assert.equal(session.conversationId, null);
      assert.equal(session.promptSubmitted, false);
      assert.equal(session.sessionState, 'ready');
      const binding = core.pageRegistry.getBinding(session.pageKey);
      assert.equal(binding.state, 'reserved');
      assert.equal(binding.sessionId, session.sessionId);
      assert.equal(binding.generation, 1);
      assert.equal(binding.conversationId, null);
      assert.equal(binding.expectedConversationId, null);
      assert.equal(binding.url, 'https://chatgpt.com/');
      assert.ok(binding.targetId);
      const full = core.semanticTaskRepository.getFullTask(taskId, clientId);
      assert.equal(full.attempts.length, 1);
      assert.equal(full.attempts[0]!.state, 'planned');
      assert.equal(full.results.length, 0);
      assert.equal(full.task.state, 'agent_input_required');
      assert.equal(core.semanticDecisionGateway.get(taskId, clientId)?.kind, 'model_choice',
        'An Instant model must not be silently substituted for required Pro');
      assert.equal(core.semanticTaskRepository.getSlot(projectId, 'main', clientId)
        .providerConversationId, null);
      projects.push({ projectId, taskId, sessionId: session.sessionId,
        pageKey: session.pageKey, targetId: binding.targetId,
        conversationRevision: revision });
    }
    assert.equal(new Set(projects.map(item => item.projectId)).size, 4);
    assert.equal(new Set(projects.map(item => item.sessionId)).size, 4);
    assert.equal(new Set(projects.map(item => item.pageKey)).size, 4);
    assert.equal(new Set(projects.map(item => item.targetId)).size, 4);
    assert.equal(userForegroundChanges, 0);
    // Repeated Core tick and read-only task get must not allocate another
    // page, borrow a peer's decision, or consume an original POST.
    const before = projects.map(({ projectId }) =>
      core.teamDirectory.getCurrentSession(projectId, 'main').pageKey);
    for (let i = 0; i < 4; i++) {
      await runtime.managedContinuation.tick();
      for (const item of projects) {
        const current = await callRpc<any>({
          socketPath: config.socketPath, method: 'task.get',
          params: { clientId, taskId: item.taskId, view: 'evidence' },
        });
        assert.equal(current.conversationSlotId, 'main');
        assert.equal(current.submission.attempted, false);
        assert.equal(current.submission.acknowledged, false);
        assert.equal(current.evidence.rootPost, null);
        assert.equal(current.evidence.conversation.providerConversationId, null);
        assert.equal(current.state, 'agent_input_required');
      }
    }
    assert.deepEqual(projects.map(item =>
      core.teamDirectory.getCurrentSession(item.projectId, 'main').pageKey), before);
    assert.equal(userForegroundChanges, 0);
    const nonClosed = core.pageRegistry.listBindings({ includeClosed: false });
    for (const page of projects) {
      assert.equal(nonClosed.filter(binding =>
        binding.pageKey === page.pageKey && binding.state === 'reserved').length, 1);
    }
    console.log('FOUR_PROJECT_L2 ' + JSON.stringify({
      projects: projects.length, separatePageKeys: 4, separateTargets: 4,
      originalPromptsSent: 0, nativeFocusCalls: userForegroundChanges,
      allRequireExplicitModelDecision: true,
    }));
    owner.focusPage = originalFocus;
  } finally {
    await runtime?.managedContinuation.close();
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});


/** Stronger L2 acceptance than page allocation alone: four exact independent
 * prompts each commit one POST, canonical ACK and FINAL under one Core. The
 * ChatGPT HTTP/UI is a disposable controlled fixture, not a real account.
 */
test('four independent background Main projects each submit once, bind their own canonical ACK and return their own exact FINAL', {
  timeout: 140_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sp-four-completed-roots-l2-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, browserHeadless: true, logger });
  let runtime: ReturnType<typeof createSemanticCoreRuntime> | undefined;
  try {
    await core.semanticManagedContinuation.close();
    const owner = core.browserOwner!;
    let nativeFocusCalls = 0;
    owner.focusPage = async () => {
      nativeFocusCalls++;
      throw new Error('Foreground activation is forbidden for background submissions');
    };
    const bootstrap = await owner.createPage();
    const capturedPosts: unknown[] = [];
    await bootstrap.page.context().route('https://chatgpt.com/**', route => {
      if (route.request().method() === 'POST') {
        capturedPosts.push(route.request().postDataJSON());
        return route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
      }
      if (route.request().method() !== 'GET') {
        return route.fulfill({ status: 405 });
      }
      return route.fulfill({ contentType: 'text/html', body:
        '<meta charset="utf-8"><main><section data-chatgpt-composer>' +
        '<div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
        '<button data-testid="send-button" type="button">Send</button>' +
        '<button id="model-trigger" aria-label="ChatGPT 모델 선택" ' +
        'aria-haspopup="menu" aria-expanded="false" data-state="closed">추론 수준<br>Pro</button>' +
        '</section></main><script>' +
        'window.sends=0;' +
        'document.querySelector("[data-testid=send-button]").onclick=()=>{' +
        'const editor=document.querySelector("#prompt-textarea");' +
        'const prompt=editor.innerText;const index=Number(prompt.slice(-1));' +
        'window.sends++;' +
        'fetch("/backend-api/f/conversation",{method:"POST",' +
        'headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
        'action:"next",parent_message_id:"four-parent-"+index,' +
        'messages:[{id:"four-user-"+index,author:{role:"user"},' +
        'content:{content_type:"text",parts:[prompt]}}]})});' +
        'history.pushState({},"","/c/four-conv-"+index);editor.textContent="";};' +
        '</script>' });
    });
    let virtualNow = 100_000;
    let backendConversationGets = 0;
    let injected429 = false;
    const backend = {
      authScope: {},
      async get(url: string) {
        if (url.endsWith('/api/auth/session')) {
          return { status: 200, headers: {}, body: { accessToken: 'fixture-only' } };
        }
        backendConversationGets++;
        const match = /four-conv-(\d+)$/.exec(url);
        assert.ok(match, 'Only the exact canonical conversation URL may be queried');
        const i = Number(match![1]);
        assert.ok(i >= 0 && i < 4);
        const conversationId = 'four-conv-' + i;
        const prompt = 'Four isolated exact background prompt ' + i;
        if (i === 2 && !injected429) {
          injected429 = true;
          return { status: 429, headers: { 'retry-after': '10' }, body: null };
        }
        return { status: 200, headers: {}, body: {
          id: conversationId, current_node: 'four-assistant-node-' + i,
          mapping: {
            ['four-parent-' + i]: {
              id: 'four-parent-' + i, parent: null, children: [], message: null,
            },
            ['four-user-node-' + i]: {
              id: 'four-user-node-' + i, parent: 'four-parent-' + i, children: [],
              message: { id: 'four-user-' + i, turn_id: 'four-turn-' + i,
                author: { role: 'user' }, content: { parts: [prompt] } },
            },
            ['four-assistant-node-' + i]: {
              id: 'four-assistant-node-' + i, parent: 'four-user-node-' + i, children: [],
              message: { id: 'four-answer-' + i,
                author: { role: 'assistant' }, channel: 'final',
                status: 'finished_successfully', end_turn: true,
                content: { parts: ['Four isolated exact background answer ' + i] },
                metadata: {} },
            },
          },
        } };
      },
    };
    runtime = createSemanticCoreRuntime({
      database: core.database, browserOwner: owner,
      pageRegistry: core.pageRegistry, teamDirectory: core.teamDirectory,
      actorScheduler: core.actorScheduler, pageMutationMutex: core.pageMutationMutex,
      enabledProviders: ['chatgpt'], chatgptUrl: 'https://chatgpt.com',
      backendClientProvider: () => backend,
      backendRecovery: new ChatGptBackendRecovery({
        requestTimeoutMs: 1000, tokenCacheTtlMs: 60_000,
        now: () => new Date(virtualNow),
      }),
      continuationNow: () => new Date(virtualNow),
    });

    const clientId = 'four-independent-full-l2';
    const cases = [];
    for (let i = 0; i < 4; i++) {
      const project = await callRpc<any>({
        socketPath: config.socketPath, method: 'project.open',
        params: {
          clientId, requestId: 'open-full-' + i,
          projectKey: 'separate-full-l2-' + i,
          displayName: 'Separate full L2 project ' + i,
          provider: 'chatgpt', surfaceIntent: 'chat', modelIntent: 'Pro',
        },
      });
      const task = await callRpc<any>({
        socketPath: config.socketPath, method: 'task.start',
        params: { clientId, requestId: 'start-full-' + i,
          projectId: project.projectId,
          expectedConversationRevision: project.conversationRevision,
          prompt: 'Four isolated exact background prompt ' + i,
        },
      });
      cases.push({ i, projectId: project.projectId, taskId: task.taskId });
    }

    // The Core processes a bounded number of due reads per turn; advance
    // only the synthetic backend clock for these controlled fixtures.
    let completed = false;
    for (let scan = 0; scan < 70; scan++) {
      virtualNow += 5_001;
      await runtime.managedContinuation.tick();
      completed = cases.every(({ taskId }) =>
        core.semanticTaskRepository.getTask(taskId, clientId).state === 'completed');
      if (completed) break;
    }
    assert.equal(completed, true,
      'All four independent Task journals must reach a canonical exact FINAL');
    assert.equal(capturedPosts.length, 4, 'One original POST per project; never replay');
    const received = capturedPosts.map(post => {
      const body = post as {
        parent_message_id: string;
        messages: Array<{ id: string; content: { parts: string[] } }>;
      };
      return { id: body.messages[0]!.id, prompt: body.messages[0]!.content.parts[0],
        parent: body.parent_message_id };
    });
    for (const { i, projectId, taskId } of cases) {
      assert.deepEqual(received.filter(post => post.id === 'four-user-' + i), [{
        id: 'four-user-' + i,
        prompt: 'Four isolated exact background prompt ' + i,
        parent: 'four-parent-' + i,
      }]);
      const result = await callRpc<any>({
        socketPath: config.socketPath, method: 'task.get',
        params: { clientId, taskId, view: 'result' },
      });
      const evidence = await callRpc<any>({
        socketPath: config.socketPath, method: 'task.get',
        params: { clientId, taskId, view: 'evidence' },
      });
      assert.equal(result.projectId, projectId);
      assert.equal(result.state, 'completed');
      assert.equal(result.result.answerText, 'Four isolated exact background answer ' + i);
      assert.equal(result.result.externalTurnId, 'four-turn-' + i);
      assert.equal(evidence.evidence.attempts.length, 1);
      assert.equal(evidence.evidence.attempts[0].state, 'acknowledged');
      assert.equal(evidence.evidence.conversation.providerConversationId, 'four-conv-' + i);
      assert.equal(evidence.evidence.rootPost.canonicalConversationId, 'four-conv-' + i);
      assert.equal(evidence.evidence.rootPost.observationCount, 1);
      assert.equal(evidence.evidence.rootPost.ambiguous, false);
    }
    assert.equal(nativeFocusCalls, 0);
    assert.equal(injected429, true,
      'One project must encounter a real classifier 429 in the fixture');
    assert.ok(backendConversationGets > 4);
    const bindings = cases.map(({ projectId }) =>
      core.pageRegistry.getBinding(
        core.teamDirectory.getCurrentSession(projectId, 'main').pageKey!));
    assert.equal(new Set(bindings.map(binding => binding.targetId)).size, 4);
    assert.equal(new Set(bindings.map(binding => binding.pageKey)).size, 4);
    console.log('FOUR_PROJECT_CANONICAL_L2 ' + JSON.stringify({
      projects: 4, originalPosts: capturedPosts.length,
      uniqueCanonicalConversations: 4, exactFinals: 4, focusCalls: nativeFocusCalls,
      injectedRead429RecoveredWithoutResend: injected429,
    }));
  } finally {
    await runtime?.managedContinuation.close();
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
