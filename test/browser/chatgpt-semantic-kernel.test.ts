import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import type { OwnedPageIdentity } from '../../src/browser/owned-page-lifecycle.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';
import { DurableTaskKernel } from '../../src/core/durable-task-kernel.ts';
import { SemanticExactTaskPort } from '../../src/core/semantic-exact-task-port.ts';
import type { ExactSendIntent, ExactTurnQuery } from '../../src/core/durable-task-kernel.ts';
import { ChatGptSemanticAdapter } from '../../src/providers/chatgpt/semantic-adapter.ts';
import { ChatGptBackendRecovery, type BackendJsonClient } from '../../src/providers/chatgpt/backend-recovery.ts';
import type {
  SemanticDispatchEvidence, SemanticTaskContext,
} from '../../src/providers/semantic-adapter.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { TaskKernelRepository } from '../../src/storage/task-kernel-repository.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test('disposable Chromium ChatGPT POST persists in Core journal and recovers on restart without a page', {
  timeout: 90_000,
}, async t => {
  const folder = mkdtempSync(join(tmpdir(), 'sessionplane-chatgpt-kernel-'));
  const dbPath = join(folder, 'core.sqlite');
  const browserRegistry = new PageRegistry();
  const owner = new BrowserOwner({
    profileDir: join(folder, 'browser-profile'), pageRegistry: browserRegistry, headless: true,
  });
  let database = SessionPlaneDatabase.open(dbPath);
  let repository = new TaskKernelRepository(database);
  t.after(async () => {
    await owner.close();
    database.close();
    rmSync(folder, { recursive: true, force: true });
  });
  repository.openProject({ projectId: 'project-b', projectKey: 'fixture.b',
    displayName: 'B Browser', clientId: 'alice' });
  repository.openSlot({ projectId: 'project-b', clientId: 'alice',
    slotId: 'main', roleKey: 'Main', providerKey: 'chatgpt' });
  repository.startTask({ taskId: 'task-b', projectId: 'project-b', clientId: 'alice',
    slotId: 'main', expectedSlotRevision: 1, requestId: 'request-b',
    prompt: 'Exact B prompt' });
  repository.observeConversation({ projectId: 'project-b', clientId: 'alice',
    slotId: 'main', expectedRevision: 1, taskId: 'task-b', providerConversationId: 'conv-b' });
  repository.planAttempt({ taskId: 'task-b', clientId: 'alice',
    attemptId: 'attempt-b', kind: 'initial', turnKey: 'root', content: 'Exact B prompt' });

  await owner.start();
  const created = await owner.createPage();
  const page = created.page;
  await page.route('https://chatgpt.com/**', route => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 202, contentType: 'application/json', body: '{}' });
    }
    return route.fulfill({ contentType: 'text/html', body:
      '<main><div id="prompt-textarea" role="textbox" contenteditable="true"></div>' +
      '<button data-testid="send-button">Send</button></main><script>' +
      'window.sends=0;document.querySelector("button").onclick=()=>{' +
      'const editor=document.querySelector("#prompt-textarea");const text=editor.innerText;' +
      'window.sends++;fetch("/backend-api/f/conversation",{method:"POST",' +
      'headers:{"Content-Type":"application/json"},body:JSON.stringify({' +
      'action:"next",conversation_id:"conv-b",parent_message_id:"root",' +
      'messages:[{id:"user-b",author:{role:"user"},content:{content_type:"text",parts:[text]}}]' +
      '})});editor.textContent="";};</script>',
    });
  });
  await page.goto('https://chatgpt.com/c/conv-b');
  browserRegistry.reservePage(created.binding.pageKey, {
    sessionId: 'fixture-b', generation: 1, conversationId: 'conv-b',
  });
  const binding = browserRegistry.getBinding(created.binding.pageKey);
  const lease: OwnedPageIdentity = {
    projectId: 'project-b', slotId: 'main', slotRevision: 1, taskId: 'task-b',
    pageKey: binding.pageKey, targetId: binding.targetId!, bindingEpoch: binding.bindingEpoch,
  };
  const payload = {
    id: 'conv-b', current_node: 'assistant-node', mapping: {
      root: { id: 'root', parent: null, children: [], message: null },
      'user-node': { id: 'user-node', parent: 'root', children: [], message: {
        id: 'user-b', turn_id: 'turn-b', author: { role: 'user' },
        content: { parts: ['Exact B prompt'] },
      } },
      'assistant-node': { id: 'assistant-node', parent: 'user-node', children: [], message: {
        id: 'assistant-b', author: { role: 'assistant' }, channel: 'final',
        status: 'finished_successfully', end_turn: true,
        content: { parts: ['Exact B final'] }, metadata: {},
      } },
    },
  };
  let backendReady = false;
  let backendReads = 0;
  const client: BackendJsonClient = {
    async get(url) {
      backendReads++;
      if (url.endsWith('/api/auth/session')) {
        return { status: 200, headers: {}, body: { accessToken: 'fixture-only' } };
      }
      return backendReady
        ? { status: 200, headers: {}, body: payload }
        : { status: 404, headers: {}, body: null };
    },
  };
  const journal = {
    record(intent: ExactSendIntent, evidence: SemanticDispatchEvidence) {
      repository.recordDispatchEvidence({ taskId: intent.taskId, clientId: intent.clientId,
        attemptId: intent.attemptId, evidence });
    },
    read(query: ExactTurnQuery) {
      return repository.getDispatchEvidence({ taskId: query.taskId, clientId: query.clientId,
        attemptId: query.attemptId });
    },
  };
  let pageLease: OwnedPageIdentity | null = lease;
  const resolveContext = (intent: ExactSendIntent): SemanticTaskContext => ({
    projectId: intent.projectId, slotId: intent.slotId, slotRevision: intent.slotRevision,
    taskId: intent.taskId, providerConversationId: intent.providerConversationId,
    submittedUserMessageId: null, submittedUserTurnId: null, pageLease,
  });
  const adapter = new ChatGptSemanticAdapter({
    isExactLease: input => pageLease === input &&
      browserRegistry.getBinding(input.pageKey).bindingEpoch === input.bindingEpoch,
    resolvePage: identity => browserRegistry.pageForObservation(identity.pageKey, identity.bindingEpoch),
    isAuthorizedAttempt: input => repository.getFullTask(input.context.taskId, 'alice')
      .attempts.some(attempt => attempt.attemptId === input.attemptId && attempt.state === 'dispatched'),
    onDispatchObserved: input => repository.recordDispatchEvidence({
      taskId: input.context.taskId, clientId: 'alice',
      attemptId: input.attemptId, evidence: input.evidence,
    }),
    backendClient: client, backendOrigin: 'https://chatgpt.com',
  });
  const corePort = () => new SemanticExactTaskPort({
    adapter, resolveContext, dispatchJournal: journal,
  });
  let kernel = new DurableTaskKernel(repository, [corePort()]);
  const dispatched = await kernel.dispatch('task-b', 'alice', 'attempt-b');
  assert.equal(dispatched.state, 'uncertain', '404 canonical read is not an ACK');
  assert.equal(await page.evaluate(() => (window as any).sends), 1);
  const persisted = repository.getDispatchEvidence({ taskId: 'task-b',
    clientId: 'alice', attemptId: 'attempt-b' });
  assert.equal(persisted?.messageId, 'user-b');
  assert.equal(persisted?.parentMessageId, 'root');
  assert.equal(persisted?.textHash, digest('Exact B prompt'));
  assert.ok(backendReads >= 1);

  // Destroy the provider page before recovery: only Core SQLite and the
  // authenticated exact backend reader may supply the ACK/FINAL thereafter.
  pageLease = null;
  await page.close();
  database.close();
  database = SessionPlaneDatabase.open(dbPath);
  repository = new TaskKernelRepository(database);
  let virtualNowMs = Date.parse('2026-11-08T10:00:00.000Z');
  const noPageAdapter = new ChatGptSemanticAdapter({
    backendRecovery: new ChatGptBackendRecovery({
      requestTimeoutMs: 500, tokenCacheTtlMs: 10_000,
      now: () => new Date(virtualNowMs),
    }),
    isExactLease: () => false,
    resolvePage: () => { throw new Error('No page after restart'); },
    backendClient: client, backendOrigin: 'https://chatgpt.com',
  });
  backendReady = true;
  kernel = new DurableTaskKernel(repository, [new SemanticExactTaskPort({
    adapter: noPageAdapter, resolveContext, dispatchJournal: journal,
  })]);
  const recovered = await kernel.recoverAck('task-b', 'alice', 'attempt-b');
  assert.equal(recovered.state, 'working');
  const paced = await kernel.observeFinal({ taskId: 'task-b', clientId: 'alice',
    attemptId: 'attempt-b', resultId: 'result-b', completeTask: true });
  assert.equal(paced, null, 'same-conversation canonical reads obey backend recovery pacing');
  virtualNowMs += 5_001;
  const final = await kernel.observeFinal({ taskId: 'task-b', clientId: 'alice',
    attemptId: 'attempt-b', resultId: 'result-b', completeTask: true });
  assert.equal(final?.answerText, 'Exact B final');
  assert.equal(repository.getTask('task-b', 'alice').state, 'completed');
  assert.equal(repository.getFullTask('task-b', 'alice').attempts.length, 1);
  assert.equal(repository.getDispatchEvidence({ taskId: 'task-b',
    clientId: 'alice', attemptId: 'attempt-b' })?.messageId, 'user-b');
});
