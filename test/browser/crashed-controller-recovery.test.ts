import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium, type ConnectOverCDPOptions, type ConnectOverCDPTransport } from 'playwright-core';
import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

test('same-target controller recovery preserves Chrome, request binding, saved draft and sibling generation', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-crash-controller-'));
  const registry = new PageRegistry();
  const owner = new BrowserOwner({ profileDir: path.join(root, 'profile'), pageRegistry: registry, headless: true });
  let loads = 0;
  let redirect = false;
  const server = createServer((request, response) => {
    if (request.url === '/original') {
      loads++;
      if (redirect) { response.writeHead(302, { Location: '/unexpected' }); response.end(); return; }
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/original'
      ? '<textarea></textarea><script>document.querySelector("textarea").value=sessionStorage.getItem("draft")||""</script>'
      : '<textarea>Sibling saved draft</textarea><div id="generation">0</div><script>setInterval(()=>document.querySelector("#generation").textContent=String(Number(document.querySelector("#generation").textContent)+1),20)</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await owner.start();
    const original = await owner.createPage();
    await original.page.goto(`http://127.0.0.1:${port}/original`);
    registry.reservePage(original.binding.pageKey, { sessionId: 'retained-request-session', generation: 17 });
    await original.page.evaluate(() => { sessionStorage.setItem('draft', 'Retained provider-saved draft'); });
    const sibling = await owner.createPage();
    await sibling.page.goto(`http://localhost:${port}/sibling`);
    const browserPid = owner.status.browserPid;
    const browser = await sibling.page.context().browser()!.newBrowserCDPSession();
    const inventory = async () => (await browser.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page').map(t => t.targetId).sort();
    const before = await inventory();
    const expected = registry.getBinding(original.binding.pageKey);
    const crash = async (page: typeof original.page) => {
      // Keep a real protocol callback pending when Inspector.targetCrashed
      // rejects callbacks. A late error response must not terminate the core.
      const pending = page.evaluate(() => new Promise<void>(() => {})).catch(error => error);
      const control = await page.context().newCDPSession(page);
      const event = page.waitForEvent('crash', { timeout: 5000 });
      void control.send('Page.crash').catch(() => {});
      await event;
      assert.match(String(await pending), /crash|closed/i);
      // The crash command can leave this diagnostic session pending; owner shutdown disposes it.
    };
    await crash(original.page);
    await assert.rejects(original.page.reload({ timeout: 1000 }), /crash/i);
    await assert.rejects(owner.recoverCrashedPage(expected.pageKey, { ...expected, targetId: 'wrong-target' }), /Exact crashed target/);
    assert.equal(loads, 1, 'Identity refusal does not dispatch reload');
    const generationBefore = Number(await sibling.page.locator('#generation').textContent());
    const siblingControl = await sibling.page.context().newCDPSession(sibling.page);
    const siblingTarget = (await siblingControl.send('Target.getTargetInfo')).targetInfo.targetId;
    await siblingControl.detach();
    // Reproduce a sibling whose emulation command never acknowledges. Actual
    // Chrome still handles all other initialization and page operations.
    const connect = chromium.connectOverCDP.bind(chromium);
    const stalledDefaults: number[] = [];
    const recoveryConnection = t.mock.method(chromium, 'connectOverCDP', async (endpoint: string, options: ConnectOverCDPOptions) => {
      const version = await (await fetch(`${endpoint}/json/version`)).json() as { webSocketDebuggerUrl: string };
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      const siblings = new Set<string>();
      const transport: ConnectOverCDPTransport = {
        send(message: object) {
          const command = message as { id: number; method: string; sessionId?: string };
          if (command.sessionId && siblings.has(command.sessionId) && command.method.startsWith('Emulation.')) {
            stalledDefaults.push(command.id);
            return;
          }
          socket.send(JSON.stringify(message));
        },
        close() { socket.close(); },
      };
      socket.addEventListener('message', event => {
        const message = JSON.parse(String(event.data));
        if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.targetId === siblingTarget)
          siblings.add(message.params.sessionId);
        transport.onmessage?.(message);
      });
      socket.addEventListener('close', () => transport.onclose?.());
      return await connect(transport, options);
    });
    await owner.recoverCrashedPage(expected.pageKey, expected);
    recoveryConnection.mock.restore();
    assert.deepEqual(stalledDefaults, [], 'Recovery never reconfigures sibling focus or media');
    const recovered = registry.pageForObservation(expected.pageKey);
    assert.notEqual(recovered, original.page, 'Only the controller Page object is replaced');
    const after = registry.getBinding(expected.pageKey);
    assert.equal(after.pageKey, expected.pageKey);
    assert.equal(after.targetId, expected.targetId);
    assert.equal(after.sessionId, expected.sessionId);
    assert.equal(after.generation, 17);
    assert.equal(after.url, expected.url);
    assert.equal(after.bindingEpoch, expected.bindingEpoch + 1);
    assert.equal(registry.observedCrash(expected.pageKey), null);
    assert.equal(await recovered.locator('textarea').inputValue(), 'Retained provider-saved draft');
    assert.equal(await sibling.page.locator('textarea').inputValue(), 'Sibling saved draft');
    assert.ok(Number(await sibling.page.locator('#generation').textContent()) > generationBefore);
    assert.equal(loads, 2);
    assert.equal(owner.status.browserPid, browserPid);
    assert.deepEqual(await inventory(), before);
    // A same-target redirect is not accepted as the original conversation.
    await crash(recovered);
    redirect = true;
    await assert.rejects(owner.recoverCrashedPage(after.pageKey, after), /original binding retained|Crashed target changed/);
    assert.equal(registry.pageForObservation(after.pageKey), recovered, 'Failed recovery does not adopt a different conversation');
    assert.ok(registry.observedCrash(after.pageKey));
    assert.equal(owner.status.browserPid, browserPid);
    assert.deepEqual(await inventory(), before);
    assert.equal(await sibling.page.locator('textarea').inputValue(), 'Sibling saved draft');
    await browser.detach();
  } finally {
    await owner.close();
    server.closeAllConnections(); server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
