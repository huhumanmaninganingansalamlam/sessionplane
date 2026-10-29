import { callRpc } from '../../src/cli/client.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { errors } from 'playwright-core';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import type { ConfigurationCatalog } from '../../src/providers/chatgpt/configuration-catalog.ts';
import { ChatGptConfigurationMenu } from '../../src/providers/chatgpt/configuration-catalog.ts';

test('empty same-role Chat opening materializes once without a prompt, generation or submission', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-empty-chat-'));
  const core = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const create = core.browserOwner!.createPage.bind(core.browserOwner);
  let pages = 0;
  t.mock.method(core.browserOwner!, 'createPage', async (...args) => {
    pages++;
    const result = await create(...args);
    await result.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body:
      '<main><div role="group"><button aria-pressed="true">Chat</button><button aria-pressed="false" onclick="throw Error(\'No Work\')">Work</button></div><textarea></textarea></main>' }));
    return result;
  });
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: 'sessionplane_' + name,
    arguments: args, socketPath: core.config.socketPath, timeoutMs: 10000, maxLineBytes: core.config.rpcMaxLineBytes });
  try {
    const team = (await invoke('team_create', { requestId: 'empty-chat-team' })).structuredContent as any;
    const input = { teamId: team.teamId, roleRef: team.roles[0].roleRef, requestId: 'open-empty' };
    const opened = await invoke('session_open', input);
    assert.equal(opened.isError, false, JSON.stringify(opened));
    assert.equal((opened.structuredContent.observedSurface as any).mode, 'chat', JSON.stringify({ opened, snapshot: core.teamDirectory.getSession(String(opened.structuredContent.sessionId)), binding: core.pageRegistry.getBinding(String(opened.structuredContent.pageKey)) }));
    assert.equal((opened.structuredContent.observedSurface as any).source, 'selected-control');
    assert.equal(opened.structuredContent.generation, 0);
    assert.equal(opened.structuredContent.promptSubmitted, false);
    assert.equal(core.database.raw.prepare('SELECT COUNT(*) AS count FROM outbox').get()!.count, 0);
    assert.equal(core.database.raw.prepare('SELECT COUNT(*) AS count FROM generations').get()!.count, 0);
    assert.deepEqual((await invoke('session_open', input)).structuredContent, opened.structuredContent);
    assert.equal((await invoke('session_open', { ...input, requestId: 'read-retained-empty' })).isError, false);
    assert.equal(pages, 1);
    const page = core.pageRegistry.pageForObservation(String(opened.structuredContent.pageKey));
    assert.equal(await page.locator('textarea').inputValue(), '');
    const foreign = (await invoke('team_create', { requestId: 'foreign-empty-team' })).structuredContent as any;
    assert.equal((await invoke('session_open', { ...input, teamId: foreign.teamId })).isError, true);
    assert.equal(pages, 1);
    // A previously open operation cannot be used to open a submitted generation.
    await core.submissionService.send({ clientId: 'fixture', requestId: 'not-an-empty-request',
      sessionId: String(opened.structuredContent.sessionId), prompt: 'Authorized fixture preparation', sessionDeadlineSec: 600 }).catch(() => {});
    assert.equal((await invoke('session_open', { ...input, roleRef: String(opened.structuredContent.sessionId) + ':1' })).isError, true);
    assert.equal(await page.locator('textarea').inputValue(), '');
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Chat-only preparation never advertises or activates Work through catalog or raw choices', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-chat-only-choices-'));
  const service = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const owner = service.browserOwner!;
  const createPage = owner.createPage.bind(owner);
  owner.createPage = async (...args) => {
    const created = await createPage(...args);
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture
      .replace('<button type="button" role="radio" aria-checked="true">Chat</button>', '<div role="radiogroup"><button type="button" id="chat-mode" role="radio" aria-checked="true">Chat</button><button type="button" id="work-mode" role="radio" aria-checked="false" onclick="window.workActivations++">Work</button></div>')
      .replace('<div role="menuitemradio" tabindex="0" aria-checked="false" aria-disabled="true">Unavailable-7</div>', '$&<div role="menuitemradio" tabindex="0" aria-checked="false">Work</div>')
      .replace('<script>', '<script>window.workActivations=0;document.addEventListener("click",e=>{if(e.target.closest("[role=menuitemradio]")?.textContent==="Work")window.workActivations++},true);') }));
    return created;
  };
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: `sessionplane_${name}`,
    arguments: args, socketPath: service.config.socketPath, timeoutMs: 30_000, maxLineBytes: service.config.rpcMaxLineBytes });
  try {
    const team = (await invoke('team_create', { requestId: 'chat-team' })).structuredContent;
    const pending = (await invoke('send', { teamId: team.teamId, roleRef: (team.roles as any[])[0].roleRef,
      requestId: 'chat-prepared', prompt: 'Preserve this request', model: 'Aurora-9', effort: 'Balanced' })).structuredContent;
    const identity = { teamId: team.teamId, requestRef: pending.requestRef };
    const current = (await invoke('team_get', { ...identity, view: 'evidence' })).structuredContent.request as any;
    assert.equal(current.evidence.observedSurface.mode, 'chat');
    assert.ok(current.configurationCatalog.options.length > 0);
    assert.ok(current.configurationCatalog.options.every((o: any) => !/^work$/i.test(o.version) && !/^work$/i.test(o.label)));
    const work = current.evidence.nodes.find((n: any) => n.name === 'Work');
    assert.ok(work);
    assert.deepEqual(work.actions, { choose: [], reveal: [] });
    for (const decision of ['choose', 'reveal']) {
      const rejected = await invoke('decide', { ...identity, requestId: `raw-work-${decision}`, decision,
        purpose: 'model', snapshotId: current.evidence.snapshotId, ref: work.ref });
      assert.equal(rejected.isError, true);
      assert.equal(rejected.structuredContent.errorCode, 'capability.unsupported');
    }
    const page = service.pageRegistry.pageForObservation(current.pageKey);
    const menu = new ChatGptConfigurationMenu(page, current.pageKey);
    await assert.rejects(menu.select({ id: 'legacy-work', label: 'Work', version: 'Work', power: null }), /Only model and effort/);
    // Match the current real provider's role=group + ordinary pressed buttons.
    await page.locator('[role="radiogroup"]').evaluate(group => {
      group.setAttribute('role', 'group');
      for (const button of group.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', button.getAttribute('aria-checked')!);
        button.removeAttribute('aria-checked'); button.removeAttribute('role');
        button.setAttribute('data-state', 'closed');
      }
    });
    const pressed = (await invoke('team_get', { ...identity, view: 'evidence' })).structuredContent.request as any;
    assert.equal(pressed.evidence.observedSurface.mode, 'chat');
    assert.equal(pressed.evidence.preparationAvailability.available, true);
    const configured = await invoke('decide', { ...identity, requestId: 'configure-observed-chat', decision: 'configure',
      configurationId: pressed.configurationCatalog.options.find((o: any) => o.label === 'Aurora-9 / Balanced').id });
    assert.equal(configured.isError, false, JSON.stringify(configured));
    assert.equal(configured.structuredContent.promptSubmitted, false);
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(await page.locator('#chat-mode').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => (window as any).workActivations), 0);
    await page.evaluate(() => {
      document.querySelector('#chat-mode')!.setAttribute('aria-pressed', 'false');
      document.querySelector('#work-mode')!.setAttribute('aria-pressed', 'true');
    });
    const blocked = (await invoke('team_get', { ...identity, view: 'evidence' })).structuredContent.request as any;
    assert.equal(blocked.evidence.observedSurface.mode, 'work');
    assert.equal(blocked.configurationCatalog, null);
    assert.ok(blocked.evidence.nodes.every((n: any) => n.actions.choose.length === 0 && n.actions.reveal.length === 0));
    assert.equal(blocked.promptSubmitted, false);
    const draft = await page.locator('textarea').inputValue();
    await assert.rejects(menu.discover(), /observation-only/);
    assert.equal(await page.locator('textarea').inputValue(), draft);
    assert.equal(await page.evaluate(() => (window as any).workActivations), 0);
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

