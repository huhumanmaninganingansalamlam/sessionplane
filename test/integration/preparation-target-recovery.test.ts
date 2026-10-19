import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PageRegistryError } from '../../src/browser/page-registry.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';

test('explicit completed display and deferred preparation preserve exact ownership, drafts and one submission', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-deferred-binding-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Original completed answer';
  const start = () => startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let service = await start();
  const firstOwner = service.browserOwner!;
  const closeFirst = firstOwner.close.bind(firstOwner);
  const rpc = <T = any>(method: string, params: Record<string, unknown>) => callRpc<T>({ socketPath: config.socketPath, method, params });
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'deferred-owner' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    let { page, binding } = await service.browserOwner!.createPage();
    let routed = 0;
    await page.route('https://chatgpt.com/**', route => {
      routed++;
      return route.fulfill({ contentType: 'text/html', body: '<main><textarea id="prompt-textarea"></textarea><button>Send</button></main>' });
    });
    await page.goto(`https://chatgpt.com/c/conversation-${session.sessionId}`);
    const open = fake.openSubmission.bind(fake);
    const opened = t.mock.method(fake, 'openSubmission', async request => {
      if (request.generation === 2) throw new SessionPlaneDomainError('provider.preparation-required', 'Deferred before page reservation');
      const submission = await open(request);
      return { ...submission, pageKey: binding.pageKey, bindAcknowledgement() {
        service.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId, generation: 1,
          conversationId: `conversation-${session.sessionId}` });
      } };
    });
    await rpc('session.send', { clientId: 'deferred-owner', requestId: 'first', sessionId: session.sessionId, prompt: 'First' });
    await rpc('session.wait', { clientId: 'deferred-owner', sessionId: session.sessionId, generation: 1, waitMs: 2000 });
    assert.equal(service.teamDirectory.getSession(session.sessionId).terminal, true);
    const first = service.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=?').get(session.sessionId)!;
    const latest = (requestId: string) => invokeMcpTool({ name: 'sessionplane_decide',
      arguments: { teamId: team.teamId, requestRef: first.outbox_id, requestId, decision: 'latest' },
      socketPath: config.socketPath, timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes });
    const browserPid = firstOwner.status.browserPid;
    const firstRegistry = service.pageRegistry;
    firstOwner.close = async () => firstRegistry.detach();
    await service.close();
    const lockPath = path.join(firstOwner.status.profileDir, '.sessionplane-profile.lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    writeFileSync(lockPath, JSON.stringify({ ...lock, pid: 99_999_999 }));
    service = await start();
    assert.equal(service.browserOwner!.status.browserPid, browserPid);
    await page.setContent('<main><article data-message-author-role="assistant" data-message-id="old">Selected old answer</article><textarea></textarea><button aria-label="맨 아래로 스크롤">↓</button></main>');
    await page.evaluate(() => {
      document.querySelector('button')!.onclick = () => {
        const button = document.querySelector('button')!;
        button.dataset.clicks = String(Number(button.dataset.clicks ?? 0) + 1);
        document.querySelector('article')!.outerHTML = '<article data-message-author-role="assistant" data-message-id="chatgpt-auto-final-1"><div class="markdown">Original completed answer</div><a download="original.md" href="data:text/plain,EXACT-ORIGINAL">Original file</a></article>';
      };
      const range = document.createRange(); range.selectNodeContents(document.querySelector('article')!);
      const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    });
    assert.equal((await latest('selected')).structuredContent.displayOutcome, 'not-dispatched');
    binding = service.pageRegistry.getBinding(service.teamDirectory.getSession(session.sessionId).pageKey!);
    page = service.pageRegistry.pageForObservation(binding.pageKey);
    assert.equal(await page.evaluate(() => document.getSelection()!.toString()), 'Selected old answer');
    await page.evaluate(() => document.getSelection()!.removeAllRanges());
    await page.locator('textarea').fill('Unsent user draft');
    assert.equal((await latest('draft')).structuredContent.displayOutcome, 'not-dispatched');
    assert.equal(await page.locator('textarea').inputValue(), 'Unsent user draft');
    await page.locator('textarea').fill('');
    const displayed = await latest('original-latest');
    assert.equal(displayed.isError, false, JSON.stringify(displayed));
    assert.equal(displayed.structuredContent.displayOutcome, 'clicked');
    assert.equal(displayed.structuredContent.responseMounted, true);
    assert.deepEqual((await latest('original-latest')).structuredContent, displayed.structuredContent);
    assert.equal(await page.locator('button').getAttribute('data-clicks'), '1');
    const real = new ChatGptAdapter({ browserOwner: service.browserOwner!, pageRegistry: service.pageRegistry,
      loginUrl: config.chatgptUrl, acknowledgementTimeoutMs: 500 });
    t.mock.method(fake, 'discoverArtifacts', request => real.discoverArtifacts(request));
    t.mock.method(fake, 'downloadArtifact', (request, candidate) => real.downloadArtifact(request, candidate));
    const files = await service.artifactService.capture({ sessionId: session.sessionId, generation: 1 });
    const artifact = (files.artifacts as Array<{ artifactId: string; sizeBytes: number; sha256: string }>)[0]!;
    assert.equal(artifact.sizeBytes, Buffer.byteLength('EXACT-ORIGINAL'));
    assert.ok(artifact.sha256);
    assert.equal(fake.submitCount, 1);
    assert.equal(routed, 1);
    await assert.rejects(rpc('session.send', { clientId: 'deferred-owner', requestId: 'pending', sessionId: session.sessionId, prompt: 'Retained pending prompt' }),
      (error: RpcClientError) => (error.data as any).errorCode === 'provider.preparation-required');
    await page.locator('textarea').fill('Independent user draft');
    assert.equal(service.teamDirectory.getSession(session.sessionId).submissionState, 'prepared');
    assert.equal(service.teamDirectory.getSession(session.sessionId).generation, 2);
    assert.equal(service.teamDirectory.getSession(session.sessionId).promptSubmitted, false);
    assert.equal(service.pageRegistry.getBinding(binding.pageKey).generation, 1);
    assert.equal((await latest('old-generation')).structuredContent.errorCode, 'session.generation-superseded');
    const caller = { clientId: 'deferred-owner', requestId: 'pending', sessionId: session.sessionId, generation: 2 };
    const evidence = await rpc('session.preparation.inspect', caller);
    assert.equal(evidence.pageKey, binding.pageKey);
    assert.equal(service.pageRegistry.getBinding(binding.pageKey).generation, 2);
    assert.equal(await page.locator('textarea').inputValue(), 'Independent user draft');
    assert.equal(service.teamDirectory.getSession(session.sessionId).promptSubmitted, false);
    assert.equal(fake.submitCount, 1);
    assert.equal(opened.mock.callCount(), 2);
    assert.equal(routed, 1);
    service.pageRegistry.unbindPage(binding.pageKey);
    service.pageRegistry.reservePage(binding.pageKey, { sessionId: 'another-owner', generation: 1,
      conversationId: `conversation-${session.sessionId}` });
    await assert.rejects(rpc('session.preparation.inspect', caller),
      (error: RpcClientError) => (error.data as any).errorCode === 'session.page-identity-unverified');
    assert.equal(fake.submitCount, 1);
    assert.equal(service.database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()!.count, 2);
  } finally { await service.close(); await closeFirst(); rmSync(root, { recursive: true, force: true }); }
});

