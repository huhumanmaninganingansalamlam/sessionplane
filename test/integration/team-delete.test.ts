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
    assert.equal(differentProvider.page.isClosed(), false, 'Another provider is not cleanup ownership');
    assert.equal(service.pageRegistry.listBindings().some(b => b.sessionId === session.sessionId), false);
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
    const mock = t.mock.method(service.pageRegistry, 'listBindings', () => { throw new Error('Interrupted cleanup'); });
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