const fixture = `<!doctype html><html><body><main><button type="button" role="radio" aria-checked="true">Chat</button><form>
  <button type="button" id="chooser" aria-label="ChatGPT model selection" aria-haspopup="menu" aria-expanded="false" aria-controls="configuration" hidden>Aurora-9 / Balanced</button>
  <textarea aria-label="Prompt">Untouched draft</textarea><button type="submit">Send</button>
</form><div id="configuration" role="menu" hidden>
  <div role="menuitem" tabindex="0" aria-label="Model selection" id="summary"></div>
  <div role="slider" tabindex="0" aria-label="Power" aria-valuemin="0" aria-valuemax="2" aria-valuenow="1" id="power" style="width:200px;height:30px"></div>
</div><div id="versions" role="menu" hidden>
  <div role="menuitemradio" tabindex="0" aria-checked="true">Aurora-9</div>
  <div role="menuitemradio" tabindex="0" aria-checked="false">Aurora-8</div>
  <div role="menuitemradio" tabindex="0" aria-checked="false" aria-disabled="true">Unavailable-7</div>
</div></main><script>
  window.version = 'Aurora-9'; window.powerValue = 1; window.opens = 0; window.submits = 0;
  window.labels = ['Quick', 'Balanced', 'Deep'];
  const chooser = document.querySelector('#chooser'), menu = document.querySelector('#configuration');
  const versions = document.querySelector('#versions'), summary = document.querySelector('#summary');
  const power = document.querySelector('#power');
  function render() {
    summary.textContent = window.version + ' / ' + window.labels[window.powerValue];
    chooser.textContent = window.version === 'Aurora-9'
      ? (chooser.getAttribute('aria-expanded') === 'true' ? 'Configuration' : window.labels[window.powerValue])
      : summary.textContent;
    power.setAttribute('aria-valuenow', window.powerValue);
    for (const option of versions.children) option.setAttribute('aria-checked', String(option.textContent === window.version));
  }
  chooser.onclick = () => { const open = chooser.getAttribute('aria-expanded') !== 'true';
    window.opens++; chooser.setAttribute('aria-expanded', String(open));
    if (!open) { setTimeout(() => { menu.hidden = true; versions.hidden = true; chooser.setAttribute('aria-controls', 'configuration'); render(); }, 120); return; }
    render();
    if (chooser.getAttribute('aria-controls') === 'versions') { menu.hidden = true; versions.hidden = false; }
    else { menu.hidden = false; versions.hidden = true; } };
  summary.onclick = () => { menu.hidden = true; versions.hidden = false; chooser.setAttribute('aria-controls', 'versions'); };
  for (const option of versions.children) option.onclick = () => {
    if (option.getAttribute('aria-disabled') === 'true') return;
    window.version = option.textContent; versions.hidden = true; menu.hidden = false; chooser.setAttribute('aria-controls', 'configuration'); render();
    power.style.visibility = 'hidden'; setTimeout(() => { power.style.visibility = 'visible'; }, 120); };
  power.onkeydown = event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    window.powerValue = Math.max(0, Math.min(2, window.powerValue + (event.key === 'ArrowRight' ? 1 : -1))); render(); };
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && chooser.getAttribute('aria-expanded') === 'true') chooser.click(); });
  document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submits++; };
  document.querySelector('textarea').onfocus = () => setTimeout(() => { chooser.hidden = false; }, 120);
  render();
</script></body></html>`;