test('core restart reconnects prepared request to its exact live target, not an identical draft', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-prepared-target-'));
  const config = { ...resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), chatgptUrl: 'https://chatgpt.com/' };
  const start = () => startCore({ config, browserHeadless: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let service = await start();
  const firstOwner = service.browserOwner!;
  const closeFirst = firstOwner.close.bind(firstOwner);
  const createPage = firstOwner.createPage.bind(firstOwner);
  firstOwner.createPage = async () => {
    const created = await createPage();
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<form onsubmit="event.preventDefault()"><textarea id="prompt-textarea"></textarea><button type="submit">Send</button></form><button type="button" aria-label="Model selection" aria-haspopup="menu" aria-expanded="true" aria-controls="fixture-menu">Model</button><div id="fixture-menu" role="menu"><div role="menuitem" aria-label="Model selection">Fixture model</div><div role="menuitemradio" aria-checked="true">Fixture model</div></div>',
    }));
    return created;
  };
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({
    name: 'sessionplane_' + name, arguments: args, socketPath: config.socketPath,
    timeoutMs: 30_000, maxLineBytes: config.rpcMaxLineBytes,
  });
  try {
    const team = (await invoke('team_create', { requestId: 'target-team' })).structuredContent;
    const role = (team.roles as Array<{ roleRef: string }>)[0]!;
    const pending = await invoke('send', { teamId: team.teamId, roleRef: role.roleRef, requestId: 'target-send', prompt: 'Exact pending draft' });
    assert.equal(pending.isError, false, JSON.stringify(pending));
    const identity = { teamId: team.teamId, requestRef: pending.structuredContent.requestRef };
    const inspect = async () => {
      const response = await invoke('team_get', identity);
      assert.equal(response.isError, false, JSON.stringify(response));
      return response.structuredContent.request as Record<string, any>;
    };
    const request = await inspect();
    const evidence = request.evidence;
    const composer = evidence.nodes.find((node: any) => node.editable && node.role === 'textbox');
    const choice = await invoke('decide', { ...identity, requestId: 'target-composer', decision: 'choose', purpose: 'composer', snapshotId: evidence.snapshotId, ref: composer.ref });
    assert.equal(choice.isError, false, JSON.stringify(choice));
    const before = await inspect();
    const binding = service.pageRegistry.getBinding(before.pageKey);
    assert.ok(binding.targetId);
    assert.equal(service.pageBindings.get(before.pageKey)?.targetId, binding.targetId);
    const original = service.pageRegistry.pageForObservation(before.pageKey);
    const draft = await original.locator('textarea').inputValue();
    assert.ok(draft.includes('Exact pending draft'));
    const decoy = await firstOwner.createPage();
    await decoy.page.goto('https://chatgpt.com/');
    await decoy.page.locator('textarea').fill(draft);
    const pageCount = service.pageRegistry.listBindings({ includeClosed: false }).length;
    const browserPid = firstOwner.status.browserPid;
    const firstRegistry = service.pageRegistry;
    firstOwner.close = async () => firstRegistry.detach();
    await service.close();
    const lockPath = path.join(firstOwner.status.profileDir, '.sessionplane-profile.lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    writeFileSync(lockPath, JSON.stringify({ ...lock, pid: 99_999_999 }));
    service = await start();
    assert.equal(service.browserOwner!.status.browserPid, browserPid);
    const after = await inspect();
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.generation, before.generation);
    assert.equal(after.promptSubmitted, false);
    assert.equal(after.submissionState, 'prepared');
    assert.equal(after.conversationId, null);
    assert.notEqual(after.pageKey, before.pageKey);
    assert.equal(service.pageRegistry.getBinding(after.pageKey).targetId, binding.targetId);
    assert.equal(service.pageRegistry.listBindings({ includeClosed: false }).length, pageCount);
    assert.equal(await service.pageRegistry.pageForObservation(after.pageKey).locator('textarea').inputValue(), draft);
    assert.equal(service.pageRegistry.listBindings({ includeClosed: false }).find(item => item.targetId === decoy.binding.targetId)?.sessionId, null);
    // A reboot can retain a prepared page key without a live registry entry.
    const storedBefore = service.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(after.sessionId);
    service.pageRegistry.detach();
    t.mock.method(service.pageRegistry, 'refreshPage', () => {
      throw new PageRegistryError('browser.unavailable', `Unknown pageKey: ${after.pageKey}`);
    });
    const missing = await inspect();
    assert.equal(missing.inspectionError.errorCode, 'browser.unavailable');
    assert.equal(missing.evidence, null);
    assert.equal(missing.submissionState, 'prepared');
    assert.equal(missing.promptSubmitted, false);
    assert.equal(missing.generation, after.generation);
    assert.equal(missing.requestRef, after.requestRef);
    assert.deepEqual(service.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(after.sessionId), storedBefore);
    assert.equal(service.pageRegistry.listBindings({ includeClosed: false }).length, 0);

    assert.equal(service.database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()!.count, 1);
  } finally {
    await service.close();
    await closeFirst();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart retains an ambiguous submission on its exact home target without accepting or resending it', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-unknown-target-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.acknowledgementMode = 'missing';
  const start = () => startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let service = await start();
  const firstOwner = service.browserOwner!;
  const closeFirst = firstOwner.close.bind(firstOwner);
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'unknown-target' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const original = await firstOwner.createPage();
    await original.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: '<textarea>Keep the human draft</textarea>' }));
    await original.page.goto('https://chatgpt.com/');
    const decoy = await firstOwner.createPage();
    await decoy.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: '<textarea>Keep the human draft</textarea>' }));
    await decoy.page.goto('https://chatgpt.com/');
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => {
      const submission = await open(request);
      service.pageRegistry.reservePage(original.binding.pageKey, { sessionId: session.sessionId, generation: request.generation });
      return { ...submission, pageKey: original.binding.pageKey };
    });
    await assert.rejects(callRpc({ socketPath: config.socketPath, method: 'session.send', params: {
      clientId: 'unknown-target', requestId: 'send', sessionId: session.sessionId, prompt: 'Original review',
    } }), (error: RpcClientError) => (error.data as any).errorCode === 'session.submission-unknown');
    const before = service.teamDirectory.getSession(session.sessionId);
    assert.equal(before.conversationId, null);
    const oldRegistry = service.pageRegistry;
    firstOwner.close = async () => oldRegistry.detach();
    await service.close();
    const lockPath = path.join(firstOwner.status.profileDir, '.sessionplane-profile.lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    writeFileSync(lockPath, JSON.stringify({ ...lock, pid: 99_999_999 }));
    service = await start();
    const after = service.teamDirectory.getSession(session.sessionId);
    assert.equal(after.submissionState, 'submission_unknown');
    assert.equal(after.terminal, false);
    assert.equal(after.submittedUserMessageId, null);
    assert.equal(after.conversationId, null);
    assert.equal(after.generation, before.generation);
    assert.equal(after.reason, 'acknowledgement-missing');
    const retained = service.pageRegistry.requireSessionPage(after.pageKey!, after);
    assert.equal(service.pageRegistry.getBinding(after.pageKey!).targetId, original.binding.targetId);
    assert.equal(await retained.locator('textarea').inputValue(), 'Keep the human draft');
    assert.equal(service.pageRegistry.listBindings({ includeClosed: false }).find(b => b.targetId === decoy.binding.targetId)?.sessionId, null);
    assert.equal(fake.submitCount, 1);
    assert.equal(fake.openCount, 1);
    service.pageRegistry.unbindPage(after.pageKey!);
    service.pageRegistry.reservePage(after.pageKey!, { sessionId: 'different-owner', generation: 1 });
    await service.recoveryService.restore();
    assert.equal(service.pageRegistry.getBinding(after.pageKey!).sessionId, 'different-owner');
    // Losing the exact target must not adopt the indistinguishable home tab.
    await retained.close();
    await service.recoveryService.restore();
    assert.equal(service.pageRegistry.listBindings({ includeClosed: false }).find(b => b.targetId === decoy.binding.targetId)?.sessionId, null);
    assert.equal(service.teamDirectory.getSession(session.sessionId).submissionState, 'submission_unknown');
    assert.equal(fake.submitCount, 1);
  } finally { await service.close(); await closeFirst(); rmSync(root, { recursive: true, force: true }); }
});

