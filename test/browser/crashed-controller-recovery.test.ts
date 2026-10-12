import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { PageRegistry } from '../../src/browser/page-registry.ts';

test('same-target controller recovery preserves Chrome, request binding, saved draft and sibling generation', async () => {
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
      const control = await page.context().newCDPSession(page);
      const event = page.waitForEvent('crash', { timeout: 5000 });
      void control.send('Page.crash').catch(() => {});
      await event;
      // The crash command can leave this diagnostic session pending; owner shutdown disposes it.
    };
    await crash(original.page);
    await assert.rejects(original.page.reload({ timeout: 1000 }), /crash/i);
    await assert.rejects(owner.recoverCrashedPage(expected.pageKey, { ...expected, targetId: 'wrong-target' }), /Exact crashed target/);
    assert.equal(loads, 1, 'Identity refusal does not dispatch reload');
    const generationBefore = Number(await sibling.page.locator('#generation').textContent());
    await owner.recoverCrashedPage(expected.pageKey, expected);
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