for (const selectedMode of ['Chat', 'Work']) test(`unverified preparation exposes only read-only picker inspection before ${selectedMode} proof`, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-mode-inspection-'));
  const service = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const owner = service.browserOwner!, createPage = owner.createPage.bind(owner);
  owner.createPage = async (...args) => {
    const created = await createPage(...args);
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture
      .replace('<button type="button" role="radio" aria-checked="true">Chat</button>', '')
      .replace(' hidden>Aurora-9 / Balanced', '>Aurora-9 / Balanced')
      .replace('<div id="configuration" role="menu" hidden>', `<div id="configuration" role="menu" hidden><div role="radiogroup"><button type="button" role="radio" aria-checked="${selectedMode === 'Chat'}">Chat</button><button type="button" role="radio" aria-checked="${selectedMode === 'Work'}" onclick="throw Error('Never select Work')">Work</button></div>`) }));
    return created;
  };
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: `sessionplane_${name}`,
    arguments: args, socketPath: service.config.socketPath, timeoutMs: 30_000, maxLineBytes: service.config.rpcMaxLineBytes });
  try {
    const team = (await invoke('team_create', { requestId: 'inspect-mode-team' })).structuredContent;
    const pending = (await invoke('send', { teamId: team.teamId, roleRef: (team.roles as any[])[0].roleRef,
      requestId: 'inspect-mode-prepare', prompt: 'Preserve exact unsubmitted work', model: 'Aurora-9', effort: 'Balanced' })).structuredContent;
    const identity = { teamId: team.teamId, requestRef: pending.requestRef };
    assert.ok(identity.requestRef);
    const before = (await invoke('team_get', { ...identity, view: 'evidence' })).structuredContent.request as any;
    assert.equal(before.evidence.observedSurface.mode, 'unknown');
    assert.equal(before.evidence.preparationAvailability.available, false);
    assert.ok(before.evidence.nodes.every((n: any) => n.actions.choose.length === 0));
    const choices = before.evidence.nodes.filter((n: any) => n.actions.reveal.includes('model'));
    assert.equal(choices.length, 1);
    assert.equal(choices[0].id, 'chooser');
    const revealed = await invoke('decide', { ...identity, requestId: 'inspect-only-mode', decision: 'reveal', purpose: 'model',
      snapshotId: before.evidence.snapshotId, ref: choices[0].ref });
    assert.equal(revealed.isError, false, JSON.stringify(revealed));
    const after = revealed.structuredContent as any;
    assert.equal(after.promptSubmitted, false);
    assert.equal(after.evidence.observedSurface.mode, selectedMode.toLowerCase());
    assert.ok(after.evidence.nodes.filter((n: any) => n.name === 'Work').every((n: any) => n.actions.choose.length === 0 && n.actions.reveal.length === 0));
    if (selectedMode === 'Work') assert.ok(after.evidence.nodes.every((n: any) => n.actions.choose.length === 0));
    const page = service.pageRegistry.pageForObservation(before.pageKey);
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
    assert.equal(service.database.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='generation.submit-attempted'").get()!.n, 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unavailable preparation never offers Retry as submit and preserves the same request across restart and page restoration', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-preparation-unavailable-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const start = () => startCore({ config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  let service = await start();
  const owner = service.browserOwner!;
  const closeOwner = owner.close.bind(owner);
  const createPage = owner.createPage.bind(owner);
  owner.createPage = async (...args) => {
    const created = await createPage(...args);
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    return created;
  };
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({
    name: `sessionplane_${name}`, arguments: args, socketPath: config.socketPath,
    timeoutMs: 30_000, maxLineBytes: config.rpcMaxLineBytes });
  try {
    const team = (await invoke('team_create', { requestId: 'unavailable-team' })).structuredContent;
    const roleRef = (team.roles as { roleRef: string }[])[0]!.roleRef;
    const pending = (await invoke('send', { teamId: team.teamId, roleRef,
      requestId: 'unavailable-send', prompt: 'Preserve this exact request', model: 'Aurora-8 / Deep' })).structuredContent;
    const identity = { teamId: team.teamId, requestRef: pending.requestRef };
    const inspect = async () => {
      const response = await invoke('team_get', { ...identity, view: 'evidence' });
      assert.equal(response.isError, false, JSON.stringify(response));
      return response.structuredContent.request as Record<string, any>;
    };
    const initial = await inspect();
    assert.equal(initial.observedSurface.mode, 'chat');
    assert.equal(initial.evidence.observedSurface.source, 'selected-control');
    const shown = await callRpc<{ observedSurface: { mode: string; source: string } }>({
      socketPath: config.socketPath, method: 'session.get',
      params: { clientId: 'sessionplane-mcp', sessionId: initial.sessionId } });
    assert.equal(shown.observedSurface.mode, 'chat');
    assert.equal(shown.observedSurface.source, 'selected-control');
    const option = initial.configurationCatalog.options.find((o: any) => o.label === 'Aurora-8 / Deep');
    assert.ok(option);
    const page = service.pageRegistry.pageForObservation(initial.pageKey);
    let authRequests = 0;
    page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/session') authRequests++; });
    await inspect();
    await invoke('wait', { teamId: identity.teamId, requestRefs: [identity.requestRef], waitMs: 1 });
    assert.equal(authRequests, 0, 'get/wait inspect existing DOM without authentication requests');
    await page.setContent('<main><div id="challenge-stage">Verify you are human</div></main>');
    const guardedRefresh = await invoke('decide', { ...identity, requestId: 'guarded-refresh', decision: 'refresh' });
    assert.equal(guardedRefresh.isError, true);
    assert.equal(guardedRefresh.structuredContent.errorCode, 'provider.human-action-required');
    assert.equal(service.database.raw.prepare('SELECT COUNT(*) AS n FROM request_receipts WHERE request_id=?').get('guarded-refresh')!.n, 0);
    await page.setContent(fixture);
    const originalBinding = service.pageRegistry.getBinding(initial.pageKey);
    const staleSubmit = initial.evidence.nodes.find((n: any) => n.actions.choose.includes('submit'));
    assert.ok(staleSubmit);
    const assertUnavailable = async () => {
      const current = await inspect();
      assert.equal(current.sessionId, initial.sessionId);
      assert.equal(current.generation, initial.generation);
      assert.equal(current.requestRef, initial.requestRef);
      assert.equal(current.submissionState, 'prepared');
      assert.equal(current.promptSubmitted, false);
      assert.equal(current.terminal, false);
      assert.equal(current.evidence.preparationAvailability.available, false);
      assert.equal(current.observedSurface.mode, 'unknown');
      assert.ok(current.evidence.nodes.every((n: any) => !n.actions.choose.includes('submit')));
      if (current.configurationCatalog !== null) {
        assert.equal(current.configurationCatalog.selectionAvailable, false);
        assert.ok(current.configurationCatalog.options.every((o: any) => o.selection === undefined));
      }
      return current;
    };
    await page.setContent('<main><div>Cannot load conversation</div><button type="button" onclick="window.retryClicks++">Retry</button></main><script>window.retryClicks=0</script>');
    const unavailable = await assertUnavailable();
    const retry = unavailable.evidence.nodes.find((n: any) => n.name === 'Retry');
    const rejected = await invoke('decide', { ...identity, requestId: 'reject-retry-submit', decision: 'choose',
      purpose: 'submit', snapshotId: unavailable.evidence.snapshotId, ref: retry.ref });
    assert.equal(rejected.structuredContent.errorCode, 'input.invalid');
    const configure = await invoke('decide', { ...identity, requestId: 'reject-unavailable-config',
      decision: 'configure', configurationId: option.id });
    assert.equal(configure.structuredContent.errorCode, 'provider.preparation-unavailable');
    const stale = await invoke('decide', { ...identity, requestId: 'reject-old-submit-ref', decision: 'choose',
      purpose: 'submit', snapshotId: initial.evidence.snapshotId, ref: staleSubmit.ref });
    assert.equal(stale.isError, true);
    assert.equal(await page.evaluate(() => (window as any).retryClicks), 0);
    for (const editor of ['<textarea hidden></textarea>', '<textarea readonly></textarea>', '<textarea disabled></textarea>']) {
      await page.setContent(`<main><form>${editor}<button type="submit" data-testid="send-button">Retry</button></form></main>`);
      await assertUnavailable();
    }
    await page.setContent('<main><div>Cannot load conversation</div><button type="button">Retry</button></main>');
    const registry = service.pageRegistry;
    owner.close = async () => registry.detach();
    await service.close();
    const lockPath = path.join(owner.status.profileDir, '.sessionplane-profile.lock');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    writeFileSync(lockPath, JSON.stringify({ ...lock, pid: 99_999_999 }));
    service = await start();
    const restarted = await assertUnavailable();
    assert.equal(service.browserOwner!.status.browserPid, owner.status.browserPid);
    assert.equal(service.pageRegistry.getBinding(restarted.pageKey).targetId, originalBinding.targetId);
    const restoredPage = service.pageRegistry.pageForObservation(restarted.pageKey);
    restoredPage.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/session') authRequests++; });
    await restoredPage.setContent(fixture.replace('</form>', '<button type="button">Retry</button><button type="reset">Reset</button></form>')
      .replace('<script>', '<script>(() => {').replace('</script>', '})();</script>'));
    let restored = await inspect();
    assert.equal(restored.requestRef, initial.requestRef);
    assert.equal(restored.evidence.preparationAvailability.available, true);
    assert.deepEqual(restored.evidence.nodes.filter((n: any) => n.actions.choose.includes('submit')).map((n: any) => n.name), ['Send']);
    const discovered = await invoke('decide', { ...identity, requestId: 'restore-catalog', decision: 'discover' });
    assert.equal(discovered.isError, false, JSON.stringify(discovered));
    restored = await inspect();
    assert.equal(restored.configurationCatalog.selectionAvailable, true);
    const restoredOption = restored.configurationCatalog.options.find((o: any) => o.id === option.id);
    const selected = await invoke('decide', { ...identity, requestId: 'restore-model', ...restoredOption.selection });
    assert.equal(selected.isError, false, JSON.stringify(selected));
    restored = await inspect();
    const composer = restored.evidence.nodes.find((n: any) => n.actions.choose.includes('composer'));
    const beforePrepareAuth = authRequests;
    const composed = await invoke('decide', { ...identity, requestId: 'restore-composer', decision: 'choose', purpose: 'composer',
      snapshotId: restored.evidence.snapshotId, ref: composer.ref });
    assert.equal(composed.isError, false, JSON.stringify(composed));
    assert.ok(authRequests > beforePrepareAuth, 'actual preparation retains its authentication check');
    assert.equal(await restoredPage.locator('textarea').inputValue(), 'Preserve this exact request');
    assert.equal(await restoredPage.evaluate(() => (window as any).submits), 0);
    assert.equal(service.database.raw.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n, 1);
    assert.equal(service.database.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='generation.submit-attempted'").get()!.n, 0);
    const beforeLostPage = service.teamDirectory.getSession(initial.sessionId);
    const pagesBeforeRead = service.pageRegistry.listBindings().length;
    owner.createPage = async () => { throw new Error('A status read must not create a provider page'); };
    await restoredPage.close();
    const lost = await inspect();
    const waited = await invoke('wait', { teamId: identity.teamId, requestRefs: [identity.requestRef], waitMs: 1 });
    assert.equal(waited.isError, false, JSON.stringify(waited));
    for (const current of [lost, (waited.structuredContent.results as any[])[0]]) {
      assert.equal(current.requestRef, initial.requestRef);
      assert.equal(current.generation, initial.generation);
      assert.equal(current.submissionState, 'prepared');
      assert.equal(current.promptSubmitted, false);
      assert.equal(current.evidence, null);
      assert.equal(current.inspectionError.errorCode, 'browser.unavailable');
    }
    assert.equal(service.pageRegistry.listBindings().length, pagesBeforeRead);
    assert.deepEqual(service.teamDirectory.getSession(initial.sessionId), beforeLostPage);
  } finally {
    await service.close();
    await closeOwner();
    rmSync(root, { recursive: true, force: true });
  }
});

test('first send returns observed combinations; subsequent requests select an ID without rediscovery or submission', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-configuration-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({ config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const owner = service.browserOwner!;
  const pages: import('playwright-core').Page[] = [];
  const createPage = owner.createPage.bind(owner);
  owner.createPage = async (...args) => {
    const created = await createPage(...args);
    pages.push(created.page);
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    return created;
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const result = await invokeMcpTool({ name: `sessionplane_${name}`, arguments: args,
      socketPath: config.socketPath, timeoutMs: 30000, maxLineBytes: config.rpcMaxLineBytes });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent;
  };
  try {
    const team = await invoke('team_create', { requestId: 'catalog-team', provider: 'chatgpt' });
    const roles = team.roles as { roleRef: string }[];
    const first = await invoke('send', { teamId: team.teamId, roleRef: roles[0]!.roleRef,
      requestId: 'catalog-first', prompt: 'Do not submit during discovery', model: 'Aurora-8 / Deep' });
    const catalog = first.configurationCatalog as ConfigurationCatalog;
    assert.equal(catalog.status, 'available', JSON.stringify(catalog));
    assert.equal(catalog.options.length, 6);
    assert.deepEqual(catalog.unavailableVersions, ['Unavailable-7']);
    const option = catalog.options.find(o => o.label === 'Aurora-8 / Deep')!;
    assert.ok(option);
    const page = pages.find(p => p.url() === 'https://chatgpt.com/')!;
    await page.waitForFunction(() => document.querySelector('#chooser')?.textContent === 'Balanced', undefined, { timeout: 5_000 });
    assert.equal(await page.locator('#chooser').innerText(), 'Balanced', 'discovery restores configuration');
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(first.promptSubmitted, false);
    const selected = await invoke('decide', { teamId: team.teamId, requestRef: first.requestRef,
      requestId: 'catalog-select', decision: 'configure', configurationId: option.id });
    assert.equal((selected.choices as { model: { text: string } }).model.text, option.label);
    assert.equal((selected.choices as { model: { configurationVersion?: string } }).model.configurationVersion, option.version);
    assert.equal(selected.promptSubmitted, false);
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
    const evidence = selected.evidence as { snapshotId: string; nodes: { ref: string; role: string }[] };
    const composed = await invoke('decide', { teamId: team.teamId, requestRef: first.requestRef,
      requestId: 'catalog-compose', decision: 'choose', purpose: 'composer', snapshotId: evidence.snapshotId,
      ref: evidence.nodes.find(n => n.role === 'textbox')!.ref });
    assert.equal(await page.locator('textarea').inputValue(), 'Do not submit during discovery');
    assert.match(String(composed.message), /submit control/);
    assert.equal(composed.promptSubmitted, false);

    const nextTeam = await invoke('team_create', { requestId: 'catalog-team-second', provider: 'chatgpt' });
    const next = await invoke('send', { teamId: nextTeam.teamId, roleRef: (nextTeam.roles as { roleRef: string }[])[0]!.roleRef,
      requestId: 'catalog-second', prompt: 'Another draft', model: option.label });
    assert.deepEqual((next.configurationCatalog as ConfigurationCatalog).options.map(o => o.id), catalog.options.map(o => o.id));
    
    const nextPage = pages.find(p => p !== page && p.url() === 'https://chatgpt.com/')!;
    assert.equal(await nextPage.evaluate(() => (window as any).opens), 0, 'cached discovery does not traverse again');
    await invoke('decide', { teamId: nextTeam.teamId, requestRef: next.requestRef,
      requestId: 'catalog-second-select', ...((next.configurationCatalog as any).options.find((o: any) => o.id === option.id).selection) });
    assert.equal(await nextPage.locator('#summary').innerText(), option.label);

    const compactTeam = await invoke('team_create', { requestId: 'catalog-team-compact', provider: 'chatgpt' });
    const compact = await invoke('send', { teamId: compactTeam.teamId, roleRef: (compactTeam.roles as { roleRef: string }[])[0]!.roleRef,
      requestId: 'catalog-compact', prompt: 'Verify a compact chooser label', model: 'Aurora-9 / Deep' });
    const compactOption = (compact.configurationCatalog as ConfigurationCatalog).options.find(o => o.label === 'Aurora-9 / Deep')!;
    const compactSelected = await invoke('decide', { teamId: compactTeam.teamId, requestRef: compact.requestRef,
      requestId: 'catalog-compact-select', decision: 'configure', configurationId: compactOption.id });
    assert.equal((compactSelected.choices as { model: { text: string } }).model.text, 'Deep');
    const compactEvidence = compactSelected.evidence as typeof evidence;
    const compactComposed = await invoke('decide', { teamId: compactTeam.teamId, requestRef: compact.requestRef,
      requestId: 'catalog-compact-compose', decision: 'choose', purpose: 'composer', snapshotId: compactEvidence.snapshotId,
      ref: compactEvidence.nodes.find(n => n.role === 'textbox')!.ref });
    assert.match(String(compactComposed.message), /submit control/);
    assert.equal(compactComposed.promptSubmitted, false);

    await nextPage.evaluate(() => { (window as any).labels[2] = 'Changed'; });
    const stale = await invokeMcpTool({ name: 'sessionplane_decide', arguments: {
      teamId: nextTeam.teamId, requestRef: next.requestRef, requestId: 'catalog-drift', decision: 'configure', configurationId: option.id },
      socketPath: config.socketPath, timeoutMs: 30000, maxLineBytes: config.rpcMaxLineBytes });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.errorCode, 'provider.configuration-stale');
    assert.equal(await nextPage.evaluate(() => (window as any).submits), 0);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed discovery stays on its request and does not poison another request or a successful catalog', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-configuration-isolation-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({ config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const owner = service.browserOwner!;
  const createPage = owner.createPage.bind(owner);
  const pages: import('playwright-core').Page[] = [];
  owner.createPage = async (...args) => {
    const created = await createPage(...args);
    const body = pages.length === 0 ? fixture.replace('String(option.textContent === window.version)', "'false'")
      : fixture.replace('<textarea aria-label', '<textarea id="pending-home-input" aria-label')
        .replace("document.querySelector('textarea').onfocus = () => setTimeout(() => { chooser.hidden = false; }, 120);",
          "document.querySelector('textarea').onfocus = event => { const next = document.createElement('textarea'); next.setAttribute('aria-label', 'Prompt'); event.target.replaceWith(next); setTimeout(() => { chooser.hidden = false; }, 120); };");
    pages.push(created.page);
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body }));
    return created;
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const r = await invokeMcpTool({ name: `sessionplane_${name}`, arguments: args,
      socketPath: config.socketPath, timeoutMs: 30000, maxLineBytes: config.rpcMaxLineBytes });
    assert.equal(r.isError, false, JSON.stringify(r));
    return r.structuredContent as any;
  };
  try {
    const failedTeam = await invoke('team_create', { requestId: 'isolation-failed-team', provider: 'chatgpt' });
    const failed = await invoke('send', { teamId: failedTeam.teamId, roleRef: failedTeam.roles[0].roleRef,
      requestId: 'isolation-failed', prompt: 'Unsubmitted diagnostic' });
    assert.equal(failed.configurationCatalog.status, 'unavailable');
    const healthyTeam = await invoke('team_create', { requestId: 'isolation-healthy-team', provider: 'chatgpt' });
    const healthy = await invoke('send', { teamId: healthyTeam.teamId, roleRef: healthyTeam.roles[0].roleRef,
      requestId: 'isolation-healthy', prompt: 'Unsubmitted diagnostic' });
    assert.equal(healthy.configurationCatalog.status, 'available', 'failed first discovery must not block fresh discovery');
    const repeated = await invoke('decide', { teamId: failedTeam.teamId, requestRef: failed.requestRef,
      requestId: 'isolation-failed-again', decision: 'discover' });
    assert.equal(repeated.configurationCatalog.status, 'unavailable');
    const healthyAgain = await invoke('team_get', { view: 'evidence', teamId: healthyTeam.teamId, requestRef: healthy.requestRef });
    assert.equal(healthyAgain.request.configurationCatalog.status, 'available', 'another page failure must preserve a successful catalog');
    const option = healthyAgain.request.configurationCatalog.options.find((o: any) => o.label === 'Aurora-9 / Deep');
    t.mock.method(ChatGptConfigurationMenu.prototype, 'select', async () => {
      throw new errors.TimeoutError('Configuration click timed out');
    }, { times: 1 });
    const timedOut = await invokeMcpTool({ name: 'sessionplane_decide', arguments: {
      teamId: healthyTeam.teamId, requestRef: healthy.requestRef, requestId: 'isolation-local-timeout', ...option.selection },
      socketPath: config.socketPath, timeoutMs: 30000, maxLineBytes: config.rpcMaxLineBytes });
    assert.equal(timedOut.isError, true);
    assert.equal(timedOut.structuredContent.errorCode, 'browser.unavailable');
    assert.match(String(timedOut.structuredContent.message), /Configuration click timed out/);
    const afterTimeout = await invoke('team_get', { view: 'evidence', teamId: healthyTeam.teamId, requestRef: healthy.requestRef });
    assert.equal(afterTimeout.request.configurationCatalog.status, 'available', 'local click failure must not discard shared observations');
    const selected = await invoke('decide', { teamId: healthyTeam.teamId, requestRef: healthy.requestRef,
      requestId: 'isolation-healthy-select', ...afterTimeout.request.configurationCatalog.options.find((o: any) => o.id === option.id).selection });
    assert.equal(selected.choices.model.text, 'Deep');
    assert.equal(selected.promptSubmitted, false);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout recovery validates fresh summaries, rejects closed-menu evidence and resumes saved Submit exactly once', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-summary-recovery-'));
  const config = { ...resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), submissionAckTimeoutMs: 250 };
  const service = await startCore({ config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const owner = service.browserOwner!;
  const createPage = owner.createPage.bind(owner);
  owner.createPage = async (...args) => {
    const created = await createPage(...args);
    // A previous Pro version is intentional, not a latest-version fallback.
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: fixture.replace('<textarea', '<textarea id="prompt-textarea"').replaceAll('Aurora-8', '5.5').replaceAll('Deep', 'Pro').replaceAll(' / ', ' ')
        .replace('</script>', `document.querySelector('form').addEventListener('submit', () => {
          history.pushState({}, '', '/c/11111111-1111-4111-8111-111111111111');
          const user = document.createElement('div');
          user.setAttribute('data-message-author-role', 'user');
          user.setAttribute('data-message-id', 'summary-fixture-user');
          user.setAttribute('data-turn-id', 'summary-fixture-turn');
          user.textContent = document.querySelector('textarea').value;
          void fetch('/backend-api/conversation', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ id: 'summary-fixture-user', author: { role: 'user' } }] }) });
          document.querySelector('textarea').value = '';
          document.querySelector('main').appendChild(user);
        });</script>`) }));
    return created;
  };
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({
    name: `sessionplane_${name}`, arguments: args, socketPath: config.socketPath,
    timeoutMs: 30_000, maxLineBytes: config.rpcMaxLineBytes });
  const success = async (name: string, args: Record<string, unknown>) => {
    const r = await invoke(name, args);
    assert.equal(r.isError, false, JSON.stringify(r));
    return r.structuredContent as Record<string, any>;
  };
  try {
    const team = await success('team_create', { requestId: 'summary-team' });
    const prompt = 'Keep the original review prompt';
    const pending = await success('send', { teamId: team.teamId, roleRef: team.roles[0].roleRef,
      requestId: 'summary-send', prompt, model: '5.5 Pro' });
    const identity = { teamId: team.teamId, requestRef: pending.requestRef };
    const inspect = async () => (await success('team_get', { ...identity, view: 'evidence' })).request as Record<string, any>;
    // Each recovery decision reads current request state first, as the skill requires.
    const prepared = async () => {
      const q = await inspect();
      assert.equal(q.requestRef, pending.requestRef);
      assert.equal(q.sessionId, pending.sessionId);
      assert.equal(q.generation, pending.generation);
      assert.equal(q.submissionState, 'prepared');
      assert.equal(q.promptSubmitted, false);
      assert.equal(q.terminal, false);
      return q;
    };
    const page = service.pageRegistry.pageForObservation(pending.pageKey);
    const hashes = () => service.database.raw.prepare(
      'SELECT request_hash, session_id, generation FROM outbox WHERE outbox_id = ?').get(pending.requestRef);
    const original = hashes();
    const option = pending.configurationCatalog.options.find((o: any) => o.label === '5.5 Pro');
    assert.ok(option);
    let pickerAttempts = 0;
    t.mock.method(ChatGptConfigurationMenu.prototype, 'select', async () => {
      pickerAttempts++;
      // A timeout can leave the intended configuration already visible.
      await page.evaluate(() => {
        const w = window as any;
        w.version = '5.5'; w.powerValue = 2; w.render();
        (document.querySelector('#chooser') as HTMLButtonElement).click();
      });
      throw new errors.TimeoutError('Fixture configuration click timed out');
    }, { times: 1 });
    await prepared();
    const timedOut = await invoke('decide', { ...identity, requestId: 'summary-timeout',
      decision: 'configure', configurationId: option.id });
    assert.equal(timedOut.structuredContent.errorCode, 'browser.unavailable');
    const choose = async (q: Record<string, any>, purpose: string, node: Record<string, any>, requestId: string) =>
      success('decide', { ...identity, requestId, decision: 'choose', purpose,
        snapshotId: q.evidence.snapshotId, ref: node.ref });
    const q = await prepared();
    assert.equal(q.choices.submit, undefined);
    const summary = q.evidence.nodes.find((n: any) => n.role === 'menuitem' && n.text === '5.5 Pro');
    assert.ok(summary);
    const opens = await page.evaluate(() => (window as any).opens);
    const recovered = await choose(q, 'model', summary, 'summary-model');
    assert.equal(recovered.choices.model.text, '5.5 Pro');
    assert.equal(recovered.promptSubmitted, false);
    assert.equal(await page.evaluate(() => (window as any).opens), opens);
    assert.equal(pickerAttempts, 1, 'recovery does not repeat the failed picker operation');
    const compose = await prepared();
    await choose(compose, 'composer', compose.evidence.nodes.find((n: any) => n.editable), 'summary-composer');
    assert.equal(await page.locator('textarea').inputValue(), prompt);

    // Closing the menu invalidates its old target even though the model is unchanged.
    const beforeClose = await prepared();
    const oldSummary = beforeClose.evidence.nodes.find((n: any) => n.role === 'menuitem' && n.text === '5.5 Pro');
    await page.locator('#chooser').click();
    await page.locator('#configuration').waitFor({ state: 'hidden' });
    await prepared();
    const stale = await invoke('decide', { ...identity, requestId: 'summary-stale-menu', decision: 'choose',
      purpose: 'model', snapshotId: beforeClose.evidence.snapshotId, ref: oldSummary.ref });
    assert.equal(stale.isError, true);
    assert.equal(stale.structuredContent.errorCode, 'browser.snapshot-stale');
    const closed = await prepared();
    assert.equal(closed.choices.model.role, 'menuitem', 'old target is not silently adopted as a new target');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
    const gated = await choose(closed, 'submit', closed.evidence.nodes.find((n: any) => n.submitControl), 'summary-save-submit');
    assert.equal(gated.promptSubmitted, false, 'closed-menu evidence cannot pass pre-submit validation');
    assert.equal(gated.choices.submit.purpose, 'submit');
    assert.equal(service.database.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='generation.submit-attempted'").get()!.n, 0);

    // A changed label cannot be accepted using the previously observed chooser.
    const current = await prepared();
    const chooser = current.evidence.nodes.find((n: any) => n.id === 'chooser');
    await page.evaluate(() => { (window as any).version = 'Aurora-9'; (window as any).render(); });
    await prepared();
    const mismatch = await invoke('decide', { ...identity, requestId: 'summary-changed-model', decision: 'choose',
      purpose: 'model', snapshotId: current.evidence.snapshotId, ref: chooser.ref });
    assert.equal(mismatch.isError, true);
    assert.equal(mismatch.structuredContent.errorCode, 'browser.snapshot-stale');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);

    await page.evaluate(() => { (window as any).version = '5.5'; (window as any).render(); });
    const final = await prepared();
    assert.equal(final.choices.submit.purpose, 'submit');
    const finalChooser = final.evidence.nodes.find((n: any) => n.id === 'chooser');
    assert.equal(finalChooser.text, '5.5 Pro');
    const recovery = { ...identity, requestId: 'summary-current-owner-recovery', decision: 'choose',
      purpose: 'model', snapshotId: final.evidence.snapshotId, ref: finalChooser.ref };
    const submitted = await success('decide', recovery);
    assert.equal(submitted.promptSubmitted, true, 'original Coordinator recovery resumes its saved Submit');
    assert.equal((await inspect()).promptSubmitted, true, 'fresh status excludes any new preparation choice');
    // Replay the identical completed decision receipt only to verify idempotency.
    await success('decide', recovery);
    assert.equal(await page.evaluate(() => (window as any).submits), 1);
    assert.equal(service.database.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='generation.submit-attempted'").get()!.n, 1);
    assert.equal(service.database.raw.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n, 1);
    assert.deepEqual(hashes(), original);
    assert.equal(await page.locator('textarea').inputValue(), '');
    assert.equal(await page.locator('#chooser').innerText(), '5.5 Pro');
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('configuration selection waits for a closing version menu and preserves the draft without submitting', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-menu-closing-'));
  const service = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }),
    browserHeadless: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await service.browserOwner!.createPage();
    await page.setContent(fixture);
    await page.evaluate(() => {
      for (const option of document.querySelectorAll('#versions [role="menuitemradio"]')) {
        option.addEventListener('click', () => {
          // The provider closes its popup after choosing a version, but the
          // outgoing menu remains visible during its exit animation.
          document.querySelector('#chooser')!.setAttribute('aria-expanded', 'false');
          document.querySelector('#chooser')!.removeAttribute('aria-controls');
          setTimeout(() => { (document.querySelector('#configuration') as HTMLElement).hidden = true; }, 120);
        });
      }
    });
    const selected = await new ChatGptConfigurationMenu(page, 'closing-menu').select({
      id: 'fixture', version: 'Aurora-8', power: 2, label: 'Aurora-8 / Deep',
    });
    assert.equal(selected.text, 'Aurora-8 / Deep');
    const again = await new ChatGptConfigurationMenu(page, 'closing-menu').select({
      id: 'fixture', version: 'Aurora-8', power: 2, label: 'Aurora-8 / Deep',
    });
    assert.equal(again.text, selected.text, 'already selected configuration also survives popup closure');
    await page.evaluate(() => {
      const chooser = document.querySelector('#chooser') as HTMLElement;
      const click = chooser.onclick!;
      chooser.onclick = event => {
        click.call(chooser, event);
        if (chooser.getAttribute('aria-expanded') !== 'false') return;
        // Popup removal and persistent summary hydration are separate UI updates.
        setTimeout(() => { chooser.textContent = ''; }, 130);
        setTimeout(() => { (window as any).render(); }, 350);
      };
    });
    const hydrated = await new ChatGptConfigurationMenu(page, 'closing-menu').select({
      id: 'fixture', version: 'Aurora-8', power: 2, label: 'Aurora-8 / Deep',
    });
    assert.equal(hydrated.text, 'Aurora-8 / Deep', 'Configure returns persistent verified evidence, never a blank closing label');
    await page.locator('#configuration').waitFor({ state: 'hidden' });
    const opens = await page.evaluate(() => (window as any).opens);
    await page.evaluate(() => { (document.querySelector('#configuration') as HTMLElement).hidden = false; });
    await assert.rejects(new ChatGptConfigurationMenu(page, 'closing-menu').select({
      id: 'fixture', version: 'Aurora-8', power: 2, label: 'Aurora-8 / Deep',
    }), (error: any) => error.errorCode === 'provider.configuration-unavailable' && error.details.configurationStage === 'menu-exit');
    assert.equal(await page.evaluate(() => (window as any).opens), opens, 'a popup that never exits is not clicked through');
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('configuration selection verifies menu state without waiting for scheduled navigation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-menu-navigation-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({ config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const { page } = await service.browserOwner!.createPage();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route('https://chatgpt.com/pending-menu-frame', async route => {
      await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 3000))]);
      await route.fulfill({ status: 204 }).catch(() => {});
    });
    await page.setContent(fixture);
    await page.locator('textarea').focus();
    await page.locator('#chooser').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      document.querySelector('#chooser')!.addEventListener('click', () => {
        window.location.href = 'https://chatgpt.com/pending-menu-frame';
      }, { once: true });
    });
    // Popup entrance animations can move the controls while an unrelated
    // navigation remains pending. Selection must reach the actual control.
    await page.addStyleTag({ content: `
      @keyframes enter { from { transform: translateY(100px) scale(.9); } to { transform: none; } }
      #configuration:not([hidden]), #versions:not([hidden]) { animation: enter 240ms linear; }
    ` });
    await page.evaluate(() => {
      // While the popup changes layout, its controls are not yet actionable.
      // Early clicks must not be mistaken for a completed menu transition.
      document.addEventListener('click', event => {
        const menu = (event.target as Element).closest('#configuration, #versions');
        if (menu?.getAnimations().some(animation => animation.playState === 'running')) {
          event.stopImmediatePropagation();
        }
      }, true);
    });
    const menu = new ChatGptConfigurationMenu(page, 'navigation-check');
    const selected = await menu.select({ id: 'fixture', version: 'Aurora-9', power: 2, label: 'Aurora-9 / Deep' });
    assert.equal(selected.text, 'Deep');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
  } finally {
    release();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('discovery leaves a version submenu through its chooser when the checked radio has no navigation action', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-selected-radio-'));
  const service = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }),
    browserHeadless: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await service.browserOwner!.createPage();
    await page.setContent(fixture);
    await page.locator('textarea').focus();
    await page.locator('#chooser').click();
    await page.locator('#summary').click();
    await page.evaluate(() => {
      (window as any).checkedClicks = 0;
      document.querySelector('#versions')!.addEventListener('click', event => {
        if ((event.target as Element).getAttribute('aria-checked') === 'true') {
          (window as any).checkedClicks++;
          event.stopImmediatePropagation();
        }
      }, true);
    });
    const catalog = await new ChatGptConfigurationMenu(page, 'selected-radio').discover();
    assert.equal(catalog.status, 'available');
    assert.equal(catalog.options.length, 6);
    assert.equal(await page.evaluate(() => (window as any).checkedClicks), 0);
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
    assert.equal(await page.evaluate(() => (window as any).version), 'Aurora-9');
    assert.equal(await page.evaluate(() => (window as any).powerValue), 1);
    assert.equal(await page.locator('#chooser').getAttribute('aria-expanded'), 'false');
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('discovery exits a persistent version submenu and rejects an unconfirmed version without losing the original draft', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-persistent-version-menu-'));
  const service = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }),
    browserHeadless: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await service.browserOwner!.createPage();
    await page.setContent(fixture);
    await page.evaluate(() => {
      const chooser = document.querySelector('#chooser')!;
      const versions = document.querySelector('#versions') as HTMLElement;
      const menu = document.querySelector('#configuration') as HTMLElement;
      const toggle = (chooser as HTMLElement).onclick!;
      (chooser as HTMLElement).onclick = null;
      chooser.addEventListener('pointerdown', event => {
        // Closing the chooser does not reset the selected submenu route.
        // Selecting the already checked version returns to the main controls.
        if (!versions.hidden) {
          versions.hidden = true; menu.hidden = true;
          chooser.setAttribute('aria-expanded', 'false');
          return;
        }
        toggle.call(chooser, event as MouseEvent);
      });
      // Escape dismisses the popup but retains its submenu route. The exact
      // chooser's close action resets that route after its exit animation.
      document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.stopImmediatePropagation();
        chooser.setAttribute('aria-expanded', 'false');
        versions.hidden = true; menu.hidden = true;
      }, true);
      for (const option of versions.children) {
        const select = (option as HTMLElement).onclick!;
        (option as HTMLElement).onclick = event => {
          if (option.getAttribute('aria-checked') !== 'true') return select.call(option, event);
          // A selected radio dismisses the version popup. Its trigger drops
          // aria-controls before the popup's exit animation unmounts it.
          chooser.setAttribute('aria-expanded', 'false');
          chooser.removeAttribute('aria-controls');
          setTimeout(() => {
            versions.hidden = true;
            chooser.setAttribute('aria-controls', 'configuration');
          }, 180);
        };
        if (option.getAttribute('aria-disabled') === 'true') {
          option.removeAttribute('aria-disabled');
          // A provider access option can be clickable without selecting it.
          (option as HTMLElement).onclick = () => {};
        }
      }
    });
    const menu = new ChatGptConfigurationMenu(page, 'persistent-version-menu');
    const catalog = await menu.discover();
    assert.equal(catalog.status, 'available');
    assert.deepEqual(catalog.unavailableVersions, ['Unavailable-7']);
    assert.ok(catalog.options.some(o => o.label === 'Aurora-9 / Deep'));
    assert.ok(catalog.options.every(o => o.version !== 'Unavailable-7'));
    await page.waitForFunction(() => document.querySelector('#chooser')?.textContent === 'Balanced');
    assert.equal(await page.locator('#chooser').innerText(), 'Balanced');
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
    const selected = await menu.select(catalog.options.find(o => o.label === 'Aurora-9 / Deep')!);
    assert.equal(selected.text, 'Deep');
    await assert.rejects(menu.select({ id: 'unconfirmed', version: 'Unavailable-7', power: 2, label: 'Aurora-9 / Deep' }),
      (error: any) => error.errorCode === 'provider.model-unavailable');
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('failed discovery reports the original transition and restoration failure without exposing the draft', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-menu-failure-details-'));
  const service = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }),
    browserHeadless: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await service.browserOwner!.createPage();
    await page.setContent(fixture);
    await page.evaluate(() => {
      // Neither the chooser nor the checked version dismisses this submenu.
      // Both discovery and restoration fail without exposing the draft.
      (document.querySelector('#versions [aria-checked="true"]') as HTMLElement).onclick = () => {};
      const chooser = document.querySelector('#chooser') as HTMLElement;
      const toggle = chooser.onclick!;
      chooser.onclick = event => {
        if (!(document.querySelector('#versions') as HTMLElement).hidden) return;
        return toggle.call(chooser, event);
      };
    });
    await assert.rejects(new ChatGptConfigurationMenu(page, 'failure-details').discover(), (error: any) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.message, /Discovery failed:.*configuration-state/);
      assert.match(error.message, /restoring original selection failed:/);
      assert.doesNotMatch(error.message, /Untouched draft/);
      return true;
    });
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});


