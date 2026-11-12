import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../../src/config.ts';
import { callRpc } from '../../src/cli/client.ts';
import { createSemanticCoreRuntime } from '../../src/core/semantic-core-runtime.ts';
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
