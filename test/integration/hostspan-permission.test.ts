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

for(const displaced of [false,true]) test(`explicit HostSpan permission ${displaced ? 'inspects a preserved predecessor' : 'controls only the current exact grant'}, preserving work and idempotency`, async t => {
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
      <button aria-expanded="false" onclick="throw Error('Old work must stay closed')">작업 중입니다</button>
      <div data-message-author-role="user" data-message-id="old-question">Unrelated earlier work</div>
      <section role="alert" hidden>hostspan-desktop Process Start Old permission</section>
      <div data-message-author-role="user" data-message-id="user-message-1">Fixture question</div>
      <div class="group/activity-header"><button aria-expanded="false" onclick="window.unrelatedClicks=(window.unrelatedClicks||0)+1">hostspan-desktop 통합 사용함</button></div>
      <div class="group/activity-header"><button aria-expanded="false" aria-controls="work" aria-labelledby="work-label" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#work').hidden=false"></button><span id="work-label">이전 활동</span></div>
      <span id="elapsed">1 hour 14 seconds working</span>
      <textarea id="prompt-textarea">Keep my draft</textarea><button data-testid="stop-button">Stop generating</button>
      <div id="work" hidden><section id="permission"><div role="alert">hostspan-desktop Process Start
        <button aria-expanded="false" onclick="document.querySelector('#details').hidden=false">View details</button></div>
        <button id="allow" onclick="window.grants=(window.grants||0)+1;document.querySelector('#permission').remove()"><span>한 번만 허용</span><kbd>⏎</kbd></button>
          <button onclick="throw Error('Must not click')">Always allow</button>
      </section>
      <section role="dialog" id="details" hidden>hostspan-desktop Process Start Command: original work
        <button aria-label="Close dialog" onclick="document.querySelector('#details').hidden=true">Close dialog</button>
      </section></div><div role="alert">another-app Process Start<button>Allow</button></div>
    </main>` }));
    await page.goto(`https://chatgpt.com/c/conversation-${session.sessionId}`);
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => ({ ...await open(request), pageKey: binding.pageKey,
      bindAcknowledgement() { core.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId,
        generation: 1, conversationId: `conversation-${session.sessionId}` }); } }));
    await core.submissionService.send({ clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId,
      prompt: 'Fixture question', sessionDeadlineSec: 600 });
    const row = core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=?').get(session.sessionId)!;
    const successor=displaced ? core.teamDirectory.createSession({teamId:team.teamId,roleKey:'main',provider:'chatgpt'}) : null;
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
    assert.equal(await page.evaluate(() => (window as any).unrelatedClicks ?? 0), 0,
      'Explicit permission inspection opens only the card-linked disclosure, never integration controls or another work question');
    assert.equal(prepare.mock.callCount(), 1, 'Use the existing exact-page background interaction lifecycle');
    if(successor){
      const granted=await decide('retained-exact-grant',{action:'allow',evidenceHash:inspected.structuredContent.permission.evidenceHash});
      assert.equal(granted.isError,false,JSON.stringify(granted));
      assert.equal((granted.structuredContent.permission as any).permissionStillVisible,false);
      assert.equal(await page.evaluate(()=>(window as any).grants??0),1);
      assert.equal(await page.locator('textarea').inputValue(),'Keep my draft');
      assert.deepEqual(core.teamDirectory.getSession(successor.sessionId),successor);
      assert.equal(fake.submitCount,1);
      return;
    }
    await page.evaluate(() => document.querySelector('main')!.insertAdjacentHTML('beforeend',
      '<button aria-expanded="false" data-state="closed" onclick="window.unrelatedClicks=(window.unrelatedClicks||0)+1">채팅 및 작업 필터링</button>'));
    const discoveryCurrent = await decide('discover-current-card', { action: 'inspect', toolName: undefined, allowMode: 'always' });
    const discovered = discoveryCurrent.structuredContent.permission as { outcome: string; evidenceHash?: string; workDisclosures: { name: string; expanded: string }[] };
    assert.equal(discovered.outcome, 'discovered');
    assert.equal(discovered.evidenceHash, undefined, 'Discovery does not authorize a tool grant');
    assert.deepEqual(discovered.workDisclosures.map(({ name, expanded }) => ({ name, expanded })),
      [{ name: '이전 활동', expanded: 'true' }], 'Report only the disclosure structurally owning the actual card, including its labelled title');
    const detailsClicks = t.mock.method(Object.getPrototypeOf(page.locator('button')), 'click');
    const missingEvidence = await decide('allow-discovery-without-evidence', { action: 'allow', allowMode: 'always' });
    assert.equal(missingEvidence.isError, true);
    assert.match(JSON.stringify(missingEvidence), /same allowMode.*evidenceHash/);
    assert.equal(detailsClicks.mock.callCount(), 0, 'An allow without exact inspection evidence must not reveal or click anything');
    detailsClicks.mock.restore();
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
    await page.locator('main > section').evaluateAll(elements => elements.forEach(element => element.remove()));
    await page.evaluate(() => document.querySelector('main')!.insertAdjacentHTML('beforeend',
      `<section id="persistent"><div role="alert">hostspan-desktop Process Start Command: authorized development</div>
      <button onclick="throw Error('Must not choose once')">Allow once</button>
      <button onclick="window.alwaysGrants=(window.alwaysGrants||0)+1;document.querySelector('#persistent').remove()">항상 허용</button></section>`));
    const onceEvidence = await decide('inspect-persistent-once', { action: 'inspect' });
    assert.equal((await decide('wrong-mode', { action: 'allow', allowMode: 'always',
      evidenceHash: (onceEvidence.structuredContent.permission as { evidenceHash: string }).evidenceHash })).isError, true,
      'One-time evidence cannot authorize a persistent permission');
    output = '';
    assert.equal(await runCli(['request', 'hostspan_permission', team.teamId, String(row.outbox_id), '--action', 'inspect',
      '--app-name', 'hostspan-desktop', '--tool-name', 'Process Start', '--allow-mode', 'always',
      '--request-id', 'cli-inspect-always', '--socket', config.socketPath, '--json'],
      { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    const persistent = JSON.parse(output).permission;
    assert.equal(persistent.allowMode, 'always');
    const alwaysAllowed = await decide('allow-persistent', { action: 'allow', allowMode: 'always', evidenceHash: persistent.evidenceHash });
    assert.equal(alwaysAllowed.isError, false, JSON.stringify(alwaysAllowed));
    assert.equal((alwaysAllowed.structuredContent.permission as { allowMode: string }).allowMode, 'always');
    assert.equal((alwaysAllowed.structuredContent.permission as { permissionStillVisible: boolean }).permissionStillVisible, false);
    assert.equal(await page.evaluate(() => (window as unknown as { alwaysGrants: number }).alwaysGrants), 1);
    assert.deepEqual((await decide('allow-persistent', { action: 'allow', allowMode: 'always',
      evidenceHash: persistent.evidenceHash })).structuredContent, alwaysAllowed.structuredContent);
    await page.evaluate(() => document.querySelector('main')!.insertAdjacentHTML('beforeend',
      `<section id="collapsed"><div role="alert">hostspan-desktop File Patch
        <button onclick="document.querySelector('#grant-details').hidden=false">자세히 보기</button></div></section>
      <section role="dialog" id="grant-details" hidden>hostspan-desktop File Patch Command: authorized existing task patch
        <button onclick="window.patchGrants=(window.patchGrants||0)+1;document.querySelector('#collapsed').remove();document.querySelector('#grant-details').remove()">항상 허용</button></section>`));
    const patch = await decide('inspect-collapsed-patch', { action: 'inspect', toolName: 'File Patch', allowMode: 'always' });
    assert.equal(patch.isError, false, JSON.stringify(patch));
    const patchEvidence = patch.structuredContent.permission as { evidenceHash: string; permissionText: string };
    assert.match(patchEvidence.permissionText, /authorized existing task patch/);
    assert.equal(await page.evaluate(() => (window as unknown as { patchGrants?: number }).patchGrants ?? 0), 0);
    const patchAllowed = await decide('allow-collapsed-patch', { action: 'allow', toolName: 'File Patch', allowMode: 'always',
      evidenceHash: patchEvidence.evidenceHash });
    assert.equal(patchAllowed.isError, false, JSON.stringify(patchAllowed));
    assert.equal((patchAllowed.structuredContent.permission as { permissionStillVisible: boolean }).permissionStillVisible, false);
    assert.equal(await page.evaluate(() => (window as unknown as { patchGrants: number }).patchGrants), 1);
    // An uncertain later Continue must not make an existing conversation grant
    // unreadable, nor may granting it fabricate an ACK for that Continue.
    core.database.raw.prepare("UPDATE generations SET submission_state='submission_unknown', submitted_user_message_id=NULL, submitted_user_turn_id=NULL WHERE session_id=?").run(session.sessionId);
    await page.evaluate(() => {
      document.querySelector('[data-message-id="user-message-1"]')!.outerHTML =
        '<div data-chatgpt-search-message-ids="user-message-1"><div data-user-message-bubble>Fixture question</div></div>';
      document.querySelector('main')!.insertAdjacentHTML('beforeend',
        `<button aria-expanded="false" aria-controls="pending-work" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#pending-work').hidden=false">작업 중입니다</button>
        <section id="pending-work" hidden><div role="alert">hostspan-desktop Process Cancel</div>
        <button onclick="document.querySelector('#pending-work').remove()">Allow once</button></section>`);
    });
    const unknown = await decide('inspect-unknown-grant', { action: 'inspect', toolName: 'Process Cancel' });
    assert.equal(unknown.isError, false, JSON.stringify(unknown));
    const unknownPermission = unknown.structuredContent.permission as { evidenceHash: string; requestAcknowledgementVerified: boolean };
    assert.equal(unknownPermission.requestAcknowledgementVerified, false);
    const unknownAllowed = await decide('allow-unknown-grant', { action: 'allow', toolName: 'Process Cancel', evidenceHash: unknownPermission.evidenceHash });
    assert.equal(unknownAllowed.isError, false, JSON.stringify(unknownAllowed));
    assert.equal(core.teamDirectory.getSession(session.sessionId).submissionState, 'submission_unknown');
    assert.equal(core.teamDirectory.getSession(session.sessionId).submittedUserMessageId, null);
    assert.equal(fake.submitCount, 1);
    assert.equal(fake.stopCount, 0);
    assert.equal(core.teamDirectory.getSession(session.sessionId).generation, 1);
    assert.equal(core.teamDirectory.getSession(session.sessionId).terminal, false);
    await page.setContent(`<main>
      <div data-message-author-role="user" data-message-id="older-work-user">Existing implementation question</div>
      <button aria-expanded="false" aria-controls="earlier" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#earlier').hidden=false">작업함</button>
      <section id="earlier" hidden><div role="alert">hostspan-desktop File Patch</div>
        <button onclick="throw Error('Must not choose once')">Allow once</button>
        <button onclick="window.earlierGrants=(window.earlierGrants||0)+1;document.querySelector('#earlier').remove()">Always allow</button></section>
      <div data-message-author-role="user" data-message-id="user-message-1">계속</div><textarea>Preserved draft</textarea></main>`);
    output = '';
    assert.equal(await runCli(['request', 'hostspan_permission', team.teamId, String(row.outbox_id), '--action', 'inspect',
      '--app-name', 'hostspan-desktop', '--allow-mode', 'always', '--request-id', 'discover-earlier-card',
      '--socket', config.socketPath, '--json'], { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    const discovery = JSON.parse(output).permission;
    assert.equal(discovery.outcome, 'discovered');
    assert.equal(discovery.cards.length, 1);
    assert.match(discovery.cards[0].permissionText, /File Patch/);
    assert.equal(discovery.cards[0].submittedUserMessageId, 'older-work-user');
    assert.equal(await page.evaluate(() => (window as any).earlierGrants ?? 0), 0);
    assert.equal((await decide('grant-without-tool', { action: 'allow', toolName: undefined, allowMode: 'always' })).isError, true);
    const earlier = await decide('inspect-earlier-exact', { action: 'inspect', toolName: 'File Patch', allowMode: 'always' });
    const earlierPermission = earlier.structuredContent.permission as { evidenceHash: string; permissionUserMessageId: string };
    assert.equal(earlierPermission.permissionUserMessageId, 'older-work-user');
    const granted = await decide('grant-earlier-exact', { action: 'allow', toolName: 'File Patch', allowMode: 'always', evidenceHash: earlierPermission.evidenceHash });
    assert.equal(granted.isError, false, JSON.stringify(granted));
    assert.equal((granted.structuredContent.permission as any).permissionStillVisible, false);
    assert.equal(await page.evaluate(() => (window as any).earlierGrants), 1);
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved draft');
    assert.equal(core.teamDirectory.getSession(session.sessionId).submittedUserMessageId, null);
    assert.equal(fake.submitCount, 1);

  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
