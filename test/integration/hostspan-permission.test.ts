import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
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
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <div data-message-author-role="user" data-message-id="user-message-1">Fixture question</div>
      <textarea id="prompt-textarea">Keep my draft</textarea><button data-testid="stop-button">Stop generating</button>
      <div role="alert" id="permission">hostspan-desktop Process Start
        <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#details').hidden=false">View details</button>
        <section id="details" hidden>Command: original work
          <button id="allow" onclick="window.grants=(window.grants||0)+1;document.querySelector('#permission').remove()">Allow once</button>
          <button onclick="throw Error('Must not click')">Always allow</button>
        </section>
      </div><div role="alert">another-app Process Start<button>Allow</button></div>
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
    const inspected = await decide('inspect', { action: 'inspect' });
    assert.equal(inspected.isError, false, JSON.stringify(inspected));
    const permission = inspected.structuredContent.permission as { evidenceHash: string; permissionText: string };
    assert.match(permission.permissionText, /Command: original work/);
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
    assert.equal(fake.submitCount, 1);
    assert.equal(fake.stopCount, 0);
    assert.equal(core.teamDirectory.getSession(session.sessionId).generation, 1);
    assert.equal(core.teamDirectory.getSession(session.sessionId).terminal, false);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
