import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { runCli } from '../../src/cli/main.ts';
import { Readable, Writable } from 'node:stream';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('explicit HostSpan permission controls only the current exact grant, preserving work and idempotency', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-hostspan-permission-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'fixture-owner' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const { page, binding } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main>
      <div data-message-author-role="user" data-message-id="user-message-1">Fixture question</div>
      <span id="elapsed">1 hour 14 seconds working</span>
      <textarea id="prompt-textarea">Keep my draft</textarea><button data-testid="stop-button">Stop generating</button>
      <section id="permission"><div role="alert">hostspan-desktop Process Start
        <button aria-expanded="false" onclick="document.querySelector('#details').hidden=false">View details</button></div>
        <button id="allow" onclick="window.grants=(window.grants||0)+1;document.querySelector('#permission').remove()"><span>한 번만 허용</span><kbd>⏎</kbd></button>
          <button onclick="throw Error('Must not click')">Always allow</button>
      </section>
      <section role="dialog" id="details" hidden>hostspan-desktop Process Start Command: original work
        <button aria-label="Close dialog" onclick="document.querySelector('#details').hidden=true">Close dialog</button>
      </section><div role="alert">another-app Process Start<button>Allow</button></div>
    </main>` }));
    await page.goto(`https://chatgpt.com/c/conversation-${session.sessionId}`);
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => ({ ...await open(request), pageKey: binding.pageKey,
      bindAcknowledgement() { core.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId,
        generation: 1, conversationId: `conversation-${session.sessionId}` }); } }));
    await core.submissionService.send({ clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId,
      prompt: 'Fixture question', sessionDeadlineSec: 600 });
    const row = core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=?').get(session.sessionId)!;
    const decide = async (requestId: string, extra: Record<string, unknown>) => invokeMcpTool({
      name: 'sessionplane_decide', arguments: { teamId: team.teamId, requestRef: row.outbox_id, requestId,
        decision: 'hostspan_permission', appName: 'hostspan-desktop', toolName: 'Process Start', ...extra },
      socketPath: config.socketPath, timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes });
    t.mock.method(page, 'bringToFront', async () => { throw Error('Must not focus'); });
    const prepare = t.mock.method(core.browserOwner!, 'preparePageInteraction');
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    assert.equal(await runCli(['request', 'hostspan_permission', team.teamId, String(row.outbox_id), '--action', 'inspect',
      '--app-name', 'hostspan-desktop', '--tool-name', 'Process Start', '--request-id', 'cli-inspect', '--socket', config.socketPath, '--json'],
      { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    const inspected = { structuredContent: JSON.parse(output) };
    assert.equal(inspected.structuredContent.requestOk, true, JSON.stringify(inspected));
    assert.equal(prepare.mock.callCount(), 1, 'Use the existing exact-page background interaction lifecycle');
    const permission = inspected.structuredContent.permission as { evidenceHash: string; permissionText: string };
    assert.match(permission.permissionText, /Command: original work/);
    assert.doesNotMatch(permission.permissionText, /Fixture question|working|Keep my draft/);
    await page.locator('#elapsed').evaluate(element => { element.textContent = '1 hour 44 seconds working'; });
    const reinspected = await decide('clock-only-change', { action: 'inspect' });
    assert.equal((reinspected.structuredContent.permission as { evidenceHash: string }).evidenceHash, permission.evidenceHash,
      'Only the exact permission card and command bind approval, never the changing transcript clock');
    assert.equal((await decide('foreign-app', { action: 'allow', appName: 'another-app', evidenceHash: permission.evidenceHash })).isError, true);
    await page.locator('#details').evaluate(element => element.prepend('Changed command '));
    assert.equal((await decide('changed', { action: 'allow', evidenceHash: permission.evidenceHash })).isError, true);
    await page.locator('#details').evaluate(element => element.firstChild!.remove());
    const allowed = await decide('allow-original', { action: 'allow', evidenceHash: permission.evidenceHash });
    assert.equal(allowed.isError, false, JSON.stringify(allowed));
    assert.equal((allowed.structuredContent.permission as { permissionStillVisible: boolean }).permissionStillVisible, false);
    assert.deepEqual((await decide('allow-original', { action: 'allow', evidenceHash: permission.evidenceHash })).structuredContent,
      allowed.structuredContent);
    assert.equal(await page.evaluate(() => (window as unknown as { grants: number }).grants), 1);
    assert.equal(await page.locator('textarea').inputValue(), 'Keep my draft');
    assert.equal(await page.locator('[data-testid="stop-button"]').count(), 1);
    await page.evaluate(() => document.querySelector('main')!.insertAdjacentHTML('beforeend',
      '<section><div role="alert">hostspan-desktop Process Start Command: second read</div><button onclick="window.grants++">Allow once</button></section>'));
    const pending = await decide('inspect-second', { action: 'inspect' });
    const second = await decide('allow-second', { action: 'allow',
      evidenceHash: (pending.structuredContent.permission as { evidenceHash: string }).evidenceHash });
    assert.equal((second.structuredContent.permission as { permissionStillVisible: boolean }).permissionStillVisible, true,
      'A surviving permission alert is not reported as gone just because its actions are outside the alert');
    assert.equal(await page.evaluate(() => (window as unknown as { grants: number }).grants), 2);
    await page.locator('section button').filter({ hasText: 'Allow once' }).evaluateAll(elements => elements.forEach(e => { e.textContent = 'Unverified action'; }));
    assert.equal((await decide('unverified-card-action', { action: 'inspect' })).isError, true,
      'An unknown card action cannot broaden evidence to the entire conversation');
    assert.equal(fake.submitCount, 1);
    assert.equal(fake.stopCount, 0);
    assert.equal(core.teamDirectory.getSession(session.sessionId).generation, 1);
    assert.equal(core.teamDirectory.getSession(session.sessionId).terminal, false);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