test('continuation reobserves exact current model and effort without switching configuration or losing draft', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-continuation-selection-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({ config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await service.browserOwner!.createPage();
    await page.setContent(fixture);
    await page.locator('#chooser').evaluate(node => { (node as HTMLElement).hidden = false; });
    const menu = new ChatGptConfigurationMenu(page, 'continuation-selection');
    const summary = await menu.reobserveSelection('Aurora-9 Thinking', 'Balanced');
    assert.equal(summary.text, 'Balanced');
    assert.equal(summary.role, 'button');
    assert.equal(summary.expanded, false);
    await assert.rejects(menu.reobserveSelection('Aurora-8', 'Balanced'), /does not match/);
    await assert.rejects(menu.reobserveSelection('Aurora-9', 'Deep'), /does not match/);
    await assert.rejects(menu.reobserveSelection('Aurora-9', 'lanced'), /does not match/);
    // The current provider exposes version in the checked submenu and effort alone in its summary.
    await page.evaluate(() => {
      const combinedRender = (window as any).render;
      (window as any).render = () => {
        combinedRender();
        document.querySelector('#summary')!.textContent = (window as any).labels[(window as any).powerValue];
      };
      (window as any).render();
    });
    assert.equal((await menu.reobserveSelection('Aurora-9 Thinking', 'Balanced')).text, 'Balanced');
    await assert.rejects(menu.reobserveSelection('Aurora-8', 'Balanced'), /does not match/);
    await assert.rejects(menu.reobserveSelection('Aurora-9', 'Deep'), /does not match/);
    await assert.rejects(menu.reobserveSelection('Aurora-9', 'lanced'), /does not match/);
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.deepEqual(await page.evaluate(() => ({ version: (window as any).version,
      power: (window as any).powerValue, submits: (window as any).submits })),
      { version: 'Aurora-9', power: 1, submits: 0 });
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('existing selected-state recording verifies version, effort and Chat without selecting or submitting', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-selected-state-proof-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({ config, browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const create = service.browserOwner!.createPage.bind(service.browserOwner!);
  service.browserOwner!.createPage = async (...args) => {
    const created = await create(...args);
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: fixture.replace('<textarea', '<textarea id="prompt-textarea"') }));
    return created;
  };
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: 'sessionplane_' + name,
    arguments: args, socketPath: config.socketPath, timeoutMs: 30_000, maxLineBytes: config.rpcMaxLineBytes });
  const ok = async (name: string, args: Record<string, unknown>) => {
    const result = await invoke(name, args);
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent as any;
  };
  try {
    const team = await ok('team_create', { requestId: 'selected-team' });
    const sent = await ok('send', { teamId: team.teamId, roleRef: team.roles[0].roleRef,
      requestId: 'selected-send', prompt: 'Preserve this prepared request', model: 'Aurora-9 Thinking', effort: 'Balanced' });
    const identity = { teamId: team.teamId, requestRef: sent.requestRef };
    const page = service.pageRegistry.pageForObservation(sent.pageKey);
    const inspect = async () => (await ok('team_get', { ...identity, view: 'evidence' })).request;
    let seq = 0;
    const choose = async (purpose: string, node?: any, snapshot?: any) => {
      const q = snapshot ?? await inspect();
      node ??= q.evidence.nodes.find((n: any) => purpose === 'model' ? n.id === 'chooser' :
        purpose === 'composer' ? n.editable : n.submitControl);
      return await invoke('decide', { ...identity, requestId: 'selected-choice-' + seq++, decision: 'choose',
        purpose, snapshotId: q.evidence.snapshotId, ref: node.ref });
    };
    const draft = await page.locator('textarea').inputValue();
    await page.evaluate(() => {
      const w = window as any;
      w.selectionClicks = 0; w.draftEvents = 0;
      document.addEventListener('click', e => {
        if ((e.target as Element).closest('[role="menuitemradio"], [role="slider"]')) w.selectionClicks++;
      });
      document.querySelector('textarea')!.addEventListener('input', () => w.draftEvents++);
      // Current provider summaries can expose effort alone.
      const render = w.render;
      w.render = () => { render(); document.querySelector('#summary')!.textContent = w.labels[w.powerValue]; };
      w.version = 'Aurora-8'; w.render();
      // Both versions have the identical footer; that footer alone must not pass.
      document.querySelector('#chooser')!.textContent = 'Balanced';
    });
    const mismatch = await choose('model');
    assert.equal(mismatch.isError, true, 'same effort under the wrong version is not proof');
    assert.equal(mismatch.structuredContent.errorCode, 'provider.configuration-stale');
    assert.equal((await inspect()).choices.model, undefined);
    // Reset only fixture UI state, never through a provider configuration action.
    await page.evaluate(() => {
      const w = window as any; w.version = 'Aurora-9'; w.render();
      (document.querySelector('#versions') as HTMLElement).hidden = true;
      (document.querySelector('#configuration') as HTMLElement).hidden = true;
      document.querySelector('#chooser')!.setAttribute('aria-expanded', 'false');
      document.querySelector('#chooser')!.setAttribute('aria-controls', 'configuration');
    });
    const recorded = await choose('model');
    assert.equal(recorded.isError, false, JSON.stringify(recorded));
    assert.deepEqual((recorded.structuredContent as any).choices.model.configurationVerification,
      { version: 'Aurora-9', effort: 'Balanced', surface: 'chat' });
    assert.equal((recorded.structuredContent as any).promptSubmitted, false);
    assert.equal((recorded.structuredContent as any).choices.submit, undefined);
    assert.equal(await page.locator('textarea').inputValue(), draft);
    assert.deepEqual(await page.evaluate(() => {
      const w = window as any; return [w.selectionClicks, w.draftEvents, w.submits];
    }), [0, 0, 0]);
    // Save a Submit that is still blocked by the absent composer choice. Verification
    // must neither resume it nor restore an older composer over a human draft.
    await choose('submit');
    assert.ok((await inspect()).choices.submit);
    await page.locator('textarea').fill('Preserved newer human draft');
    await page.evaluate(() => { (window as any).draftEvents = 0; });
    const recordOnly = await choose('model');
    assert.equal(recordOnly.isError, false, JSON.stringify(recordOnly));
    assert.equal((recordOnly.structuredContent as any).promptSubmitted, false);
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved newer human draft');
    assert.equal(await page.evaluate(() => (window as any).draftEvents), 0);
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
    await page.locator('textarea').fill(draft);
    // An exact footer can survive version drift after recording. Submission must
    // reverify the full selection instead of trusting that surviving label.
    await page.evaluate(() => {
      const w = window as any; w.version = 'Aurora-8'; w.render();
      document.querySelector('#chooser')!.textContent = 'Balanced';
    });
    const submit = await choose('composer');
    assert.equal(submit.isError, false, JSON.stringify(submit));
    assert.equal((submit.structuredContent as any).errorCode, 'provider.preparation-required');
    assert.match((submit.structuredContent as any).message, /does not match/);
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
    assert.equal((await inspect()).promptSubmitted, false);
    assert.equal((await inspect()).submissionState, 'prepared');
    assert.equal(await page.locator('textarea').inputValue(), 'Preserve this prepared request');
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('strict selected-state reading rejects mode, ambiguity and draft changes without selection fallback', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-selected-state-guards-'));
  const service = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const { page } = await service.browserOwner!.createPage();
    const reset = async () => {
      await page.setContent(fixture.replace('<textarea', '<textarea id="prompt-textarea"')
        .replace('<script>', '<script>(() => {').replace('</script>', '})();</script>'));
      await page.locator('#chooser').evaluate(node => { (node as HTMLElement).hidden = false; });
      await page.evaluate(() => {
        (window as any).selectionClicks = 0;
        document.addEventListener('click', e => {
          if ((e.target as Element).closest('[role="menuitemradio"], [role="slider"]')) (window as any).selectionClicks++;
        });
      });
    };
    const verify = () => new ChatGptConfigurationMenu(page, 'strict-guards').reobserveSelection('Aurora-9 Thinking', 'Balanced', true);
    await reset();
    await page.locator('[role="radio"]').evaluate(node => { node.textContent = 'Work'; });
    await assert.rejects(verify, /Chat mode/);
    assert.equal(await page.evaluate(() => (window as any).opens), 0);
    await reset();
    await page.locator('#summary').evaluate(node => node.addEventListener('click', () =>
      document.querySelectorAll('#versions [role="menuitemradio"]')[1]!.setAttribute('aria-checked', 'true')));
    await assert.rejects(verify, /ambiguous/);
    assert.equal(await page.evaluate(() => (window as any).selectionClicks), 0);
    await reset();
    await assert.rejects(() => new ChatGptConfigurationMenu(page, 'strict-effort').reobserveSelection('Aurora-9', 'Deep', true), /does not match/);
    assert.equal(await page.evaluate(() => (window as any).powerValue), 1);
    await reset();
    await page.locator('#summary').evaluate(node => node.addEventListener('click', () => {
      document.querySelector('textarea')!.value = 'New human draft';
    }));
    await assert.rejects(verify, /draft.*changed/);
    assert.equal(await page.locator('textarea').inputValue(), 'New human draft');
    assert.equal(await page.evaluate(() => (window as any).selectionClicks), 0);
    await reset();
    await page.evaluate(() => {
      // Retained submenu route cannot be dismissed except through a checked
      // option in this provider variant. Verification must refuse that fallback.
      const chooser = document.querySelector('#chooser') as HTMLElement;
      chooser.setAttribute('aria-expanded', 'true'); chooser.setAttribute('aria-controls', 'versions');
      (document.querySelector('#versions') as HTMLElement).hidden = false;
      chooser.onclick = () => {
        const open = chooser.getAttribute('aria-expanded') !== 'true';
        chooser.setAttribute('aria-expanded', String(open));
        chooser.setAttribute('aria-controls', 'versions');
        (document.querySelector('#versions') as HTMLElement).hidden = !open;
        (document.querySelector('#configuration') as HTMLElement).hidden = true;
        (window as any).render();
      };
    });
    await assert.rejects(verify, /without a selection action/);
    assert.equal(await page.evaluate(() => (window as any).selectionClicks), 0);
    assert.equal(await page.evaluate(() => (window as any).submits), 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