test('explicit duplicate recovery retains the exact unsubmitted request and closes only proven idle copies', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-duplicate-preparation-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Original completed answer\n일반 텍스트\nExact code';
  const service = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = <T = any>(method: string, params: Record<string, unknown>) => callRpc<T>({ socketPath: config.socketPath, method, params });
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: 'sessionplane_' + name,
    arguments: args, socketPath: config.socketPath, timeoutMs: 30_000, maxLineBytes: config.rpcMaxLineBytes });
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'duplicate-owner' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await rpc('session.send', { clientId: 'duplicate-owner', requestId: 'original', sessionId: session.sessionId, prompt: 'Original completed work' });
    await rpc('session.wait', { clientId: 'duplicate-owner', sessionId: session.sessionId, generation: 1, waitMs: 2000 });
    const original = service.teamDirectory.getSession(session.sessionId);
    const body = `<main><article data-message-author-role="user" data-message-id="${original.submittedUserMessageId}">Original completed work</article><article data-message-author-role="assistant" data-message-id="${original.responseMessageId}"><div class="markdown">Original completed answer
<div data-code-block><div data-markdown-copy="exclude">Plain text</div><pre>Exact code</pre></div></div></article><textarea id="prompt-textarea"></textarea></main>`;
    const pages = [];
    for (let i = 0; i < 2; i++) {
      const target = await service.browserOwner!.createPage();
      await target.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body }));
      await target.page.goto(`https://chatgpt.com/c/${original.conversationId}`);
      pages.push(target);
      if (i === 0) {
        service.pageRegistry.bindPage(target.binding.pageKey, { sessionId: session.sessionId, generation: 1, conversationId: original.conversationId! });
        await service.actorScheduler.updateGeneration(session.sessionId, 1, { pageKey: target.binding.pageKey });
      }
    }
    const { ProviderSubmissionError } = await import('../../src/providers/provider-adapter.ts');
    t.mock.method(fake, 'openSubmission', async () => { throw new ProviderSubmissionError('session.page-identity-unverified', 'Duplicate conversation conflict'); });
    await assert.rejects(rpc('session.send', { clientId: 'duplicate-owner', requestId: 'unsubmitted', sessionId: session.sessionId, prompt: 'Exact preserved follow-up draft' }));
    const failed = service.teamDirectory.getSession(session.sessionId);
    assert.equal(failed.submissionState, 'failed_pre_submit');
    const request = service.database.raw.prepare('SELECT outbox_id,payload_json,request_hash FROM outbox WHERE session_id=? AND generation=2').get(session.sessionId)!;
    const identity = { teamId: team.teamId, requestRef: request.outbox_id };
    const refresh = (requestId: string) => invoke('decide', { ...identity, requestId, decision: 'refresh' });
    const second = pages[1]!.page;
    await second.locator('textarea').fill('Unsent human draft');
    assert.equal((await refresh('draft')).isError, true);
    assert.equal(await second.locator('textarea').inputValue(), 'Unsent human draft');
    assert.ok(pages.every(target => !target.page.isClosed()));
    await second.locator('textarea').fill('');
    await second.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend', '<button aria-label="Stop">Stop</button>'));
    assert.equal((await refresh('active')).isError, true);
    assert.ok(pages.every(target => !target.page.isClosed()));
    await second.locator('button').evaluate(element => element.remove());
    await second.locator('[data-message-author-role="assistant"]').evaluate(element => element.setAttribute('data-message-id', 'different-answer'));
    assert.equal((await refresh('different-answer')).isError, true);
    assert.ok(pages.every(target => !target.page.isClosed()));
    await second.locator('[data-message-author-role="assistant"]').evaluate((element, id) => element.setAttribute('data-message-id', id!), original.responseMessageId);
    const restored = await refresh('verified-idle-copies');
    assert.equal(restored.isError, false, JSON.stringify(restored));
    const after = service.teamDirectory.getSession(session.sessionId);
    assert.equal(after.generation, 2);
    assert.equal(after.submissionState, 'prepared');
    assert.equal(after.promptSubmitted, false);
    assert.equal(fake.submitCount, 1);
    assert.equal(pages.filter(target => target.page.isClosed()).length, 1);
    assert.equal(service.pageRegistry.findByConversation(original.conversationId!).length, 1);
    const stored = service.database.raw.prepare('SELECT outbox_id,payload_json,request_hash FROM outbox WHERE session_id=? AND generation=2').get(session.sessionId);
    assert.deepEqual(stored, request);
    assert.equal(service.teamDirectory.getSession(session.sessionId).submittedUserMessageId, null);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
