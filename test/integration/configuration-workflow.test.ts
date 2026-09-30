import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { errors } from 'playwright-core';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import type { ConfigurationCatalog } from '../../src/providers/chatgpt/configuration-catalog.ts';
import { ChatGptConfigurationMenu } from '../../src/providers/chatgpt/configuration-catalog.ts';

const fixture = `<!doctype html><html><body><main><form>
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
    assert.equal(await page.locator('#chooser').innerText(), 'Balanced', 'discovery restores configuration');
    assert.equal(await page.locator('textarea').inputValue(), 'Untouched draft');
    assert.equal(first.promptSubmitted, false);
    const selected = await invoke('decide', { teamId: team.teamId, requestRef: first.requestRef,
      requestId: 'catalog-select', decision: 'configure', configurationId: option.id });
    assert.equal((selected.choices as { model: { text: string } }).model.text, option.label);
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
    const healthyAgain = await invoke('team_get', { teamId: healthyTeam.teamId, requestRef: healthy.requestRef });
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
    const afterTimeout = await invoke('team_get', { teamId: healthyTeam.teamId, requestRef: healthy.requestRef });
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
