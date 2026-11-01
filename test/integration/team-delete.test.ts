import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool, getMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import { callRpc } from '../../src/cli/client.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { ReceiptRepository, hashCanonical } from '../../src/storage/receipt-repository.ts';

test('team deletion removes only its owned state, cancels work and survives provider failure and replay', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-team-delete-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  let attempts = 0;
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const deleting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(fake, 'openDeletion', async () => ({ alreadyDeleted: false,
    deleteOnce: async () => { attempts++; entered(); await held; throw new Error('Provider rejected deletion'); },
    close: async () => {},
  }));
  const start = () => startCore({ config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let service = await start();
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({
    name: 'sessionplane_' + name, arguments: args, socketPath: config.socketPath,
    timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes,
  });
  try {
    assert.equal(getMcpTool('sessionplane_team_delete')?.annotations.destructiveHint, true);
    const team = (await invoke('team_create', { requestId: 'team' })).structuredContent;
    const other = (await invoke('team_create', { requestId: 'other' })).structuredContent;
    const roleRef = (team.roles as Array<{ roleRef: string }>)[0]!.roleRef;
    const sent = (await invoke('send', { teamId: team.teamId, roleRef, requestId: 'send', prompt: 'Work' })).structuredContent;
    const expert = (await invoke('role_create', { teamId: team.teamId, requestId: 'expert', roleKey: 'expert' })).structuredContent;
    const expertRef = (expert.roles as Array<{ roleKey: string; roleRef: string }>).find(r => r.roleKey === 'expert')!.roleRef;
    await invoke('session_replace', { teamId: team.teamId, roleRef: expertRef, requestId: 'replacement' });
    const wait = service.actorScheduler.waitSession(sent.sessionId as string, { waitMs: 5000 });
    const input = { teamId: team.teamId, requestId: 'delete' };
    const first = invoke('team_delete', input);
    await deleting;
    const replay = invoke('team_delete', input);
    assert.equal(service.teamDirectory.getTeam(team.teamId as string).roles.every(r => r.roleState === 'retired'), true);
    assert.equal((await invoke('role_create', { teamId: team.teamId, requestId: 'late-role', roleKey: 'late' })).isError, true);
    assert.equal((await invoke('send', { teamId: team.teamId, roleRef: sent.roleRef, requestId: 'late-send', prompt: 'Late' })).isError, true);
    release();
    const result = await first;
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.deleted, true);
    assert.deepEqual((await replay).structuredContent, result.structuredContent);
    assert.equal((await wait).terminal, true);
    assert.equal(attempts, 1);
    assert.equal(fake.stopCount, 1);
    assert.equal(fake.submitCount, 1);
    const cleanups = result.structuredContent.sessions as Array<{ providerError: string | null }>;
    assert.equal(cleanups.length, 3, 'Includes replaced sessions and never-used roles');
    assert.equal(cleanups.some(c => c.providerError === 'provider.deletion-unknown'), true);
    assert.equal((await invoke('team_get', { teamId: team.teamId })).isError, true);
    assert.equal((await invoke('team_get', { teamId: other.teamId })).isError, false);
    assert.deepEqual(service.teamDirectory.listTeams('sessionplane-mcp').teams.map(t => t.teamId), [other.teamId]);
    for (const table of ['teams', 'team_roles', 'sessions', 'outbox', 'events', 'team_briefs']) {
      const row = service.database.raw.prepare(`SELECT count(*) AS n FROM ${table} WHERE team_id = ?`).get(team.teamId as string) as { n: number };
      assert.equal(row.n, 0, table);
    }
    assert.deepEqual(service.database.raw.prepare('PRAGMA foreign_key_check').all(), []);
    await service.close();
    service = await start();
    assert.deepEqual((await invoke('team_delete', input)).structuredContent, result.structuredContent);
    assert.equal(attempts, 1);
    // CLI shares the same deletion service and can delete an unused team.
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
    assert.equal(await runCli(['team', 'delete', other.teamId as string, '--socket', config.socketPath,
      '--request-id', 'cli-delete', '--json'], { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    assert.equal(JSON.parse(output).deleted, true);
    assert.equal(service.teamDirectory.listTeams('sessionplane-mcp').teams.length, 0);
  } finally { release(); await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('team deletion closes owned browser tabs and leaves unrelated tabs open', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-team-tabs-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({ config, browserHeadless: true, providerAdapters: [new FakeProviderAdapter()],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'tabs' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const owned = await service.browserOwner!.createPage();
    service.pageRegistry.reservePage(owned.binding.pageKey, { sessionId: session.sessionId, generation: 0 });
    const other = await service.browserOwner!.createPage();
    service.teamDirectory.createRole({ teamId: team.teamId, roleKey: 'expert.old-tab', roleType: 'expert' });
    const old = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'expert.old-tab', provider: 'chatgpt' });
    const submitted = await callRpc<SessionSnapshot>({ socketPath: config.socketPath, method: 'session.send',
      params: { clientId: 'tabs', requestId: 'old-send', sessionId: old.sessionId, prompt: 'Fixture only' } });
    const unbound = await service.browserOwner!.createPage();
    await unbound.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Fixture</main>' }));
    await unbound.page.goto('https://chatgpt.com/c/' + submitted.conversationId);
    assert.equal(service.pageRegistry.getBinding(unbound.binding.pageKey).state, 'unbound', 'Completed tabs may be unbound after browser adoption');
    const differentProvider = await service.browserOwner!.createPage();
    await differentProvider.page.route('https://grok.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Other provider</main>' }));
    await differentProvider.page.goto('https://grok.com/c/unrelated-provider-conversation');
    const result = await invokeMcpTool({ name: 'sessionplane_team_delete', arguments: { teamId: team.teamId, requestId: 'delete' },
      socketPath: config.socketPath, timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(owned.page.isClosed(), true);
    assert.equal(other.page.isClosed(), false);
    assert.equal(unbound.page.isClosed(), true);
    const cleanup = result.structuredContent.sessions as Array<{ closedPages: number }>;
    assert.equal(cleanup.reduce((sum, session) => sum + session.closedPages, 0), 2,
      'team totals include pages closed inside session deletion and final cleanup');
    const replay = await invokeMcpTool({ name: 'sessionplane_team_delete', arguments: { teamId: team.teamId, requestId: 'delete' },
      socketPath: config.socketPath, timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes });
    assert.deepEqual(replay.structuredContent, result.structuredContent);
    assert.equal(differentProvider.page.isClosed(), false, 'Another provider is not cleanup ownership');
    assert.equal(service.pageRegistry.listBindings().some(b => b.sessionId === session.sessionId), false);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('completed team cleanup retains safe provider preparation failures independently of tab closure', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-team-provider-failure-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Retrieved original answer';
  const failures = new Map<string, { stage: string; httpStatus: number; retryAfterMs: number | null }>();
  let preparations = 0;
  t.mock.method(fake, 'openDeletion', async ({ session }) => {
    preparations++;
    throw new ProviderSubmissionError('provider.unavailable', 'Provider preparation failed', {
      details: { ...failures.get(session.sessionId), authorization: 'private-token', body: 'private-response' },
    });
  });
  const service = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const invoke = () => invokeMcpTool({ name: 'sessionplane_team_delete', arguments: {
    teamId: team.teamId, requestId: 'completed-cleanup' }, socketPath: config.socketPath,
    timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
  const team = service.teamDirectory.createTeam({ clientId: 'completed-cleanup' });
  try {
    const unrelated = await service.browserOwner!.createPage();
    await unrelated.page.setContent('<textarea>Unrelated user draft</textarea>');
    const owned = [];
    for (const [index, details] of [
      { stage: 'authentication', httpStatus: 403, retryAfterMs: null },
      { stage: 'conversation-verification', httpStatus: 429, retryAfterMs: 52000 },
    ].entries()) {
      const roleKey = index === 0 ? 'main' : 'expert';
      if (index > 0) service.teamDirectory.createRole({ teamId: team.teamId, roleKey, roleType: 'expert' });
      const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey, provider: 'chatgpt' });
      failures.set(session.sessionId, details);
      await callRpc({ socketPath: config.socketPath, method: 'session.send', params: {
        clientId: 'completed-cleanup', sessionId: session.sessionId, requestId: 'send-' + index, prompt: 'Local fixture' } });
      const final = await callRpc<SessionSnapshot>({ socketPath: config.socketPath, method: 'session.wait', params: {
        clientId: 'completed-cleanup', sessionId: session.sessionId, generation: 1, waitMs: 3000 } });
      assert.equal(final.terminal, true);
      const { page, binding } = await service.browserOwner!.createPage();
      await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea></textarea>' }));
      await page.goto('https://chatgpt.com/c/' + final.conversationId);
      service.pageRegistry.bindPage(binding.pageKey, { sessionId: session.sessionId, generation: 1, conversationId: final.conversationId! });
      owned.push(page);
    }
    const result = await invoke();
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.deleted, true);
    const cleanups = result.structuredContent.sessions as Array<{ sessionId: string; providerDeleted: boolean;
      providerError: string; providerErrorDetails: unknown; closedPages: number; pageErrors: string[] }>;
    for (const cleanup of cleanups) {
      assert.equal(cleanup.providerDeleted, false);
      assert.equal(cleanup.providerError, 'provider.unavailable');
      assert.deepEqual(cleanup.providerErrorDetails, failures.get(cleanup.sessionId));
      assert.equal(cleanup.closedPages, 1);
      assert.deepEqual(cleanup.pageErrors, []);
    }
    assert.equal(cleanups.length, 2);
    assert.equal(owned.every(page => page.isClosed()), true);
    assert.equal(await unrelated.page.locator('textarea').inputValue(), 'Unrelated user draft');
    assert.doesNotMatch(JSON.stringify(result), /private-token|private-response/);
    assert.deepEqual((await invoke()).structuredContent, result.structuredContent);
    assert.equal(preparations, 2, 'Receipt replay does not repeat provider preparation or deletion');
    assert.equal(fake.stopCount, 0, 'Completed generations require no Stop');
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an interrupted team deletion stays retired on restart and resumes without repeating provider deletion', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-team-delete-restart-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.stopControlAvailable = false;
  let attempts = 0;
  t.mock.method(fake, 'openDeletion', async () => ({ alreadyDeleted: false,
    deleteOnce: async () => { attempts++; return false; }, close: async () => {},
  }));
  const start = () => startCore({ config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let service = await start();
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({
    name: 'sessionplane_' + name, arguments: args, socketPath: config.socketPath,
    timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes,
  });
  try {
    const team = (await invoke('team_create', { requestId: 'team' })).structuredContent;
    const sent = (await invoke('send', { teamId: team.teamId,
      roleRef: (team.roles as Array<{ roleRef: string }>)[0]!.roleRef, requestId: 'send', prompt: 'Work' })).structuredContent;
    const original = service.pageRegistry.listBindings.bind(service.pageRegistry);
    const mock = t.mock.method(service.pageRegistry, 'listBindings', options => {
      // Interrupt tab cleanup after the provider attempt, not the new draft preflight.
      if (attempts > 0) throw new Error('Interrupted cleanup');
      return original(options);
    });
    const input = { teamId: team.teamId, requestId: 'delete' };
    assert.equal((await invoke('team_delete', input)).isError, true);
    mock.mock.restore();
    assert.equal(original().length, 0);
    assert.equal(attempts, 1);
    await service.close();
    service = await start();
    assert.equal(service.teamDirectory.getSession(sent.sessionId as string).sessionState, 'superseded');
    assert.equal(service.actorScheduler.actorCount, 0);
    const result = await invoke('team_delete', input);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.deleted, true);
    assert.equal(attempts, 1);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('deleted-team page-only cleanup survives lost bindings without repeating provider work', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-team-orphan-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Retrieved final';
  let preparations = 0;
  t.mock.method(fake, 'openDeletion', async () => {
    preparations++;
    throw new ProviderSubmissionError('provider.unavailable', 'Fixture provider unavailable');
  });
  const service = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const invoke = (args: Record<string, unknown>) => invokeMcpTool({ name: 'sessionplane_team_delete',
    arguments: args, socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'orphan' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await callRpc({ socketPath: config.socketPath, method: 'session.send', params: {
      clientId: 'orphan', sessionId: session.sessionId, requestId: 'send', prompt: 'Fixture only' } });
    const final = await callRpc<SessionSnapshot>({ socketPath: config.socketPath, method: 'session.wait', params: {
      clientId: 'orphan', sessionId: session.sessionId, generation: 1, waitMs: 3000 } });
    assert.equal(final.terminal, true);
    const receipts = new ReceiptRepository(service.database);
    receipts.execute({ clientId: 'team:' + team.teamId, requestId: 'native-original-ownership',
      method: 'session.stop', payload: {}, operation: () => final });
    const { page, binding } = await service.browserOwner!.createPage();
    const url = 'https://chatgpt.com/c/' + final.conversationId;
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea>Preserve obsolete draft</textarea>' }));
    await page.goto(url);
    service.pageRegistry.bindPage(binding.pageKey, { sessionId: session.sessionId, generation: 1, conversationId: final.conversationId! });
    const targetId = service.pageRegistry.getBinding(binding.pageKey).targetId!;
    assert.ok(targetId);
    const original = { teamId: team.teamId, requestId: 'delete' };
    const deleted = await invoke(original);
    assert.equal(deleted.isError, false, JSON.stringify(deleted));
    const cleanup = (deleted.structuredContent.sessions as Array<{ sessionId: string; pageErrors: string[]; retainedPages: unknown[] }>)[0]!;
    assert.deepEqual(cleanup.pageErrors, ['session.cleanup-not-ready']);
    assert.equal(page.isClosed(), false);
    assert.equal(service.pageRegistry.getBinding(binding.pageKey).sessionId, null);
    assert.equal(cleanup.retainedPages.length, 1, 'Deletion receipt retains failed exact ownership before removing the session');
    assert.equal((await invokeMcpTool({ name: 'sessionplane_team_get', arguments: { teamId: team.teamId },
      socketPath: config.socketPath, timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes })).isError, true);
    const resume = { deletionRequestId: 'delete', sessionId: session.sessionId, targetId,
      evidenceRef: 'fixture:explicit-user-obsolete-page-disposal' };
    assert.equal((await invoke({ teamId: team.teamId, requestId: 'wrong', resumePageCleanup: { ...resume, targetId: 'OTHER' } })).isError, true);
    assert.equal((await invoke({ teamId: team.teamId, requestId: 'draft', resumePageCleanup: resume })).isError, true);
    // The original target navigating elsewhere must not be closed under an old receipt.
    await page.goto('https://chatgpt.com/c/other-conversation');
    assert.equal((await invoke({ teamId: team.teamId, requestId: 'changed', resumePageCleanup: { ...resume, discardDraft: true } })).isError, true);
    await page.goto(url);
    // Another durable owner of the same conversation protects this tab.
    const other = service.teamDirectory.createTeam({ clientId: 'other' });
    const otherSession = service.teamDirectory.createSession({ teamId: other.teamId, roleKey: 'main', provider: 'chatgpt' });
    service.pageRegistry.bindPage(binding.pageKey, { sessionId: otherSession.sessionId, generation: 0, conversationId: final.conversationId! });
    assert.equal((await invoke({ teamId: team.teamId, requestId: 'foreign', resumePageCleanup: { ...resume, discardDraft: true } })).isError, true);
    service.pageRegistry.unbindPage(binding.pageKey);
    // Reproduce an already-deleted legacy team: only native receipts survive,
    // and its original delete result predates retainedPages.
    const legacy = structuredClone(deleted.structuredContent);
    delete (legacy.sessions as Array<{ retainedPages?: unknown }>)[0]!.retainedPages;
    receipts.record({ clientId: 'team:' + team.teamId, requestId: 'legacy-delete', method: 'team.delete',
      requestHash: hashCanonical({ method: 'team.delete', payload: { teamId: team.teamId } }), status: 'complete', result: legacy });
    const legacyResume = { ...resume, deletionRequestId: 'legacy-delete' };
    assert.equal((await invoke({ teamId: team.teamId, requestId: 'missing-proof', resumePageCleanup: legacyResume })).isError, true);
    const input = { teamId: team.teamId, requestId: 'resume', resumePageCleanup: { ...legacyResume,
      ownershipRequestId: 'native-original-ownership', discardDraft: true as const } };
    await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>'));
    assert.equal((await invoke(input)).isError, true, 'Explicit obsolete draft disposal still preserves active Stop');
    await page.locator('[data-testid="stop-button"]').evaluate(node => node.remove());
    await page.locator('body').evaluate(body => body.insertAdjacentHTML('beforeend', '<div role="dialog">Protected</div>'));
    assert.equal((await invoke(input)).isError, true, 'Protected dialogs remain guarded');
    await page.locator('[role="dialog"]').evaluate(node => node.remove());
    const result = await invoke(input);
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.structuredContent.pageCleanupOnly, true);
    assert.equal((result.structuredContent.pageCleanup as { closedPages: number }).closedPages, 1);
    assert.equal(result.structuredContent.preservedDraft, 'Preserve obsolete draft');
    assert.equal(page.isClosed(), true);
    const absent = await invoke({ teamId: team.teamId, requestId: 'modern-absent', resumePageCleanup: resume });
    assert.equal(absent.isError, false, JSON.stringify(absent));
    assert.deepEqual(absent.structuredContent.pageCleanup, { closedPages: 0, pageErrors: [], targetAbsent: true });
    assert.deepEqual((await invoke(input)).structuredContent, result.structuredContent);
    assert.deepEqual((await invoke(original)).structuredContent, deleted.structuredContent, 'Original deletion receipt stays immutable');
    assert.equal(preparations, 0, 'Original draft preflight refusal and page-only recovery never prepare provider deletion');
    assert.equal(fake.stopCount, 0);
    assert.equal(fake.submitCount, 1);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
