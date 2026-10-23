import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('explicit focus shows the unique retained UNKNOWN target without accepting it or touching its draft', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-focus-unknown-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.acknowledgementMode = 'missing';
  const service = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const target = await service.browserOwner!.createPage();
    let loads = 0, activations = 0;
    await target.page.route('https://chatgpt.com/**', route => {
      loads++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main><textarea>Human draft</textarea><button aria-label="중지">Stop</button></main>' });
    });
    const open = fake.openSubmission.bind(fake);
    fake.openSubmission = async request => {
      const submission = await open(request);
      service.pageRegistry.reservePage(target.binding.pageKey, {
        sessionId: request.session.sessionId, generation: request.generation, conversationId: null });
      await target.page.goto('https://chatgpt.com/c/discovered-conversation');
      return { ...submission, pageKey: target.binding.pageKey };
    };
    const team = service.teamDirectory.createTeam({ clientId: 'focus-unknown' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: team.primaryRoleKey, provider: 'chatgpt' });
    await assert.rejects(service.submissionService.send({ clientId: 'team:' + team.teamId,
      requestId: 'unknown-plan', sessionId: session.sessionId, prompt: 'Original plan', sessionDeadlineSec: 600 }), /acknowledgement/);
    const original = service.teamDirectory.getSession(session.sessionId);
    assert.equal(original.submissionState, 'submission_unknown');
    const activate = target.page.bringToFront.bind(target.page);
    target.page.bringToFront = async () => { activations++; await activate(); };
    const requestRef = service.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=?').get(session.sessionId)!.outbox_id;
    const inspected = await invokeMcpTool({ name: 'sessionplane_team_get', socketPath: config.socketPath,
      timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes, arguments: { teamId: team.teamId, requestRef, view: 'evidence' } });
    const evidence = (inspected.structuredContent.request as { evidence: { conversationRecovery: { activityReason: string } } }).evidence;
    assert.equal(evidence.conversationRecovery.activityReason, 'unverified-stop-control');
    assert.equal(activations, 0, 'Read-only inspection does not focus the target');
    const result = await invokeMcpTool({ name: 'sessionplane_decide', socketPath: config.socketPath,
      timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes,
      arguments: { teamId: team.teamId, requestRef, requestId: 'show-unknown', decision: 'focus' } });
    assert.equal(result.isError, false, JSON.stringify(result));
    const focused = result.structuredContent;
    assert.equal(focused.pageKey, target.binding.pageKey);
    assert.equal(focused.url, 'https://chatgpt.com/c/discovered-conversation');
    assert.equal(activations, 1);
    assert.equal(loads, 1);
    assert.equal(await target.page.locator('textarea').inputValue(), 'Human draft');
    assert.deepEqual(service.teamDirectory.getSession(session.sessionId), original);
    assert.equal(service.pageRegistry.getBinding(target.binding.pageKey).state, 'identity_lost');
    assert.equal(fake.submitCount, 1);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('explicit focus activates only the exact live request tab without reloading or resubmitting', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-focus-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const service = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const originalSubmission = fake.openSubmission.bind(fake);
  fake.openSubmission = async request => {
    const submission = await originalSubmission(request);
    const created = await service.browserOwner!.createPage();
    const conversationId = `conversation-${request.session.sessionId}`;
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<textarea>Keep this draft</textarea><p>Exact request</p>',
    }));
    await created.page.goto('https://chatgpt.com/c/' + conversationId);
    return { ...submission, pageKey: created.binding.pageKey,
      bindAcknowledgement(ack) {
        submission.bindAcknowledgement(ack);
        service.pageRegistry.bindPage(created.binding.pageKey, { teamId: request.session.teamId,
          roleId: request.session.roleId, sessionId: request.session.sessionId,
          generation: request.generation, conversationId });
      } };
  };
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({
    name: 'sessionplane_' + name, arguments: args, socketPath: config.socketPath,
    timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes,
  });
  try {
    const team = (await invoke('team_create', { requestId: 'team' })).structuredContent;
    const roleRef = (team.roles as Array<{ roleRef: string }>)[0]!.roleRef;
    const sent = await invoke('send', { teamId: team.teamId, roleRef, requestId: 'send', prompt: 'Review' });
    assert.equal(sent.isError, false, JSON.stringify(sent));
    const identity = { teamId: team.teamId, requestRef: sent.structuredContent.requestRef };
    const sessionId = sent.structuredContent.sessionId as string;
    const before = service.teamDirectory.getSession(sessionId);
    const page = service.pageRegistry.pageForObservation(before.pageKey!);
    await page.locator('textarea').fill('Human edited draft');
    const decoy = await service.browserOwner!.createPage();
    let activations = 0;
    const bringToFront = page.bringToFront.bind(page);
    page.bringToFront = async () => { activations++; await bringToFront(); };
    decoy.page.bringToFront = async () => { assert.fail('Focused an unrelated tab'); };
    // Team grouping may create its controller tab independently of explicit focus.
    const groupsDeadline = Date.now() + 10_000;
    while (service.browserOwner!.teamGroupsBusy && Date.now() < groupsDeadline)
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(service.browserOwner!.teamGroupsBusy, false);
    const pageCount = service.pageRegistry.listBindings({ includeClosed: false }).length;
    const focus = { ...identity, requestId: 'focus-pending', decision: 'focus' };
    const focused = await invoke('decide', focus);
    assert.equal(focused.isError, false, JSON.stringify(focused));
    assert.equal(focused.structuredContent.pageKey, before.pageKey);
    assert.equal(focused.structuredContent.activated, true);
    assert.equal(activations, 1);
    assert.deepEqual((await invoke('decide', focus)).structuredContent, focused.structuredContent);
    assert.equal(activations, 1, 'Receipt replay must not steal focus again');
    assert.equal(await page.locator('textarea').inputValue(), 'Human edited draft');
    assert.equal(fake.submitCount, 1);
    assert.equal(service.pageRegistry.listBindings({ includeClosed: false }).length, pageCount);
    assert.equal(service.teamDirectory.getSession(sessionId).generation, before.generation);
    const other = (await invoke('team_create', { requestId: 'other' })).structuredContent;
    assert.equal((await invoke('decide', { ...focus, teamId: other.teamId, requestId: 'wrong-team' })).structuredContent.errorCode, 'input.invalid');
    fake.emitObservation(sessionId, { candidate: { responseMessageId: 'final', answerText: 'Done',
      terminalMarker: true, streamingMarker: false }, activity: 'none' });
    const waited = await invoke('wait', { teamId: team.teamId, requestRefs: [identity.requestRef], waitMs: 1000 });
    assert.equal(waited.isError, false, JSON.stringify(waited));
    assert.equal(service.teamDirectory.getSession(sessionId).terminal, true);
    assert.equal((await invoke('decide', { ...focus, requestId: 'focus-complete' })).isError, false);
    assert.equal(activations, 2);
    await page.goto('https://chatgpt.com/c/unrelated');
    assert.equal((await invoke('decide', { ...focus, requestId: 'wrong-page' })).structuredContent.errorCode, 'session.page-identity-unverified');
    await page.close();
    assert.equal((await invoke('decide', { ...focus, requestId: 'missing-page' })).structuredContent.errorCode, 'browser.unavailable');
    assert.equal(activations, 2);
    assert.equal(fake.submitCount, 1);
    const current = (await invoke('team_get', { teamId: team.teamId })).structuredContent;
    const next = await invoke('send', { teamId: team.teamId,
      roleRef: (current.roles as Array<{ roleRef: string }>)[0]!.roleRef,
      requestId: 'next', prompt: 'Next review' });
    assert.equal(next.isError, false, JSON.stringify(next));
    assert.equal((await invoke('decide', { ...focus, requestId: 'stale-request' })).structuredContent.errorCode, 'session.generation-superseded');
    assert.equal((await invoke('decide', { ...focus, requestRef: next.structuredContent.requestRef })).structuredContent.errorCode, 'input.idempotency-conflict');
    assert.equal(activations, 2);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
