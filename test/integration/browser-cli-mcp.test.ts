import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

test('MCP preparation decisions inspect, reveal, select, and resume the original generation once', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-session-ui-'));
  const fixture = `<!doctype html><html><body>
    <form id="composer"><button id="models-button" type="button" aria-label="Submit settings" aria-haspopup="menu" aria-controls="models">Submit settings</button>
      <button id="effort-button" type="button" aria-haspopup="menu" aria-controls="effort-options">Effort</button>
      <button data-testid="send-button" type="submit">전송</button><textarea aria-label="Prompt"></textarea></form>
    <div role="menu" id="models" hidden><div role="menuitemradio" aria-checked="false">Pro</div></div>
    <div role="menu" id="effort-options" hidden>
      <input id="effort" aria-label="Reasoning effort" type="range" min="1" max="4" value="1" aria-valuetext="Standard" aria-describedby="effort-help">
      <span id="effort-help">High reasoning effort</span>
    </div>
    <div id="messages"></div>
    <script>
      window.submitCount = 0;
      document.querySelector('#models-button').onclick = () => { document.querySelector('#models').hidden = false; };
      document.querySelector('#effort-button').onclick = () => { document.querySelector('#effort-options').hidden = false; };
      document.querySelector('[role=menuitemradio]').onclick = (event) => {
        event.currentTarget.setAttribute('aria-checked', 'true');
        document.querySelector('#models-button').textContent = 'Pro';
        document.querySelector('#models').hidden = true;
      };
      document.querySelector('#effort').addEventListener('input', (event) => {
        event.currentTarget.setAttribute('aria-valuetext', event.currentTarget.value === '4' ? 'High' : 'Standard');
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
        assistant.innerHTML = '<div data-testid="message-content">Fixture exact final answer</div>';
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
    arguments: { clientId: 'mcp-ui-test', ...args },
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
    let handoffDetails: Record<string, unknown> | undefined;
    await assert.rejects(callRpc({
      socketPath: config.socketPath,
      method: 'session.send',
      params: {
        clientId: 'mcp-ui-test', requestId: 'assisted-send', sessionId: session.sessionId,
        prompt: 'test', model: 'Pro', effort: 'High', assistedPreparation: true, sessionDeadlineSec: 30,
      },
      timeoutMs: 30_000,
      maxLineBytes: config.rpcMaxLineBytes,
    }), (error: unknown) => {
      if (!(error instanceof RpcClientError)) return false;
      const data = error.data as { errorCode?: string; details?: Record<string, unknown> };
      handoffDetails = data.details;
      return data.errorCode === 'provider.preparation-required';
    });

    const pending = service.teamDirectory.getSession(session.sessionId);
    assert.equal(handoffDetails?.requestId, 'assisted-send');
    assert.equal(handoffDetails?.sessionId, session.sessionId);
    assert.equal(handoffDetails?.generation, pending.generation);
    assert.equal((handoffDetails?.snapshot as { promptSubmitted?: boolean } | undefined)?.promptSubmitted, false);
    assert.equal(pending.promptSubmitted, false);
    assert.equal(pending.submissionState, 'prepared');

    // A restarted core must discard prior choices and make the caller inspect the reopened page.
    await service.close();
    service = await start();
    installPreparationFixtureRoute(service, fixture);
    const prematureResume = await invoke('sessionplane_preparation_resume', {
      requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation,
    });
    assert.equal(prematureResume.structuredContent.errorCode, 'provider.preparation-required');

    await assert.rejects(callRpc({
      socketPath: config.socketPath,
      method: 'session.send',
      params: {
        clientId: 'mcp-ui-test', requestId: 'assisted-send', sessionId: session.sessionId,
        prompt: 'test', model: 'Pro', effort: 'High', assistedPreparation: true, sessionDeadlineSec: 30,
      },
      timeoutMs: 30_000,
      maxLineBytes: config.rpcMaxLineBytes,
    }), (error: unknown) => error instanceof RpcClientError &&
      (error.data as { errorCode?: string }).errorCode === 'provider.preparation-required');
    const competingClient = await invoke('sessionplane_preparation_inspect', {
      clientId: 'other-client', requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation,
    });
    assert.equal(competingClient.structuredContent.errorCode, 'session.generation-superseded');
    const wrong = await invoke('sessionplane_preparation_inspect', {
      requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation + 1,
    });
    assert.equal(wrong.structuredContent.errorCode, 'session.generation-superseded');

    const initial = await invoke('sessionplane_preparation_inspect', {
      requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation,
    });
    assert.equal(initial.isError, false);
    const initialNodes = initial.structuredContent.nodes as Array<{ ref: string; role: string; name: string }>;
    const opener = initialNodes.find((node) => node.role === 'button' && node.name === 'Submit settings');
    assert.notEqual(opener, undefined);
    assert.equal(initialNodes.some((node) => node.role === 'menuitemradio'), false);
    const page = service.pageRegistry.pageForObservation(initial.structuredContent.pageKey as string);
    await page.evaluate(() => { document.querySelector('#models-button')!.textContent = 'Changed'; });
    const changedControl = await invoke('sessionplane_preparation_decide', {
      requestId: 'assisted-send', decisionId: 'changed-opener', decision: 'reveal', purpose: 'model',
      sessionId: session.sessionId, generation: pending.generation,
      snapshotId: initial.structuredContent.snapshotId, ref: opener?.ref,
    });
    assert.equal(changedControl.structuredContent.errorCode, 'browser.snapshot-stale');
    assert.equal(await page.locator('#models').isVisible(), false);
    await page.evaluate(() => { document.querySelector('#models-button')!.textContent = 'Submit settings'; });
    const currentInitial = await invoke('sessionplane_preparation_inspect', {
      requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation,
    });
    const currentOpener = (currentInitial.structuredContent.nodes as Array<{ ref: string; role: string; name: string }>)
      .find((node) => node.role === 'button' && node.name === 'Submit settings');
    assert.notEqual(currentOpener, undefined);
    const revealed = await invoke('sessionplane_preparation_decide', {
      requestId: 'assisted-send', decisionId: 'reveal-model-menu', decision: 'reveal', purpose: 'model',
      sessionId: session.sessionId, generation: pending.generation,
      snapshotId: currentInitial.structuredContent.snapshotId, ref: currentOpener?.ref,
    });
    assert.equal(revealed.isError, false, JSON.stringify(revealed.structuredContent));
    const stale = await invoke('sessionplane_preparation_decide', {
      requestId: 'assisted-send', decisionId: 'stale-choice', decision: 'choose', purpose: 'model',
      sessionId: session.sessionId, generation: pending.generation,
      snapshotId: currentInitial.structuredContent.snapshotId, ref: currentOpener?.ref,
    });
    assert.equal(stale.structuredContent.errorCode, 'browser.snapshot-stale', JSON.stringify(stale.structuredContent));
    const observed = await invoke('sessionplane_preparation_inspect', {
      requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation,
    });
    const inspectedPage = service.pageRegistry.pageForObservation(observed.structuredContent.pageKey as string);
    const observedModel = (observed.structuredContent.nodes as Array<{ ref: string; role: string; name: string }>)
      .find((node) => node.role === 'menuitemradio' && node.name === 'Pro');
    assert.notEqual(observedModel, undefined);
    await inspectedPage.evaluate(() => { document.querySelector('[role=menuitemradio]')!.textContent = 'Changed'; });
    const changedChoice = await invoke('sessionplane_preparation_decide', {
      requestId: 'assisted-send', decisionId: 'changed-model-label', decision: 'choose', purpose: 'model',
      sessionId: session.sessionId, generation: pending.generation,
      snapshotId: observed.structuredContent.snapshotId, ref: observedModel?.ref,
    });
    assert.equal(changedChoice.structuredContent.errorCode, 'browser.snapshot-stale');
    assert.equal(await inspectedPage.locator('[role=menuitemradio]').getAttribute('aria-checked'), 'false');
    await inspectedPage.evaluate(() => { document.querySelector('[role=menuitemradio]')!.textContent = 'Pro'; });

    const decideFromFreshInspection = async (
      decisionId: string,
      purpose: string,
      role: string,
      name: string,
      decision: 'choose' | 'reveal' = 'choose',
      value?: number,
    ) => {
      const fresh = await invoke('sessionplane_preparation_inspect', {
        requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation,
      });
      const target = (fresh.structuredContent.nodes as Array<{ ref: string; role: string; name: string }>)
        .find((node) => node.role === role && node.name === name);
      assert.notEqual(target, undefined, `${purpose} control missing from fresh inspection`);
      return await invoke('sessionplane_preparation_decide', {
        requestId: 'assisted-send', decisionId, decision, purpose,
        sessionId: session.sessionId, generation: pending.generation,
        snapshotId: fresh.structuredContent.snapshotId, ref: target?.ref,
        ...(value === undefined ? {} : { value }),
      });
    };
    assert.equal((await decideFromFreshInspection('choose-model', 'model', 'menuitemradio', 'Pro')).isError, false);
    assert.equal((await decideFromFreshInspection('reveal-effort', 'effort', 'button', 'Effort', 'reveal')).isError, false);
    assert.equal((await decideFromFreshInspection('choose-effort', 'effort', 'slider', 'Reasoning effort', 'choose', 4)).isError, false);
    assert.equal((await decideFromFreshInspection('choose-composer', 'composer', 'textbox', 'Prompt')).isError, false);
    assert.equal((await decideFromFreshInspection('choose-send', 'submit', 'button', '전송')).isError, false);
    const resumed = await invoke('sessionplane_preparation_resume', {
      requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation,
    });
    assert.equal(resumed.isError, false);
    const completedAttempt = service.teamDirectory.getSession(session.sessionId);
    assert.equal(completedAttempt.generation, pending.generation);
    assert.equal(completedAttempt.promptSubmitted, true);
    assert.equal(completedAttempt.submissionState, 'submitted');
    const submittedPage = service.pageRegistry.pageForObservation(completedAttempt.pageKey!);
    assert.equal(await submittedPage.evaluate(() => (window as Window & { submitCount: number }).submitCount), 1);
    const replayResume = await invoke('sessionplane_preparation_resume', {
      requestId: 'assisted-send', sessionId: session.sessionId, generation: pending.generation,
    });
    assert.deepEqual(replayResume.structuredContent, resumed.structuredContent);
    let final: { readonly terminal: boolean; readonly latestEventSequence: number; readonly answerText: string | null; readonly responseMessageId: string | null } | null = null;
    let cursor = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const waited = await invoke('sessionplane_wait', {
        sessionId: session.sessionId, generation: pending.generation, afterEventSequence: cursor, waitMs: 500,
      });
      final = waited.structuredContent as typeof final;
      cursor = Math.max(cursor, final.latestEventSequence);
      if (final.terminal) break;
    }
    assert.equal(final?.terminal, true);
    assert.equal(final?.answerText, 'Fixture exact final answer');
    assert.equal(final?.responseMessageId, 'fixture-assistant-message');
    assert.equal(await submittedPage.evaluate(() => (window as Window & { submitCount: number }).submitCount), 1);
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
