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
import { ChatGptAdapter } from '../../src/providers/chatgpt/adapter.ts';
import { SessionUiService } from '../../src/core/session-ui-service.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { callRpc } from '../../src/cli/client.ts';
import { controlHostSpanPermission, inspectHostSpanActivity, revealHostSpanActivity } from '../../src/providers/chatgpt/hostspan-permission.ts';

test('a buttonless current provider alert blocks continuation without fabricating a user action', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-alert-blocker-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [new FakeProviderAdapter()],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'fixture-owner' });
    const initial = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const { page, binding } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main>
      <div data-message-author-role="user" data-message-id="current-ack">Original work</div>
      <div role="alert">hostspan-desktop 다시 연결. 연결이 만료되었습니다.</div>
      <textarea id="prompt-textarea"></textarea></main>` }));
    await page.goto('https://chatgpt.com/c/fixture');
    core.pageRegistry.reservePage(binding.pageKey, { sessionId: initial.sessionId, generation: initial.generation, conversationId: 'fixture' });
    const session = { ...core.teamDirectory.getSession(initial.sessionId), pageKey: binding.pageKey,
      conversationId: 'fixture', submittedUserMessageId: 'current-ack', submittedUserTurnId: 'current-ack',
      submissionState: 'submitted' as const, promptSubmitted: true };
    const ui = new SessionUiService({ submissions: core.submissionService, registry: core.pageRegistry,
      browserOwner: core.browserOwner, chatgptUrl: 'https://chatgpt.com/' });
    await assert.rejects(ui.hostspanPermission({ ...session, terminal: true }, {
      action: 'decline', appName: 'hostspan-desktop', toolName: 'Process Cancel', evidenceHash: 'a'.repeat(64),
    }), /completed turn permits inspection only/);
    await assert.rejects(ui.verifyContinuation(session, session), error => {
      assert.ok(error instanceof SessionPlaneDomainError);
      assert.equal(error.errorCode, 'provider.preparation-required');
      const details = error.details as any;
      assert.equal(details.kind, 'provider-alert');
      assert.equal(details.submittedUserMessageId, 'current-ack');
      assert.deepEqual(details.providerAlerts, ['hostspan-desktop 다시 연결. 연결이 만료되었습니다.']);
      assert.equal(details.actionVerified, false);
      assert.equal(details.requiredUserAction, null);
      return true;
    });
    assert.equal(await page.getByRole('alert').textContent(), 'hostspan-desktop 다시 연결. 연결이 만료되었습니다.');
    assert.equal(await page.locator('textarea').inputValue(), '');
    assert.equal(await page.locator('[data-message-author-role="user"]').count(), 1);
    await page.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="user" data-message-id="later-user">Other work</div>'));
    await assert.rejects(ui.verifyContinuation(session, session), error => {
      assert.ok(error instanceof SessionPlaneDomainError);
      assert.equal(error.errorCode, 'provider.preparation-required');
      assert.equal(error.details, undefined, 'A later user cannot inherit the original blocker provenance');
      return true;
    });
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const label of ['Decline', '거부Esc']) test(`permission ${label} rejects only the freshly inspected owned card without granting Cancel`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-permission-decline-'));
  const core = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), browserHeadless: true,
    providerAdapters: [new FakeProviderAdapter()], logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main>
      <div data-message-author-role="user" data-message-id="current-ack">Original work</div>
      <section id="card"><div role="alert">hostspan-desktop Process Cancel <span id="target">proc_unknown</span></div>
        <button onclick="throw Error('Never grant Cancel')">Allow once</button>
        <button id="decline" onclick="window.declines=(window.declines||0)+1;document.querySelector('#card').remove()">${label}</button>
      </section><textarea id="prompt-textarea">Preserved draft</textarea></main>` }));
    await page.goto('https://chatgpt.com/c/fixture');
    const input = { appName: 'hostspan-desktop', toolName: 'Process Cancel' };
    const inspected = await controlHostSpanPermission(page, { ...input, action: 'inspect' }, 'current-ack');
    assert.equal(inspected.outcome, 'inspected');
    assert.ok('evidenceHash' in inspected && inspected.evidenceHash);
    const reject = { ...input, action: 'decline' as const, evidenceHash: inspected.evidenceHash };
    await assert.rejects(controlHostSpanPermission(page, { ...reject, evidenceHash: undefined }, 'current-ack'), /evidenceHash/);
    await assert.rejects(controlHostSpanPermission(page, { ...reject, toolName: undefined }, 'current-ack'), /observed tool name/);
    await assert.rejects(controlHostSpanPermission(page, { ...reject, toolName: 'File Patch' }, 'current-ack'), /absent or ambiguous/);
    await page.locator('#target').evaluate(node => node.textContent = 'proc_changed');
    await assert.rejects(controlHostSpanPermission(page, reject, 'current-ack'), /current exact permission/);
    await page.locator('#target').evaluate(node => node.textContent = 'proc_unknown');
    await page.locator('#decline').evaluate(node => node.setAttribute('disabled', ''));
    await assert.rejects(controlHostSpanPermission(page, reject, 'current-ack'), /Decline control/);
    await page.locator('#decline').evaluate(node => { node.removeAttribute('disabled'); node.after(node.cloneNode(true)); });
    await assert.rejects(controlHostSpanPermission(page, reject, 'current-ack'), /current exact permission/);
    await page.locator('#decline').last().evaluate(node => node.remove());
    await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="user" data-message-id="later-user">Later work</div>'));
    await assert.rejects(controlHostSpanPermission(page, reject, 'current-ack'), /current user anchor/);
    await page.locator('[data-message-id="later-user"]').evaluate(node => node.remove());
    assert.equal(await page.evaluate(() => (window as any).declines ?? 0), 0);
    const result = await controlHostSpanPermission(page, reject, 'current-ack');
    assert.equal(result.outcome, 'decline-clicked');
    assert.ok('grantAttempted' in result && result.grantAttempted === false);
    assert.ok('permissionStillVisible' in result && result.permissionStillVisible === false);
    assert.equal(await page.evaluate(() => (window as any).declines), 1);
    assert.equal(await page.locator('#prompt-textarea').inputValue(), 'Preserved draft');
    assert.equal(await page.locator('[data-message-author-role="user"]').count(), 1);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('previous activity reveals only its structurally contained same-ACK HostSpan surface and reports links without secrets', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-previous-activity-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [new FakeProviderAdapter()],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main>
      <div data-message-author-role="user" data-message-id="current-ack">Original work</div>
      <section><button aria-expanded="false" onclick="throw Error('Unrelated disclosure')">이전 활동</button></section>
      <section id="owned"><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#hidden-work').hidden=false">이전 활동</button>
      <div hidden id="hidden-work"><div class="group/activity-header"><button aria-expanded="false">hostspan-desktop 및 Personal Context 통합 사용함</button></div>
      <section><div role="alert">hostspan-desktop reconnect</div><a href="https://connector.example/authorize?client_id=existing&state=private-value">Reconnect existing link</a><a href="http://[invalid">Malformed</a><a href="javascript:alert('private-value')">Unsafe scheme</a><button onclick="window.reconnects=(window.reconnects||0)+1">다시 연결⏎</button></section></div></section>
      <textarea>Preserved draft</textarea></main>` }));
    await page.goto('https://chatgpt.com/c/fixture');
    const read = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(read.available);
    const previous = read.disclosures.filter(item => item.name === '이전 활동');
    assert.equal(previous[0]!.revealAvailable, false, 'A nearby app cannot qualify an unrelated disclosure');
    assert.equal(previous[0]!.containedActivity, null);
    assert.ok(previous[1]!.activityEvidenceHash);
    assert.equal(previous[1]!.containedApp?.name, 'hostspan-desktop 및 Personal Context 통합 사용함');
    assert.match(previous[1]!.containedActivity!.text, /hostspan-desktop reconnect/);
    const hiddenLink = previous[1]!.containedActivity!.controls.find(control => control.role === 'link')!;
    assert.equal(hiddenLink.visible, false, 'Read hidden controls without revealing or resuming a held turn');
    assert.equal(hiddenLink.href, 'https://connector.example/authorize');
    assert.doesNotMatch(JSON.stringify(previous[1]!.containedActivity), /private-value/);
    assert.equal(await page.locator('#hidden-work').isVisible(), false);
    assert.ok(read.cards.some(card => card.role === null && card.controls.some(control => control.name === '다시 연결⏎')),
      'Reconnect controls beside an alert are diagnostic candidates, not a permission grant');
    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(), 'hostspan-other', previous[1]!.activityEvidenceHash!), /different app/);
    await page.locator('#hidden-work [class~="group/activity-header"] button').evaluate(element => element.replaceWith(element.cloneNode(true)));
    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(), 'hostspan-desktop', previous[1]!.activityEvidenceHash!), /fresh HostSpan activityEvidenceHash/);
    const fresh = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(fresh.available);
    const selected = fresh.disclosures.find(item => item.containedApp !== null)!;
    const result = await revealHostSpanActivity(page, 'current-ack', new Set(), 'hostspan-desktop', selected.activityEvidenceHash!);
    assert.equal(result.grantAttempted, false);
    assert.equal(result.activityUserMessageId, 'current-ack');
    assert.ok(result.activity.available);
    const link = result.activity.cards.flatMap(card => card.controls).find(control => control.role === 'link')!;
    assert.equal(link.visible, true);
    assert.equal(link.href, 'https://connector.example/authorize');
    assert.deepEqual(link.urlParameterNames, ['client_id', 'state']);
    for (const name of ['Malformed', 'Unsafe scheme'])
      assert.equal(result.activity.cards.flatMap(card => card.controls).find(control => control.name === name)!.href, null);
    assert.doesNotMatch(JSON.stringify(result.activity), /private-value/);
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved draft');
    assert.equal(await page.evaluate(() => (window as any).reconnects ?? 0), 0, 'Inspection never opens authentication');
    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(), 'hostspan-desktop', selected.activityEvidenceHash!), /fresh HostSpan activityEvidenceHash/);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('collapsed activity diagnostics preserve parent identity without reading payloads or enabling reveal', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-activity-structure-'));
  const core = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), browserHeadless: true,
    providerAdapters: [new FakeProviderAdapter()], logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await core.browserOwner!.createPage();
    // The retained Webturn packet proves six hidden disclosures, but not their
    // ancestry. This synthetic topology checks diagnostics, not its live shape.
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<main>
      <div data-message-author-role="user" data-message-id="current-ack">Original work</div>
      <section class="activity-shell"><button aria-expanded="false" aria-controls="hidden-work" onclick="throw Error('private-handler')">이전 활동</button>
        <div hidden id="hidden-work">${Array.from({ length: 6 }, (_, i) => `<section><div class="group/activity-header"><button aria-expanded="false">hostspan-desktop 통합 사용함</button></div>
          <pre>private-tool-body-${i}</pre><input value="private-credential"><textarea>private-draft</textarea></section>`).join('')}</div>
      </section>
      <section><div class="group/activity-header"><button aria-expanded="false">hostspan-desktop separate activity</button></div></section>
      <textarea id="prompt-textarea">Preserved draft</textarea></main>` }));
    await page.goto('https://chatgpt.com/c/fixture');
    const read = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(read.available);
    const opener = read.disclosures.find(item => item.name === '이전 활동')!;
    const headers = read.disclosures.filter(item => item.name === 'hostspan-desktop 통합 사용함');
    assert.equal(opener.activityEvidenceHash, null);
    assert.equal(opener.revealAvailable, false, 'Diagnostics cannot authorize a multi-header reveal');
    assert.equal(opener.structure!.tag, 'button');
    const container = opener.structure!.ancestors[0]!;
    assert.deepEqual(container.classes, ['activity-shell']);
    assert.equal(opener.structure!.parentRef, container.ref);
    const controlled = opener.structure!.controlled[0]!;
    assert.equal(controlled.matches, 1);
    assert.equal(controlled.target!.parentRef, container.ref);
    assert.equal(headers.length, 6);
    for (const header of headers) {
      assert.equal(header.structure!.visible, false);
      assert.equal(header.structure!.owningUserMessageId, 'current-ack');
      assert.ok(header.structure!.ancestors.some(node => node.ref === controlled.target!.ref));
      assert.equal(header.structure!.ancestors[0]!.classes[0], 'group/activity-header');
    }
    const unrelated = read.disclosures.find(item => item.name === 'hostspan-desktop separate activity')!;
    assert.ok(!unrelated.structure!.ancestors.some(node => node.ref === container.ref));
    assert.doesNotMatch(JSON.stringify(read.disclosures.map(item => item.structure)), /private-|Preserved draft/);
    assert.equal(await page.locator('#hidden-work').isVisible(), false);
    assert.equal(await page.locator('#prompt-textarea').inputValue(), 'Preserved draft');
    await page.locator('#hidden-work').evaluate(node => node.insertAdjacentHTML('afterend', '<div id="hidden-work"></div>'));
    const ambiguous = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(ambiguous.available);
    const duplicate = ambiguous.disclosures.find(item => item.name === '이전 활동')!.structure!.controlled[0]!;
    assert.equal(duplicate.matches, 2);
    assert.equal(duplicate.target, null, 'An ambiguous controls ID cannot acquire structural identity');
    await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="user" data-message-id="later-user">Later work</div>'));
    assert.equal((await inspectHostSpanActivity(page, 'current-ack')).available, false);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('identical activity labels keep exact mounted element identity across reads and reordering', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-identical-activity-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [new FakeProviderAdapter()],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <div data-message-author-role="user" data-message-id="current-ack">Original work</div>
      ${[1, 2, 3].map(id => `<section id="activity-${id}"><div class="group/activity-header"><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#output-${id}').hidden=false">hostspan-desktop 통합 사용함</button></div><div hidden id="output-${id}">Original output ${id}</div></section>`).join('')}
      <textarea>Preserved draft</textarea></main>` }));
    await page.goto('https://chatgpt.com/c/fixture');
    const read = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(read.available);
    const hashes = read.disclosures.map(item => item.activityEvidenceHash!);
    assert.equal(hashes.length, 3);
    assert.equal(new Set(hashes).size, 3, 'Identical names, ACKs and states must not collide');
    const again = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(again.available);
    assert.deepEqual(again.disclosures.map(item => item.activityEvidenceHash), hashes);
    await page.locator('#activity-2').evaluate(element => element.parentElement!.insertBefore(element, element.parentElement!.querySelector('#activity-1')));
    const reveal = await revealHostSpanActivity(page, 'current-ack', new Set(), 'hostspan-desktop', hashes[1]!);
    assert.equal(reveal.grantAttempted, false);
    assert.equal(await page.locator('#output-2').isVisible(), true);
    assert.equal(await page.locator('#output-1').isVisible(), false);
    assert.equal(await page.locator('#output-3').isVisible(), false);
    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(), 'hostspan-desktop', hashes[1]!), /fresh HostSpan activityEvidenceHash/);
    await page.locator('#activity-3 button').evaluate(element => element.replaceWith(element.cloneNode(true)));
    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(), 'hostspan-desktop', hashes[2]!), /fresh HostSpan activityEvidenceHash/);
    assert.equal(await page.locator('#output-3').isVisible(), false, 'A replacement with the same label cannot inherit identity');
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved draft');
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('passive evidence reads only an already-expanded exact HostSpan response without inferring execution', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-expanded-response-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [new FakeProviderAdapter()],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await core.browserOwner!.createPage();
    // Retained Bible576 evidence: successful outer/group/individual reveal, but
    // expanded disclosures had containedActivity:null. Fixture bodies are synthetic.
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <div data-message-author-role="user" data-message-id="current-ack">Original work</div>
      <section><div class="group/activity-header"><button aria-expanded="true">hostspan-desktop</button></div>
        <section><div class="group/activity-header"><button aria-expanded="true">monitor 2 calls</button></div>
          <section id="running"><div class="group/activity-header"><button aria-expanded="true" aria-controls="running-body">monitor</button></div>
            <pre id="running-body">{"processId":"proc_exact_running","status":"running","stdout":"partial","access_token":"private-token"}
Authorization: Bearer private-bearer
https://example.test/result?token=private-query#private-fragment</pre>
            <textarea>private-draft</textarea><input type="password" value="private-password">
          </section>
          <section id="terminal"><div class="group/activity-header"><button aria-expanded="true">monitor</button></div>
            <pre>{"processId":"proc_exact_done","status":"exited","exitCode":0,"stdout":"done","stderr":""}</pre>
            <pre hidden>private-hidden</pre><a href="https://example.test/?token=private-link">private-link-label</a>
          </section>
          <section id="missing"><div class="group/activity-header"><button aria-expanded="true">monitor source inventory proc_not_evidence</button></div></section>
          <section id="collapsed"><div class="group/activity-header"><button aria-expanded="false" onclick="throw Error('No reveal')">monitor</button></div>
            <pre>private-collapsed</pre></section>
        </section>
      </section>
      <section><div class="group/activity-header"><button aria-expanded="true">unrelated</button></div><pre>private-other-app</pre></section>
      <textarea id="prompt-textarea">Preserved draft</textarea><button onclick="throw Error('No grant')">Always allow</button>
      </main>` }));
    await page.goto('https://chatgpt.com/c/fixture');
    await page.evaluate(() => document.addEventListener('click', () => {
      (window as any).inspectionClicks = ((window as any).inspectionClicks ?? 0) + 1;
    }, true));
    const read = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(read.available);
    assert.equal(read.providerMutation, false);
    const bodies = read.disclosures.filter(item => item.containedActivity !== null);
    assert.equal(bodies.length, 2, 'Parent/group bodies must not pool sibling or nested call output');
    const running = bodies.find(item => item.containedActivity!.text.includes('proc_exact_running'))!;
    const terminal = bodies.find(item => item.containedActivity!.text.includes('proc_exact_done'))!;
    assert.equal(running.owningUserMessageId, 'current-ack');
    assert.match(running.containedActivity!.text, /"status":"running"/);
    assert.doesNotMatch(running.containedActivity!.text, /proc_exact_done/);
    assert.match(terminal.containedActivity!.text, /"exitCode":0/);
    assert.match(terminal.containedActivity!.text, /"stderr":""/);
    assert.equal(read.disclosures.find(item => item.name.includes('source inventory'))!.containedActivity, null,
      'A tool label without returned body is UNKNOWN, not a process receipt');
    assert.equal(read.disclosures.find(item => item.expanded === 'false')!.containedActivity, null);
    assert.doesNotMatch(JSON.stringify(bodies), /private-|proc_not_evidence/);
    assert.equal(await page.locator('#prompt-textarea').inputValue(), 'Preserved draft');
    assert.equal(await page.locator('#collapsed button').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => (window as any).inspectionClicks ?? 0), 0);
    await page.locator('#terminal pre').first().evaluate(element => element.textContent = 'x'.repeat(5000));
    const bounded = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(bounded.available);
    const long = bounded.disclosures.find(item => item.activityRef === terminal.activityRef)!.containedActivity!;
    assert.equal(long.text.length, 4000);
    assert.equal(long.textTruncated, true, 'Incomplete output is explicit, never a completion inference');
    await page.locator('#running button').evaluate(element => element.setAttribute('aria-controls', 'running-body missing-body'));
    const absent = await inspectHostSpanActivity(page, 'current-ack');
    assert.ok(absent.available);
    assert.equal(absent.disclosures.find(item => item.activityRef === running.activityRef)!.containedActivity, null);
    await page.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="user" data-message-id="later-user">Later work</div>'));
    const later = await inspectHostSpanActivity(page, 'current-ack');
    assert.equal(later.available, false);
    assert.equal('disclosures' in later, false, 'A stale ACK cannot expose current tool responses');
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('retained activity is read only under its stored ACK, never reassigned to the current request', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-retained-activity-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [new FakeProviderAdapter()],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <div data-message-author-role="user" data-message-id="owned-older-ack">Original work</div>
      <div data-message-author-role="assistant" data-message-id="older-answer">
        <section id="app-activity"><div class="group/activity-header"><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#retained-body').hidden=false">hostspan-desktop previous activity</button></div>
        <section hidden id="retained-body">hostspan-desktop File Patch<button onclick="throw Error('No allow')">Always allow</button>
          <section><div class="group/activity-header"><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#child-output').hidden=false">Exact child tool activity</button></div>
          <div hidden id="child-output">Original tool output</div></section>
        </section></section>
        <section><div class="group/activity-header"><button aria-expanded="false" onclick="throw Error('Unrelated sibling must stay closed')">Unrelated sibling</button></div></section>
      </div>
      <div data-message-author-role="user" data-message-id="unowned-user">Unrelated manual question</div>
      <div role="alert">hostspan-desktop unrelated permission<button>Allow</button></div>
      <div data-message-author-role="user" data-message-id="current-ack">New contextual follow-up</div>
      <div role="alert">hostspan-desktop current warning</div><textarea>Preserved draft</textarea></main>` }));
    await page.goto('https://chatgpt.com/c/fixture');
    const currentOnly = await inspectHostSpanActivity(page, 'current-ack');
    assert.equal(currentOnly.available, true);
    assert.doesNotMatch(JSON.stringify(currentOnly), /File Patch|unrelated permission/);
    const read = await inspectHostSpanActivity(page, 'current-ack', new Set(['owned-older-ack']));
    assert.equal(read.available, true);
    if (!read.available) return;
    const older = read.cards.find(card => card.text.includes('File Patch'))!;
    assert.equal(older.association, 'retained-acknowledged-turn');
    assert.equal(older.owningUserMessageId, 'owned-older-ack');
    assert.equal(older.visible, false);
    assert.equal(read.disclosures.find(item => item.owningUserMessageId === 'owned-older-ack')?.expanded, 'false');
    assert.doesNotMatch(JSON.stringify(read), /unrelated permission|evidenceHash/);
    const selected = read.disclosures.find(item => item.activityEvidenceHash !== null)!;
    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(['owned-older-ack']),
      'hostspan-other', selected.activityEvidenceHash!), /different app/);
    await page.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="user" data-message-id="new-user">Different request</div>'));
    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(['owned-older-ack']),
      'hostspan-desktop', selected.activityEvidenceHash!), /exact-current-ack-not-mounted/);
    await page.locator('[data-message-id="new-user"]').evaluate(element => element.remove());
    const revealed = await revealHostSpanActivity(page, 'current-ack', new Set(['owned-older-ack']),
      'hostspan-desktop', selected.activityEvidenceHash!);
    assert.equal(revealed.revealClicked, true);
    assert.equal(revealed.grantAttempted, false);
    assert.equal(revealed.activityUserMessageId, 'owned-older-ack');
    assert.equal(await page.locator('#retained-body').isVisible(), true);
    const child = revealed.activity.available && revealed.activity.disclosures.find(item => item.name === 'Exact child tool activity');
    assert.ok(child && child.activityEvidenceHash);
    assert.equal(child.appActivity?.name, 'hostspan-desktop previous activity');
    assert.equal(child.owningUserMessageId, 'owned-older-ack');
    assert.equal(revealed.activity.available && revealed.activity.disclosures.find(item => item.name === 'Unrelated sibling')?.revealAvailable, false);
    await page.getByRole('button', { name: 'hostspan-desktop previous activity', exact: true }).evaluate(element => element.textContent = 'another-app previous activity');
    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(['owned-older-ack']),
      'hostspan-desktop', child.activityEvidenceHash), /fresh HostSpan activityEvidenceHash/);
    await page.getByRole('button', { name: 'another-app previous activity', exact: true }).evaluate(element => element.textContent = 'hostspan-desktop previous activity');
    const childResult = await revealHostSpanActivity(page, 'current-ack', new Set(['owned-older-ack']),
      'hostspan-desktop', child.activityEvidenceHash);
    assert.equal(childResult.grantAttempted, false);
    assert.equal(await page.locator('#child-output').isVisible(), true);

    await assert.rejects(revealHostSpanActivity(page, 'current-ack', new Set(['owned-older-ack']),
      'hostspan-desktop', selected.activityEvidenceHash!), /fresh HostSpan activityEvidenceHash/);
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved draft');
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

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
      <button type="button" role="radio" aria-checked="true">Chat</button>
      <div class="group/activity-header"><button aria-expanded="false" onclick="window.unrelatedClicks=(window.unrelatedClicks||0)+1">hostspan-desktop 통합 사용함</button></div>
      <div id="activity"><div class="group/activity-header"><button aria-expanded="false" aria-labelledby="work-label" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#work').hidden=false"></button><span id="work-label">이전 활동</span></div>
      <span id="elapsed">1 hour 14 seconds working</span>
      <textarea id="prompt-textarea">Keep my draft</textarea><button data-testid="stop-button">Stop generating</button>
      <div id="work" hidden>
      <section><div class="group/activity-header"><button aria-expanded="false" onclick="window.unrelatedClicks=(window.unrelatedClicks||0)+1">Nested tool activity</button></div></section>
      <section id="permission"><div role="alert">hostspan-desktop Process Start
        <button aria-expanded="false" onclick="document.querySelector('#details').hidden=false">View details</button></div>
        <button id="allow" onclick="window.grants=(window.grants||0)+1;document.querySelector('#permission').remove()"><span>한 번만 허용</span><kbd>⏎</kbd></button>
          <button onclick="throw Error('Must not click')">Always allow</button>
      </section>
      <section role="dialog" id="details" hidden>hostspan-desktop Process Start Command: original work
        <button aria-label="Close dialog" onclick="document.querySelector('#details').hidden=true">Close dialog</button>
      </section></div></div><div role="alert">another-app Process Start<button>Allow</button></div>
    </main>` }));
    await page.goto(`https://chatgpt.com/c/conversation-${session.sessionId}`);
    const open = fake.openSubmission.bind(fake);
    const observer = new ChatGptAdapter({ browserOwner: core.browserOwner!, pageRegistry: core.pageRegistry,
      loginUrl: 'https://chatgpt.com/' });
    t.mock.method(fake, 'openObservation', request => observer.openObservation(request));
    t.mock.method(fake, 'openSubmission', async request => ({ ...await open(request), pageKey: binding.pageKey,
      bindAcknowledgement() { core.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId,
        generation: 1, conversationId: `conversation-${session.sessionId}` }); } }));
    await core.submissionService.send({ clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId,
      prompt: 'Fixture question', sessionDeadlineSec: 600 });
    const row = core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=?').get(session.sessionId)!;
    const waited = await invokeMcpTool({ name: 'sessionplane_wait', arguments: {
      teamId: team.teamId, requestRefs: [row.outbox_id], waitMs: 60000, continuationApproved: true,
    }, socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    assert.equal(waited.structuredContent.results[0].errorCode, 'provider.actionable-alert', JSON.stringify(waited));
    await page.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend', `
      <div data-message-author-role="assistant" data-message-id="activity-answer">
        <button aria-expanded="false" onclick="throw Error('Read must not reveal')">Previous activity</button>
        <section hidden id="roleless-card">hostspan-desktop File Patch (no ARIA alert)
          <button onclick="throw Error('Read must not grant')">Always allow</button>
        </section>
      </div>`));
    const original = core.teamDirectory.getSession(session.sessionId);
    const read = await callRpc<any>({ socketPath: config.socketPath, method: 'session.submission.inspect',
      params: { clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId, generation: 1 },
      timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes });
    const activity = read.evidence.submissionVerification.hostspanActivity;
    assert.equal(activity.available, true, JSON.stringify(activity));
    assert.equal(activity.providerMutation, false);
    assert.equal(activity.workUserMessageId, 'user-message-1');
    assert.ok(activity.disclosures.some((item: any) => item.name === 'Previous activity' && item.expanded === 'false'));
    assert.ok(activity.cards.some((item: any) => item.role === null && !item.visible &&
      item.text.includes('File Patch') && item.controls.some((control: any) => control.name === 'Always allow')),
      'Read evidence includes hidden roleless controls inside assistant activity omitted by preparation snapshots');
    assert.doesNotMatch(JSON.stringify(activity), /Old permission|Unrelated earlier work/);
    assert.equal(activity.evidenceHash, undefined, 'Diagnostic candidates do not authorize a permission');
    const afterRead = core.teamDirectory.getSession(session.sessionId);
    for (const key of ['generation', 'submissionState', 'submittedUserMessageId', 'submittedUserTurnId',
      'conversationId', 'pageKey', 'answerText', 'responseMessageId', 'terminal'] as const)
      assert.equal(afterRead[key], original[key], 'A read preserves request identity/result while its original observer can progress');
    assert.equal(await page.locator('textarea').inputValue(), 'Keep my draft');
    assert.equal(await page.locator('button[aria-labelledby="work-label"]').getAttribute('aria-expanded'), 'false');
    await assert.rejects(callRpc({ socketPath: config.socketPath, method: 'session.submission.inspect',
      params: { clientId: 'another-owner', requestId: 'original', sessionId: session.sessionId, generation: 1 },
      timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes }), /Exact caller-owned submission/);
    await page.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="user" data-message-id="later-work">Different work</div>'));
    const later = await inspectHostSpanActivity(page, 'user-message-1');
    assert.equal(later.available, false, 'A later work question cannot be inspected as the original request');
    assert.equal('cards' in later, false);
    await page.locator('[data-message-id="later-work"]').evaluate(element => element.remove());
    await page.locator('#roleless-card').evaluate(element => element.parentElement!.remove());
    assert.equal(await page.locator('button[aria-labelledby="work-label"]').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => (window as any).grants ?? 0), 0);
    assert.equal(fake.submitCount, 1, 'Hidden permission returns the existing collector without another Continue');
    const successor=displaced ? core.teamDirectory.createSession({teamId:team.teamId,roleKey:'main',provider:'chatgpt'}) : null;
    const decide = async (requestId: string, extra: Record<string, unknown>) => invokeMcpTool({
      name: 'sessionplane_decide', arguments: { teamId: team.teamId, requestRef: row.outbox_id, requestId,
        decision: 'hostspan_permission', appName: 'hostspan-desktop', toolName: 'Process Start', ...extra },
      socketPath: config.socketPath, timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes });
    await page.locator('main').evaluate(element => element.insertAdjacentHTML('beforeend', `
      <section id="selected-activity"><div class="group/activity-header"><button aria-expanded="false"
        onclick="this.setAttribute('aria-expanded','true');document.querySelector('#activity-body').hidden=false">hostspan-desktop exact activity</button></div>
        <div id="activity-body" hidden>hostspan-desktop File Patch<button onclick="throw Error('No grant')">Always allow</button></div></section>`));
    const surface = await callRpc<any>({ socketPath: config.socketPath, method: 'session.submission.inspect',
      params: { clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId, generation: 1 },
      timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes });
    const selectedHash = surface.evidence!.submissionVerification!.hostspanActivity!.disclosures
      .find(item => item.name === 'hostspan-desktop exact activity')!.activityEvidenceHash;
    const reveal = await decide('inspect-observed-activity', { action: 'inspect', toolName: undefined, evidenceHash: selectedHash });
    assert.equal(reveal.isError, false, JSON.stringify(reveal));
    assert.equal((reveal.structuredContent.permission as any).outcome, 'activity-revealed');
    assert.equal((reveal.structuredContent.permission as any).grantAttempted, false);
    const expanded = await invokeMcpTool({ name: 'sessionplane_team_get', arguments: {
      teamId: team.teamId, requestRef: row.outbox_id, view: 'evidence', maxNodes: 300,
    }, socketPath: config.socketPath, timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes });
    assert.equal(expanded.isError, false, JSON.stringify(expanded));
    const disclosure = (expanded.structuredContent as any).request.evidence.submissionVerification.hostspanActivity.disclosures
      .find((item: any) => item.name === 'hostspan-desktop exact activity');
    assert.equal(disclosure.structure.tag, 'button', 'Normal public evidence retains structural diagnostics');
    assert.equal(disclosure.structure.parentRef, disclosure.structure.ancestors[0].ref);
    const body = disclosure.containedActivity;
    assert.match(body.text, /hostspan-desktop File Patch/, 'Public evidence reads the revealed exact body despite preparation snapshots excluding it');
    assert.doesNotMatch(body.text, /Fixture question|Keep my draft|Always allow/);
    await page.locator('#selected-activity').evaluate(element => element.remove());
    t.mock.method(page, 'bringToFront', async () => { throw Error('Must not focus'); });
    const prepare = t.mock.method(core.browserOwner!, 'preparePageInteraction');
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    assert.equal(await runCli(['request', 'hostspan_permission', team.teamId, String(row.outbox_id), '--action', 'inspect',
      '--app-name', 'hostspan-desktop', '--tool-name', 'Process Start', '--request-id', 'cli-inspect', '--socket', config.socketPath, '--json'],
      { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    const inspected = { structuredContent: JSON.parse(output) };
    assert.equal(inspected.structuredContent.requestOk, true, JSON.stringify(inspected));
    assert.equal(await page.evaluate(() => (window as any).grants ?? 0), 0,
      'Inspect reveals the unknown pending arguments without granting or launching the tool');
    assert.match(inspected.structuredContent.permission.permissionText, /Command: original work/);
    assert.equal(fake.submitCount, 1, 'Inspect must not submit a new provider turn');
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
      `<section id="decline-card"><div role="alert">hostspan-desktop Process Cancel proc_unknown</div>
      <button onclick="throw Error('Decline must never grant')">Allow once</button>
      <button onclick="window.declines=(window.declines||0)+1;document.querySelector('#decline-card').remove()">거부Esc</button></section>`));
    const cancelCard = await decide('inspect-cancel-for-decline', { action: 'inspect', toolName: 'Process Cancel' });
    assert.equal(cancelCard.isError, false, JSON.stringify(cancelCard));
    const cancelHash = (cancelCard.structuredContent.permission as { evidenceHash: string }).evidenceHash;
    output = '';
    const declineArgs = ['request', 'hostspan_permission', team.teamId, String(row.outbox_id), '--action', 'decline',
      '--app-name', 'hostspan-desktop', '--tool-name', 'Process Cancel', '--evidence-hash', cancelHash,
      '--request-id', 'cli-decline', '--socket', config.socketPath, '--json'];
    assert.equal(await runCli(declineArgs, { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    const declined = JSON.parse(output);
    assert.equal(declined.permission.outcome, 'decline-clicked');
    assert.equal(declined.permission.grantAttempted, false);
    assert.equal(declined.permission.permissionStillVisible, false);
    output = '';
    assert.equal(await runCli(declineArgs, { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    assert.deepEqual(JSON.parse(output), declined, 'The same decline requestId returns its receipt without another click');
    assert.equal(await page.evaluate(() => (window as any).declines), 1);
    assert.equal(await page.evaluate(() => (window as any).grants), 2);
    assert.equal(fake.submitCount, 1, 'Decline does not resend or continue the product prompt');
    assert.equal(await page.locator('textarea').inputValue(), 'Keep my draft');
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
    await page.setContent(`<main><button type="button" role="radio" aria-checked="true">Chat</button>
      <div data-message-author-role="user" data-message-id="older-work-user">Existing implementation question</div>
      <button aria-expanded="false" aria-controls="earlier" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#earlier').hidden=false">작업함</button>
      <section id="earlier" hidden><div role="alert">hostspan-desktop File Patch</div>
        <button onclick="throw Error('Must not choose once')">Allow once</button>
        <button onclick="window.earlierGrants=(window.earlierGrants||0)+1;document.querySelector('#earlier').remove()">Always allow</button></section>
      <div data-message-author-role="user" data-message-id="user-message-1">계속</div><textarea>Preserved draft</textarea></main>`);
    const retained = await inspectHostSpanActivity(page, 'user-message-1');
    assert.equal(retained.available, true);
    if (retained.available) {
      assert.equal(retained.workUserMessageId, 'older-work-user');
      assert.ok(retained.cards.some(card => !card.visible && card.text.includes('File Patch')));
      assert.equal(retained.disclosures[0]?.expanded, 'false', 'Reading does not reveal earlier activity');
    }
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
