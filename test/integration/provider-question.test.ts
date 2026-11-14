import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { runCli } from '../../src/cli/main.ts';
import { invokeMcpTool, MCP_TOOLS } from '../../src/mcp/tools.ts';
import { ChatGptConfigurationMenu } from '../../src/providers/chatgpt/configuration-catalog.ts';

test('owned question answer restores preparation without sending the saved prompt; guards and receipts span CLI/MCP', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-owned-question-'));
  const core = await startCore({ config: resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), browserHeadless: true,
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const create = core.browserOwner!.createPage.bind(core.browserOwner);
  t.mock.method(ChatGptConfigurationMenu.prototype, 'discover', async () => ({ status: 'unavailable' as const,
    observedAt: new Date().toISOString(), options: [], unavailableVersions: [], message: 'Question fixture has no model chooser' }));
  t.mock.method(core.browserOwner!, 'createPage', async (...args) => {
    const created = await create(...args);
    await created.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: `<main>
      <div data-message-author-role="user" data-message-id="old-ack">Original message</div>
      <textarea id="initial-composer"></textarea><button id="chat" role="radio" aria-checked="true">Chat</button>
      <section id="question" hidden data-codex-composer-request-navigation="true" data-user-input-auto-resolution="true">
        <p>Which authorized disposition should be relayed?</p><div role="radiogroup">
          <button role="radio" type="button" aria-label="Wait (Recommended)">Wait</button>
          <button role="radio" type="button" aria-label="Leave running">Leave running</button>
          <button role="radio" type="button" aria-label="Disabled answer" disabled>Disabled answer</button>
        </div><div contenteditable="true" role="textbox"></div>
      </section><script>window.answers=0;window.sends=0;
        document.querySelectorAll('[role=radio]').forEach(button=>button.onclick=()=>{
          window.answers++;document.querySelector('#question').hidden=true;
          document.querySelector('main').insertAdjacentHTML('beforeend','<textarea id="prompt-textarea"></textarea><button data-testid="send-button" onclick="window.sends++">Send</button>');
        });</script></main>` }));
    return created;
  });
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({ name: 'sessionplane_' + name,
    arguments: args, socketPath: core.config.socketPath, timeoutMs: 10000, maxLineBytes: core.config.rpcMaxLineBytes });
  try {
    const variants = MCP_TOOLS.find(tool => tool.name === 'sessionplane_decide')!.inputSchema.anyOf as any[];
    assert.ok(variants.find(v => v.properties.decision.const === 'answer_question'));
    const team = (await invoke('team_create', { requestId: 'question-team' })).structuredContent as any;
    const sent = await invoke('send', { teamId: team.teamId, roleRef: team.roles[0].roleRef,
      requestId: 'prepared-question', prompt: 'Exact saved follow-up; do not send yet' });
    assert.equal(sent.isError, false, JSON.stringify(sent));
    const identity = { teamId: team.teamId, requestRef: sent.structuredContent.requestRef };
    const read = async () => (await invoke('team_get', { ...identity, view: 'evidence' })).structuredContent.request as any;
    const page = core.pageRegistry.pageForObservation((await read()).pageKey);
    await page.locator('#initial-composer, #chat').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    await page.locator('#question').evaluate(node => node.removeAttribute('hidden'));
    const current = await read();
    assert.equal(current.promptSubmitted, false);
    assert.equal(current.evidence.preparationAvailability.available, false);
    assert.equal(current.evidence.providerQuestion.available, true, JSON.stringify(current.evidence));
    const evidenceHash = current.evidence.providerQuestion.evidenceHash;
    const decide = (requestId: string, extra = {}) => invoke('decide', { ...identity, requestId,
      decision: 'answer_question', answer: 'Leave running', evidenceHash, ...extra });
    for (const [id, extra] of [['stale', { evidenceHash: '0'.repeat(64) }], ['disabled', { answer: 'Disabled answer' }],
      ['unobserved', { answer: 'invented answer' }]] as const) {
      assert.equal((await decide(id, extra)).structuredContent.errorCode, 'provider.question-unverified');
    }
    const foreign = (await invoke('team_create', { requestId: 'foreign-team' })).structuredContent as any;
    assert.equal((await decide('wrong-owner', { teamId: foreign.teamId })).isError, true);
    await page.locator('[contenteditable]').fill('Preserve my question draft');
    assert.equal((await decide('draft')).structuredContent.errorCode, 'provider.question-unverified');
    assert.equal(await page.locator('[contenteditable]').innerText(), 'Preserve my question draft');
    await page.locator('[contenteditable]').fill('');
    await page.locator('main').evaluate(main => main.insertAdjacentHTML('beforeend',
      '<div id="mode" role="group"><button aria-pressed="false">Chat</button><button aria-pressed="true">Work</button></div>'));
    assert.equal((await decide('work')).structuredContent.errorCode, 'provider.preparation-required');
    assert.equal((await read()).evidence.providerQuestion.available, false);
    await page.locator('#mode').evaluate(node => node.remove());
    for (const markup of ['<div role="dialog">Permission</div>', '<button data-testid="stop-button">Stop</button>']) {
      await page.locator('main').evaluate((main, markup) => main.insertAdjacentHTML('beforeend', markup), markup);
      assert.equal((await decide('blocked-' + markup)).structuredContent.errorCode, 'provider.question-unverified');
      await page.locator('[role=dialog], [data-testid=stop-button]').evaluate(node => node.remove());
    }
    const held = t.mock.method(core.submissionService, 'isObservationHeld', () => true);
    assert.equal((await decide('held')).structuredContent.errorCode, 'provider.preparation-required');
    held.mock.restore();
    assert.equal(await page.evaluate(() => (window as any).answers), 0);
    // A successful CLI answer never enters choose/submit or rewrites the saved payload.
    const before = core.database.raw.prepare('SELECT payload_json FROM outbox WHERE outbox_id=?').get(identity.requestRef as string);
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
    const args = ['request', 'answer_question', team.teamId, String(identity.requestRef), '--answer', 'Leave running',
      '--evidence-hash', evidenceHash, '--request-id', 'answer-once', '--socket', core.config.socketPath, '--json'];
    assert.equal(await runCli(args, { stdin: Readable.from([]), stdout: stream, stderr: stream }), 0, output);
    const answered = JSON.parse(output);
    assert.equal(answered.questionAnswer.outcome, 'answered');
    assert.equal(answered.promptSubmitted, false);
    assert.deepEqual((await decide('answer-once')).structuredContent, answered, 'Identical cross-client receipt replay must not click again');
    assert.equal((await decide('answer-once', { answer: 'Wait (Recommended)' })).structuredContent.errorCode, 'input.idempotency-conflict');
    const after = await read();
    assert.equal(after.evidence.preparationAvailability.available, true);
    assert.equal(after.evidence.observedSurface.source, 'chat-default');
    assert.equal(after.evidence.providerQuestion, null);
    assert.equal(after.promptSubmitted, false);
    assert.deepEqual(core.database.raw.prepare('SELECT payload_json FROM outbox WHERE outbox_id=?').get(identity.requestRef as string), before);
    assert.equal(await page.locator('#prompt-textarea').inputValue(), '');
    assert.deepEqual(await page.evaluate(() => [(window as any).answers, (window as any).sends]), [1, 0]);
    assert.equal(await page.locator('[data-message-author-role=user]').count(), 1);
    // Unknown click is durable and cannot be retried under the same operation identity.
    await page.locator('#question').evaluate(node => { node.removeAttribute('hidden');
      for (const button of node.querySelectorAll('button')) button.onclick = () => { (window as any).answers++; }; });
    assert.equal((await decide('unknown-click')).structuredContent.errorCode, 'provider.action-unknown');
    assert.equal((await decide('unknown-click')).structuredContent.errorCode, 'provider.action-unknown');
    assert.equal(await page.evaluate(() => (window as any).answers), 2);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
