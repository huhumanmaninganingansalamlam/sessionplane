import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('deferred preparation inspects its same-owned predecessor page without sending or borrowing another owner', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-deferred-binding-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Original completed answer';
  const service = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = <T = any>(method: string, params: Record<string, unknown>) => callRpc<T>({ socketPath: config.socketPath, method, params });
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'deferred-owner' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const { page, binding } = await service.browserOwner!.createPage();
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
    await assert.rejects(rpc('session.send', { clientId: 'deferred-owner', requestId: 'pending', sessionId: session.sessionId, prompt: 'Retained pending prompt' }),
      (error: RpcClientError) => (error.data as any).errorCode === 'provider.preparation-required');
    await page.locator('textarea').fill('Independent user draft');
    assert.equal(service.teamDirectory.getSession(session.sessionId).submissionState, 'prepared');
    assert.equal(service.teamDirectory.getSession(session.sessionId).generation, 2);
    assert.equal(service.teamDirectory.getSession(session.sessionId).promptSubmitted, false);
    assert.equal(service.pageRegistry.getBinding(binding.pageKey).generation, 1);
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
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('core restart reconnects prepared request to its exact live target, not an identical draft', async () => {
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
    assert.equal(service.database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()!.count, 1);
  } finally {
    await service.close();
    await closeFirst();
    rmSync(root, { recursive: true, force: true });
  }
});
