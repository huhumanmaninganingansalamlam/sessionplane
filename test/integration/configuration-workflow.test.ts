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
      const response = await invoke('team_get', identity);
      assert.equal(response.isError, false, JSON.stringify(response));
      return response.structuredContent.request as Record<string, any>;
    };
    const initial = await inspect();
    const option = initial.configurationCatalog.options.find((o: any) => o.label === 'Aurora-8 / Deep');
    assert.ok(option);
    const page = service.pageRegistry.pageForObservation(initial.pageKey);
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
    const composed = await invoke('decide', { ...identity, requestId: 'restore-composer', decision: 'choose', purpose: 'composer',
      snapshotId: restored.evidence.snapshotId, ref: composer.ref });
    assert.equal(composed.isError, false, JSON.stringify(composed));
    assert.equal(await restoredPage.locator('textarea').inputValue(), 'Preserve this exact request');
    assert.equal(await restoredPage.evaluate(() => (window as any).submits), 0);
    assert.equal(service.database.raw.prepare('SELECT COUNT(*) AS n FROM outbox').get()!.n, 1);
    assert.equal(service.database.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='generation.submit-attempted'").get()!.n, 0);
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
    const inspect = async () => (await success('team_get', identity)).request as Record<string, any>;
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
