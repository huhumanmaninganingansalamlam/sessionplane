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
import { startCore } from '../../src/main.ts';
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

test('MCP model UI actions stay on the exact failed pre-submit generation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-session-ui-'));
  const fixture = await startFixtureServer(`<!doctype html><html><body>
    <form><button type="button" aria-label="Models" aria-haspopup="menu" aria-controls="models">Models</button>
      <button type="submit">Send</button><textarea aria-label="Prompt"></textarea></form>
    <div role="menu" id="models"><div role="menuitemradio" aria-checked="false">Pro</div>
      <span role="status">Current model</span></div>
    <script>document.querySelector('[role=menuitemradio]').onclick = (event) => {
      event.currentTarget.setAttribute('aria-checked', 'true');
      document.querySelector('[role=status]').textContent = 'Selected Pro';
    };</script>
  </body></html>`);
  const base = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const config = { ...base, chatgptUrl: fixture.url };
  const service = await startCore({ config, browserHeadless: true, logger: silentLogger() });
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
    await assert.rejects(callRpc({
      socketPath: config.socketPath,
      method: 'session.send',
      params: {
        clientId: 'mcp-ui-test', requestId: 'missing-model', sessionId: session.sessionId,
        prompt: 'test', model: 'Unavailable', sessionDeadlineSec: 30,
      },
      timeoutMs: 10_000,
      maxLineBytes: config.rpcMaxLineBytes,
    }), (error: unknown) => error instanceof RpcClientError &&
      (error.data as { errorCode?: string }).errorCode === 'provider.model-unavailable');

    const failed = service.teamDirectory.getSession(session.sessionId);
    assert.equal(failed.promptSubmitted, false);
    assert.equal(failed.submissionState, 'failed_pre_submit');
    const wrong = await invoke('sessionplane_session_ui_inspect', {
      sessionId: session.sessionId, generation: failed.generation + 1,
    });
    assert.equal(wrong.structuredContent.errorCode, 'session.generation-superseded');

    const inspected = await invoke('sessionplane_session_ui_inspect', {
      sessionId: session.sessionId, generation: failed.generation,
    });
    assert.equal(inspected.isError, false);
    const nodes = inspected.structuredContent.nodes as Array<{ ref: string; role: string }>;
    assert.equal(nodes.some((node) => node.role === 'textbox'), false);
    assert.equal(nodes.filter((node) => node.role === 'button').length, 1);
    const choice = nodes.find((node) => node.role === 'menuitemradio');
    assert.notEqual(choice, undefined);
    const actionArgs = {
      requestId: 'select-model', sessionId: session.sessionId, generation: failed.generation,
      snapshotId: inspected.structuredContent.snapshotId, ref: choice?.ref,
      action: 'click',
    };
    const staleGeneration = await invoke('sessionplane_session_ui_action', {
      ...actionArgs, requestId: 'wrong-generation', generation: failed.generation + 1,
    });
    assert.equal(staleGeneration.structuredContent.errorCode, 'session.generation-superseded');
    const selected = await invoke('sessionplane_session_ui_action', actionArgs);
    assert.equal(selected.isError, false);
    const replay = await invoke('sessionplane_session_ui_action', actionArgs);
    assert.deepEqual(replay.structuredContent, selected.structuredContent);
  } finally {
    await service.close();
    await closeServer(fixture.server);
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
