import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { invokeMcpTool, McpToolNotFoundError } from '../../src/mcp/tools.ts';

interface BrowserSnapshot {
  readonly snapshotId: string;
  readonly pageKey: string;
  readonly nodes: readonly Array<{
    readonly ref: string;
    readonly name: string;
  }>;
}

test('internal browser diagnostics remain test-only while public browser tooling is absent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-cli-mcp-'));
  const fixture = await startFixtureServer();
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({
    config,
    browserHeadless: true,
    enableInternalBrowserControlRpc: true,
    logger: silentLogger(),
  });

  try {
    const contradictoryLogin = await runCliJson([
      'login',
      '--manual',
      '--resume',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(contradictoryLogin.code, 2);
    assert.match(contradictoryLogin.stderr, /mutually exclusive/);

    const manualLogin = await runCliJson([
      'login',
      '--manual',
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(manualLogin.code, 1);
    assert.equal(
      (JSON.parse(manualLogin.stderr) as { errorCode: string }).errorCode,
      'browser.manual-login-unavailable',
    );

    const blockedNewTab = await runCliJson([
      'new-tab',
      fixture.url,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(blockedNewTab.code, 2);
    assert.match(blockedNewTab.stderr, /Use Playwright for general browser automation/);

    const browserOwner = service.browserOwner;
    assert.notEqual(browserOwner, null);
    if (browserOwner === null) assert.fail('Expected browser owner');
    const created = await browserOwner.createPage();
    await created.page.goto(fixture.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    service.pageRegistry.refreshPage(created.binding.pageKey);

    const snapshot = (await callRpc({
      socketPath: config.socketPath,
      method: 'browser.snapshot',
      params: { pageKey: created.binding.pageKey, interactive: true, maxNodes: 30 },
      timeoutMs: 5_000,
      maxLineBytes: config.rpcMaxLineBytes,
    })) as BrowserSnapshot;
    const input = snapshot.nodes.find((node) => node.name === 'Name');
    const button = snapshot.nodes.find((node) => node.name === 'Increment');
    assert.notEqual(input, undefined);
    assert.notEqual(button, undefined);

    const typed = await runCliJson([
      'type',
      input?.ref ?? '',
      '--text',
      'Ada',
      '--snapshot-id',
      snapshot.snapshotId,
      '--page',
      snapshot.pageKey,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(typed.code, 2);
    assert.match(typed.stderr, /Use Playwright for general browser automation/);

    await assert.rejects(
      invokeMcpTool({
        name: 'browser_click_ref',
        arguments: {
          pageKey: snapshot.pageKey,
          snapshotId: snapshot.snapshotId,
          ref: button?.ref,
        },
        socketPath: config.socketPath,
        timeoutMs: 5_000,
        maxLineBytes: config.rpcMaxLineBytes,
      }),
      (error: unknown) => error instanceof McpToolNotFoundError,
    );

    const evaluated = await runCliJson([
      'evaluate',
      '--script',
      "document.body.textContent = 'mutated'",
      '--page',
      snapshot.pageKey,
      '--state-dir',
      config.stateDir,
      '--json',
    ]);
    assert.equal(evaluated.code, 2);
    assert.match(evaluated.stderr, /Use Playwright for general browser automation/);

    await callRpc({
      socketPath: config.socketPath,
      method: 'browser.console',
      params: { pageKey: snapshot.pageKey, clear: true },
      timeoutMs: 5_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    await created.page.evaluate(() => {
      for (let index = 0; index < 60; index += 1) console.log('canonical-' + index);
    });
    const canonicalConsole = (await callRpc({
      socketPath: config.socketPath,
      method: 'browser.console',
      params: { pageKey: snapshot.pageKey, clear: false },
      timeoutMs: 5_000,
      maxLineBytes: config.rpcMaxLineBytes,
    })) as { entries: readonly unknown[] };
    assert.equal(
      canonicalConsole.entries.length,
      60,
      'canonical SessionPlane console keeps its all-buffer default',
    );

    await assert.rejects(
      invokeMcpTool({
        name: 'browser_observe_bundle',
        arguments: { pageKey: snapshot.pageKey, includeBoxes: true, maxTextChars: 500 },
        socketPath: config.socketPath,
        timeoutMs: 5_000,
        maxLineBytes: config.rpcMaxLineBytes,
      }),
      (error: unknown) => error instanceof McpToolNotFoundError,
    );

    const publicHelp = await runCliJson(['--help']);
    assert.equal(publicHelp.code, 0, publicHelp.stderr);
    assert.doesNotMatch(publicHelp.stdout, /Browser automation:|new-tab|snapshot|mouse-click/);
    assert.match(publicHelp.stdout, /use Playwright/i);
    assert.doesNotMatch(publicHelp.stdout, /--state-dir/);

    const publicBrowser = await runCliJson(['new-tab', fixture.url, '--json']);
    assert.equal(publicBrowser.code, 2);
    assert.match(publicBrowser.stderr, /Use Playwright for general browser automation/);

    const competingState = path.join(root, 'competing-sessionplane-state');
    const competingServe = await runCliJson([
      'serve',
      '--state-dir',
      competingState,
      '--json',
    ]);
    assert.equal(competingServe.code, 2);
    assert.match(competingServe.stderr, /one canonical runtime state/);
    assert.equal(existsSync(competingState), false);
  } finally {
    await service.close();
    await closeServer(fixture.server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('production core omits generic browser RPC methods', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-provider-only-rpc-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({
    config,
    startBrowser: false,
    logger: silentLogger(),
  });

  try {
    await assert.rejects(
      callRpc({
        socketPath: config.socketPath,
        method: 'browser.tabs',
        params: {},
        timeoutMs: 5_000,
        maxLineBytes: config.rpcMaxLineBytes,
      }),
      (error: unknown) =>
        error instanceof RpcClientError &&
        error.code === -32601 &&
        (error.data as Record<string, unknown>).errorCode === 'input.invalid',
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP team decisions continue the same generation across restart, UI drift and attachment changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-session-ui-'));
  const attachmentPath = path.join(root, 'review.md');
  const acceptedAttachment = 'Review the originally accepted content.';
  writeFileSync(attachmentPath, acceptedAttachment);
  const fixture = `<!doctype html><html><body>
    <form id="composer"><button id="models-button" type="button" aria-label="Submit settings" aria-haspopup="menu">Submit settings</button>
      <button id="effort-button" type="button" aria-expanded="false" aria-haspopup="menu" aria-controls="effort-options">Effort</button>
      <button data-testid="send-button" type="submit" hidden>전송</button><textarea aria-label="Prompt">Provider-restored unrelated draft</textarea>
      <input type="file"><span id="uploaded-name"></span></form>
    <div role="menu" id="models" hidden><div role="menuitem">Model family</div></div>
    <div role="menu" id="effort-options" hidden>
      <input id="effort" aria-label="Reasoning effort" type="range" min="1" max="4" value="1">
      <span id="effort-help">High reasoning effort</span>
    </div>
    <a download="old.txt" href="data:text/plain,OLD">Old unrelated file</a><div id="messages"></div>
    <script>
      window.submitCount = 0;
      document.querySelector('[type=file]').onchange = (event) => {
        document.querySelector('#uploaded-name').textContent = event.target.files[0].name;
      };
      document.querySelector('textarea').addEventListener('input', () => { document.querySelector('[type=submit]').hidden = false; });
      document.querySelector('#models-button').onclick = (event) => {
        event.currentTarget.setAttribute('aria-controls', 'models');
        setTimeout(() => { document.querySelector('#models').hidden = false; }, 350);
      };
      document.querySelector('#effort-button').onclick = (event) => { event.currentTarget.setAttribute('aria-expanded', 'true'); document.querySelector('#effort-options').hidden = false; };
      document.querySelector('[role=menuitem]').onclick = () => {
        document.querySelector('#models').innerHTML = '<div role="menuitemradio" aria-checked="false">Pro</div>';
      };
      document.querySelector('#models').onclick = (event) => {
        if (event.target.getAttribute('role') !== 'menuitemradio') return;
        event.target.setAttribute('aria-checked', 'true');
        document.querySelector('#models-button').textContent = 'Pro';
        document.querySelector('#models').hidden = true;
      };
      document.querySelector('#effort').addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        document.querySelector('#effort-options').hidden = true;
        const button = document.querySelector('#effort-button');
        button.setAttribute('aria-expanded', 'false');
        button.removeAttribute('aria-controls');
        button.textContent = event.currentTarget.value === '4' ? 'High' : 'Standard';
      });
      document.querySelector('#composer').onsubmit = (event) => {
        event.preventDefault();
        window.submitCount += 1;
        history.pushState({}, '', '/c/conversation-123456');
        const user = document.createElement('div');
        user.setAttribute('data-message-author-role', 'user');
        user.setAttribute('data-message-id', 'fixture-user-message');
        user.setAttribute('data-turn-id', 'fixture-user-turn');
        user.textContent = document.querySelector('textarea').value;
        document.querySelector('#messages').appendChild(user);
        const assistant = document.createElement('div');
        assistant.setAttribute('data-message-author-role', 'assistant');
        assistant.setAttribute('data-message-id', 'fixture-assistant-message');
        assistant.setAttribute('data-turn-id', 'fixture-assistant-turn');
        assistant.setAttribute('data-message-status', 'completed');
        assistant.innerHTML = '<div data-testid="message-content">Fixture exact final answer</div><a download="result.txt" href="data:text/plain,EXACT_FILE">File</a>';
        document.querySelector('#messages').appendChild(assistant);
      };
    </script>
  </body></html>`;
  const base = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const config = { ...base, chatgptUrl: 'https://chatgpt.com/', submissionAckTimeoutMs: 250 };
  const start = async () => await startCore({ config, browserHeadless: true, logger: silentLogger() });
  let service: CoreService = await start();
  installPreparationFixtureRoute(service, fixture);
  const invoke = (name: string, args: Record<string, unknown>) => invokeMcpTool({
    name,
    arguments: args,
    socketPath: config.socketPath,
    timeoutMs: 10_000,
    maxLineBytes: config.rpcMaxLineBytes,
  });
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'mcp-ui-test' });
    const session = service.teamDirectory.createSession({
      teamId: team.teamId,
      roleKey: team.primaryRoleKey,
      provider: 'chatgpt',
    });
    const initialView = await invoke('sessionplane_team_get', { teamId: team.teamId });
    const send = { teamId: team.teamId, roleRef: (initialView.structuredContent.roles as Array<{ roleRef: string }>)[0]!.roleRef,
      requestId: 'assisted-send', prompt: 'test', model: 'Pro', effort: 'High', files: [attachmentPath], sessionDeadlineSec: 60 };
    const pending = await invoke('sessionplane_send', send);
    assert.equal(pending.isError, false, JSON.stringify(pending));
    assert.equal(pending.structuredContent.status, 'needs_decision');
    assert.equal(pending.structuredContent.promptSubmitted, false);
    const identity = { teamId: team.teamId, requestRef: pending.structuredContent.requestRef };
    await service.close();
    service = await start();
    installPreparationFixtureRoute(service, fixture);
    writeFileSync(attachmentPath, 'Caller edited the original after acceptance.');

    const inspect = async () => {
      const result = await invoke('sessionplane_team_get', identity);
      assert.equal(result.isError, false, JSON.stringify(result));
      return (result.structuredContent.request as { evidence: { snapshotId: string; pageKey: string; nodes: Array<{ ref: string; role: string; name: string }> } }).evidence;
    };
    const ready = await inspect();
    const evidencePage = service.pageRegistry.pageForObservation(ready.pageKey);
    await evidencePage.evaluate(() => {
      const clutter = document.createElement('div');
      clutter.innerHTML = '<div style="width:1px;height:1px"><svg width="1" height="1"><path d="M0 0L1 1" /></svg></div>'.repeat(1200);
      document.body.prepend(clutter);
    });
    const initial = await inspect();
    assert.ok(Buffer.byteLength(JSON.stringify(initial)) < 64 * 1024, 'Semantic evidence must retain controls without decorative DOM expansion');
    assert.ok(initial.nodes.some((node) => node.role === 'textbox'));
    const opener = initial.nodes.find((n) => n.role === 'button' && n.name === 'Submit settings')!;
    const page = service.pageRegistry.pageForObservation(initial.pageKey);
    await page.locator('#models-button').evaluate((node) => { node.textContent = 'Changed'; });
    const stale = await invoke('sessionplane_decide', { ...identity, requestId: 'stale', decision: 'reveal', purpose: 'model', snapshotId: initial.snapshotId, ref: opener.ref });
    assert.equal(stale.structuredContent.errorCode, 'browser.snapshot-stale');
    assert.equal(await page.locator('#models').isVisible(), false);
    await page.locator('#models-button').evaluate((node) => { node.textContent = 'Submit settings'; });
    let last: Record<string, unknown> = {};
    for (const [purpose, role, name, decision, value] of [
      ['composer', 'textbox', 'Prompt', 'choose'],
      ['model', 'button', 'Submit settings', 'reveal'],
      ['model', 'menuitem', 'Model family', 'reveal'],
      ['model', 'menuitemradio', 'Pro', 'choose'],
      ['effort', 'button', 'Effort', 'reveal'],
      ['effort', 'slider', 'Reasoning effort', 'choose', 4],
      ['effort', 'button', 'High', 'choose'],
      ['submit', 'button', '전송', 'choose'],
    ] as const) {
      if (purpose === 'effort' && role === 'button' && decision === 'choose') {
        await page.locator('#effort-button').evaluate((node) => node.setAttribute('aria-expanded', 'true'));
      }
      const evidence = await inspect();
      const target = evidence.nodes.find((n) => n.role === role && n.name === name);
      assert.ok(target, 'Expected semantic control in fresh evidence');
      const args = { ...identity, requestId: purpose + decision + role, decision, purpose,
        snapshotId: evidence.snapshotId, ref: target.ref, ...(value === undefined ? {} : { value }) };
      const result = await invoke('sessionplane_decide', args);
      assert.equal(result.isError, false, JSON.stringify(result));
      if (purpose === 'composer') assert.equal(await page.locator('textarea').inputValue(), send.prompt);
      last = args;
    }
    const submitted = service.teamDirectory.getSession(session.sessionId);
    assert.equal(submitted.generation, pending.structuredContent.generation);
    assert.equal(submitted.promptSubmitted, true);
    assert.equal(await page.locator('input[type=file]').evaluate(async (el) => await (el as HTMLInputElement).files![0]!.text()), acceptedAttachment);
    assert.equal((await invoke('sessionplane_decide', last)).isError, false);
    let final: { terminal: boolean; answerText: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const waited = await invoke('sessionplane_wait', { teamId: team.teamId, requestRefs: [identity.requestRef], waitMs: 500 });
      final = (waited.structuredContent.results as Array<typeof final>)[0];
      if (final?.terminal) break;
    }
    assert.equal(final?.answerText, 'Fixture exact final answer');
    const fileWait = await invoke('sessionplane_wait', { teamId: team.teamId, requestRefs: [identity.requestRef], waitMs: 0 });
    const files = ((fileWait.structuredContent.results as Array<{ files: { artifacts: Array<{ name: string }> } }>)[0]!).files;
    assert.deepEqual(files.artifacts.map((file) => file.name), ['result.txt']);
    assert.equal(await page.evaluate(() => (window as Window & { submitCount: number }).submitCount), 1);

    const view = await invoke('sessionplane_team_get', { teamId: team.teamId });
    const next = await invoke('sessionplane_send', { teamId: team.teamId,
      roleRef: (view.structuredContent.roles as Array<{ roleRef: string }>)[0]!.roleRef,
      requestId: 'missing-upload', prompt: 'Next review', files: [attachmentPath] });
    rmSync(path.join(config.stateDir, 'submission-inputs'), { recursive: true, force: true });
    const nextEvidence = next.structuredContent.evidence as typeof initial;
    const composer = nextEvidence.nodes.find((n) => n.role === 'textbox')!;
    const rejected = await invoke('sessionplane_decide', { teamId: team.teamId, requestRef: next.structuredContent.requestRef,
      requestId: 'missing-upload-choice', decision: 'choose', purpose: 'composer', snapshotId: nextEvidence.snapshotId, ref: composer.ref });
    assert.equal(rejected.structuredContent.errorCode, 'input.invalid');
    const failed = await invoke('sessionplane_wait', { teamId: team.teamId, requestRefs: [next.structuredContent.requestRef], waitMs: 0 });
    const result = (failed.structuredContent.results as Array<Record<string, unknown>>)[0]!;
    assert.equal(result.terminal, true);
    assert.equal(result.submissionState, 'failed_pre_submit');
    assert.equal(result.promptSubmitted, false);
    const freshTeam = await invoke('sessionplane_team_get', { teamId: team.teamId });
    const replacement = await invoke('sessionplane_session_replace', { teamId: team.teamId, requestId: 'replace',
      roleRef: (freshTeam.structuredContent.roles as Array<{ roleRef: string }>)[0]!.roleRef });
    const cancellable = await invoke('sessionplane_send', { teamId: team.teamId, requestId: 'cancel-send', prompt: 'Cancel this preparation',
      roleRef: (replacement.structuredContent.roles as Array<{ roleRef: string }>)[0]!.roleRef });
    const cancelArgs = { teamId: team.teamId, requestId: 'cancel-request', requestRef: cancellable.structuredContent.requestRef };
    const cancelled = await invoke('sessionplane_stop', cancelArgs);
    assert.equal(cancelled.isError, false);
    assert.equal(cancelled.structuredContent.promptSubmitted, false);
    assert.equal(cancelled.structuredContent.terminal, true);
    assert.equal((await invoke('sessionplane_stop', cancelArgs)).isError, false);


  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MCP inspects an ambiguous caller-directed submission without resend and recovers a later exact acknowledgement', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-ambiguous-inspection-'));
  const config = { ...resolveConfig({ cwd: root, env: {}, stateDir: '.state' }), chatgptUrl: 'https://chatgpt.com/', submissionAckTimeoutMs: 100 };
  const service = await startCore({ config, browserHeadless: true, logger: silentLogger() });
  installPreparationFixtureRoute(service, `<!doctype html><form>
    <textarea id="prompt-textarea"></textarea><button type="submit">Send</button></form>
    <main><div id="messages"></div></main><script>
      document.querySelector('form').onsubmit = (event) => {
        event.preventDefault(); history.pushState({}, '', '/c/conversation-123456');
      };
    </script>`);
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'inspection-owner' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await assert.rejects(callRpc({
      socketPath: config.socketPath, method: 'session.send',
      params: { clientId: 'inspection-owner', requestId: 'original', sessionId: session.sessionId, prompt: 'Exact pending draft', sessionDeadlineSec: 30 },
    }), (error: unknown) => error instanceof RpcClientError &&
      (error.data as { errorCode?: string }).errorCode === 'provider.preparation-required');
    const prepared = service.teamDirectory.getSession(session.sessionId);
    const caller = { clientId: 'inspection-owner', requestId: 'original', sessionId: session.sessionId, generation: prepared.generation };
    for (const purpose of ['composer', 'submit']) {
      const observed = await callRpc<{ snapshotId: string; nodes: Array<{ ref: string; role: string; editable: boolean; name: string }> }>({
        socketPath: config.socketPath, method: 'session.preparation.inspect', params: caller,
      });
      const target = observed.nodes.find((node) => purpose === 'composer' ? node.editable && node.role === 'textbox' : node.role === 'button' && node.name === 'Send');
      assert.ok(target);
      await callRpc({ socketPath: config.socketPath, method: 'session.preparation.decide', params: {
        ...caller, decisionId: purpose, decision: 'choose', purpose, snapshotId: observed.snapshotId, ref: target.ref,
      } });
    }
    await assert.rejects(callRpc({ socketPath: config.socketPath, method: 'session.preparation.resume', params: caller }),
      (error: unknown) => error instanceof RpcClientError && (error.data as { errorCode?: string }).errorCode === 'session.submission-unknown');
    const sent = service.teamDirectory.getSession(session.sessionId);
    assert.equal(sent.submissionState, 'submission_unknown');
    // Exercise explicit inspection with the background recovery service stopped.
    await service.recoveryService.close();
    const page = service.pageRegistry.pageForObservation(sent.pageKey!);
    const view = await callRpc<{ requests: Array<{ requestRef: string }> }>({ socketPath: config.socketPath, method: 'workflow.team_get', params: { teamId: team.teamId } });
    const identity = { teamId: team.teamId, requestRef: view.requests[0]!.requestRef };
    const inspect = () => invokeMcpTool({ name: 'sessionplane_team_get', arguments: identity,
      socketPath: config.socketPath, timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes });
    const pending = await inspect();
    assert.equal(pending.isError, false);
    const snapshot = pending.structuredContent.request as { submissionState: string; generation: number; evidence: { nodes: Array<{ editable: boolean; value: string }> } };
    assert.equal(snapshot.submissionState, 'submission_unknown');
    assert.equal(snapshot.generation, sent.generation);
    assert.ok(snapshot.evidence.nodes.some((node) => node.editable && node.value === 'Exact pending draft'));
    assert.equal(await page.locator('textarea').inputValue(), 'Exact pending draft');
    assert.equal(await page.locator('[data-message-author-role]').count(), 0);

    // A delayed provider acknowledgement arrives; inspection must bind it, never submit again.
    await page.locator('#messages').evaluate((messages) => {
      messages.innerHTML = '<div data-message-author-role="user" data-message-id="delayed-user">Exact pending draft</div>' +
        '<div data-message-author-role="assistant" data-message-id="delayed-answer" data-message-status="completed">Recovered final</div>' +
        '<aside role="alert">Stream interrupted<button>Retry</button></aside>';
    });
    const recovered = await inspect();
    assert.equal(recovered.isError, false);
    assert.equal((recovered.structuredContent.request as { submittedUserMessageId: string }).submittedUserMessageId, 'delayed-user');
    let alerted: { reason: string; terminal: boolean; evidence?: { nodes: Array<{ role: string }> } } | undefined;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const waited = await invokeMcpTool({ name: 'sessionplane_wait', arguments: { teamId: identity.teamId, requestRefs: [identity.requestRef], waitMs: 100 },
        socketPath: config.socketPath, timeoutMs: 10_000, maxLineBytes: config.rpcMaxLineBytes });
      assert.equal(waited.isError, false);
      alerted = (waited.structuredContent.results as Array<NonNullable<typeof alerted>>)[0];
      if (alerted?.reason === 'provider-actionable-alert') break;
    }
    assert.equal(alerted?.reason, 'provider-actionable-alert');
    assert.equal(alerted?.terminal, false);
    assert.ok(alerted?.evidence?.nodes.some((node) => node.role === 'alert'));
    const current = await inspect();
    assert.ok((current.structuredContent.request as NonNullable<typeof alerted>).evidence?.nodes.some((node) => node.role === 'alert'));
    await page.locator('[role="alert"]').evaluate((node) => node.remove());
    let final = service.teamDirectory.getSession(session.sessionId);
    for (let attempt = 0; attempt < 20 && !final.terminal; attempt += 1) {
      final = await callRpc<typeof final>({ socketPath: config.socketPath, method: 'session.wait', params: { clientId: 'inspection-owner', sessionId: session.sessionId, generation: sent.generation, waitMs: 500 } });
    }
    assert.equal(final.generation, sent.generation);
    assert.equal(final.answerText, 'Recovered final');
    assert.equal(await page.locator('[data-message-author-role="user"]').count(), 1);
    assert.equal(await page.locator('textarea').inputValue(), 'Exact pending draft');
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class CaptureWritable extends Writable {
  value = '';

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

async function runCliJson(argv: readonly string[]) {
  const stdout = new CaptureWritable();
  const stderr = new CaptureWritable();
  const code = await runCli(argv, {
    stdin: Readable.from([]),
    stdout,
    stderr,
  });
  return { code, stdout: stdout.value.trim(), stderr: stderr.value.trim() };
}

async function startFixtureServer(html?: string): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html ?? `<!doctype html>
      <html>
        <head><title>CLI MCP Browser Fixture</title></head>
        <body>
          <label for="name">Name</label>
          <input id="name" type="text">
          <button id="increment" type="button">Increment</button>
          <script>
            window.count = 0;
            document.querySelector('#increment').addEventListener('click', () => {
              window.count += 1;
            });
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fixture server did not expose a TCP port');
  }
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

function installPreparationFixtureRoute(service: CoreService, html: string): void {
  const owner = service.browserOwner;
  assert.notEqual(owner, null);
  if (owner === null) assert.fail('Expected the core-owned browser');
  const createPage = owner.createPage.bind(owner);
  owner.createPage = async () => {
    const created = await createPage();
    await created.page.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    });
    return created;
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
