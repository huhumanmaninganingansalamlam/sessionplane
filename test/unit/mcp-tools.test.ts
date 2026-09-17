import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import {
  MCP_TOOLS,
  McpToolNotFoundError,
  getMcpTool,
  invokeMcpTool,
} from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface SessionSnapshot {
  readonly sessionId: string;
  readonly terminal: boolean;
  readonly waitExpired: boolean;
}

test('MCP tool catalogue exposes unique core mappings and exact selector schemas', () => {
  assert.ok(MCP_TOOLS.length >= 40);
  assert.equal(new Set(MCP_TOOLS.map((tool) => tool.name)).size, MCP_TOOLS.length);
  assert.equal(new Set(MCP_TOOLS.map((tool) => tool.rpcMethod)).size, MCP_TOOLS.length);
  assert.equal(getMcpTool('sessionplane_send')?.rpcMethod, 'session.send');
  assert.equal(getMcpTool('browser_snapshot')?.rpcMethod, 'browser.snapshot');
  assert.equal(getMcpTool('browser_click_ref')?.rpcMethod, 'browser.click');
  assert.equal(getMcpTool('browser_observe_bundle')?.rpcMethod, 'browser.observeBundle');
  assert.equal(getMcpTool('browser_upload_ref')?.rpcMethod, 'browser.upload');
  assert.equal(getMcpTool('browser_network')?.rpcMethod, 'browser.network');
  const sessionCreate = getMcpTool('sessionplane_session_create');
  const providerSchema = (sessionCreate?.inputSchema.properties as Record<string, unknown>)
    .provider as { enum?: readonly string[] };
  assert.deepEqual(providerSchema.enum, ['chatgpt', 'gemini', 'grok']);
  assert.equal(getMcpTool('missing'), null);

  for (const definition of MCP_TOOLS) {
    assert.equal(definition.inputSchema.type, 'object');
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(typeof definition.description, 'string');
  }
});

test('MCP tool invocation preserves nonterminal core snapshots and typed RPC errors', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-mcp-tools-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });

  try {
    const team = await callRpc<TeamSnapshot>({
      socketPath: config.socketPath,
      method: 'team.create',
      params: {
        clientId: 'mcp-tools-client',
        requestId: 'mcp-tools-team',
        primaryRoleKey: 'main',
      },
    });
    const session = await callRpc<SessionSnapshot>({
      socketPath: config.socketPath,
      method: 'session.create',
      params: {
        clientId: 'mcp-tools-client',
        requestId: 'mcp-tools-session',
        teamId: team.teamId,
        roleKey: 'main',
        provider: 'chatgpt',
      },
    });

    const status = await invokeMcpTool({
      name: 'sessionplane_status',
      arguments: {
        clientId: 'mcp-tools-client',
        sessionId: session.sessionId,
      },
      socketPath: config.socketPath,
      timeoutMs: 2_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    assert.equal(status.isError, false);
    assert.equal(status.structuredContent.sessionId, session.sessionId);
    assert.equal(status.structuredContent.terminal, false);

    const missing = await invokeMcpTool({
      name: 'sessionplane_status',
      arguments: {
        clientId: 'mcp-tools-client',
        sessionId: '99999999-9999-4999-8999-999999999999',
      },
      socketPath: config.socketPath,
      timeoutMs: 2_000,
      maxLineBytes: config.rpcMaxLineBytes,
    });
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.requestOk, false);
    assert.equal(missing.structuredContent.errorCode, 'input.session-not-found');

    await assert.rejects(
      invokeMcpTool({
        name: 'sessionplane_missing',
        arguments: {},
        socketPath: config.socketPath,
        timeoutMs: 2_000,
        maxLineBytes: config.rpcMaxLineBytes,
      }),
      (error: unknown) => error instanceof McpToolNotFoundError,
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
