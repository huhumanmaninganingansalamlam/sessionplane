import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test('public project/task and MCP use exactly the same Core over an SSH stdio relay', {
  timeout: 70_000,
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sp-public-ssh-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const previousPath = process.env.PATH;
  const executable = path.join(root, 'remote-sessplane');
  const cli = path.resolve('src/cli/main.ts');
  writeFileSync(executable,
    '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) +
    ' --experimental-strip-types ' + JSON.stringify(cli) + ' "$@"\n',
    { mode: 0o700 });
  const ssh = path.join(bin, 'ssh');
  writeFileSync(ssh, '#!/bin/sh\n' +
    'case " $* " in *" BatchMode=yes "*) ;; *) exit 73 ;; esac\n' +
    'case " $* " in *" StrictHostKeyChecking=yes "*) ;; *) exit 74 ;; esac\n' +
    'for arg do cmd="$arg"; done\nexec /bin/sh -c "$cmd"\n', { mode: 0o700 });
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.remote' });
  let core = await startCore({ config, startBrowser: false, logger });
  process.env.PATH = bin + path.delimiter + previousPath;
  const remote = { host: 'fixture-remote', executable, socketPath: config.socketPath };
  const viaRemote = (method: string, params: object, override = remote) => callRpc<any>({
    socketPath: '/fixture-no-client-core.sock', remote: override,
    method, params, timeoutMs: 12_000, maxLineBytes: config.rpcMaxLineBytes,
  });
  const viaLocal = (method: string, params: object) => callRpc<any>({
    socketPath: config.socketPath, method, params, timeoutMs: 12_000,
    maxLineBytes: config.rpcMaxLineBytes,
  });
  const clientId = 'public-ssh-owner';
  try {
    const health = await viaRemote('system.health', {});
    assert.equal(health.database.path, config.databasePath);
    assert.equal(health.browser.state, 'not_started');
    const projectArgs = {
      clientId, requestId: 'ssh-open-1', projectKey: 'public-ssh',
      displayName: 'Public remote fixture', provider: 'chatgpt',
      surfaceIntent: 'chat', modelIntent: 'Pro',
    };
    const project = await viaRemote('project.open', projectArgs);
    assert.equal((await viaLocal('project.open', projectArgs)).projectId, project.projectId,
      'Remote and local clients share a single project mapping');
    const startArgs = {
      clientId, requestId: 'ssh-start-1', projectId: project.projectId,
      expectedConversationRevision: project.conversationRevision,
      prompt: 'Retained exact one-time SSH fixture prompt',
    };
    const first = await viaRemote('task.start', startArgs);
    assert.equal(first.taskId, (await viaLocal('task.start', startArgs)).taskId);
    const task = await viaLocal('task.get', {
      clientId, taskId: first.taskId, view: 'evidence',
    });
    assert.equal(task.submission.attempted, false);
    assert.equal(task.submission.acknowledged, false);
    assert.equal(task.evidence.attempts.length, 1);
    const mcp = await invokeMcpTool({
      remote, name: 'sessionplane_task_get',
      arguments: { clientId, taskId: first.taskId, view: 'evidence' },
      socketPath: '/fixture-no-client-core.sock',
      timeoutMs: 12_000, maxLineBytes: config.rpcMaxLineBytes,
    });
    assert.equal(mcp.isError, false);
    assert.equal(mcp.structuredContent.taskId, first.taskId);
    assert.equal(mcp.structuredContent.evidence.attempts.length, 1);
    const waited = await viaRemote('task.wait', {
      clientId, taskId: first.taskId, afterRevision: task.revision, waitMs: 0,
    });
    assert.equal(waited.revision, task.revision);
    const cancelArgs = { clientId, taskId: first.taskId, requestId: 'ssh-cancel-1' };
    const cancel = await viaRemote('task.cancel', cancelArgs);
    assert.equal(cancel.state, 'canceled');
    assert.equal(cancel.cancelOutcome, 'not_submitted');
    assert.deepEqual(await viaLocal('task.cancel', cancelArgs), cancel);
    await core.close();
    core = await startCore({ config, startBrowser: false, logger });
    assert.equal((await viaRemote('task.get', {
      clientId, taskId: first.taskId, view: 'evidence',
    })).evidence.attempts.length, 1);
    assert.deepEqual(await viaRemote('task.cancel', cancelArgs), cancel);
    assert.equal((await viaLocal('project.open', projectArgs)).projectId,
      project.projectId);
    await assert.rejects(
      viaRemote('system.health', {}, {
        ...remote, socketPath: path.join(root, 'missing-core.sock'),
      }),
      (error: RpcClientError) => {
        assert.equal((error.data as any)?.details?.requestDispatched, false);
        return true;
      },
    );
    writeFileSync(ssh, '#!/bin/sh\n' +
      'echo "Permission denied (publickey)" >&2\nexit 255\n', { mode: 0o700 });
    await assert.rejects(viaRemote('task.get', {
      clientId, taskId: first.taskId,
    }), (error: RpcClientError) => {
      assert.equal((error.data as any)?.details?.requestDispatched, false);
      return true;
    });
    writeFileSync(ssh, [
      '#!/bin/sh',
      `printf '%s\\n' '{"sessionplaneRemote":1}'`,
      'read request || exit 1',
      'echo "fixture disconnected after receipt" >&2',
      'exit 255',
      '',
    ].join('\n'), { mode: 0o700 });
    await assert.rejects(viaRemote('task.get', {
      clientId, taskId: first.taskId,
    }), (error: RpcClientError) => {
      assert.equal((error.data as any)?.details?.requestDispatched, true);
      return true;
    });
    assert.equal((await viaLocal('task.get', {
      clientId, taskId: first.taskId, view: 'evidence',
    })).evidence.attempts.length, 1,
    'Disconnected client cannot cause a second original attempt');
  } finally {
    process.env.PATH = previousPath;
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});
