import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../../src/cli/main.ts';
import { writeCliResult, writeCliError } from '../../src/cli/format.ts';
import { RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

function capture() {
  let stdout = '', stderr = '';
  const io = { stdin: Readable.from([]),
    stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
    stderr: new Writable({ write(chunk, _encoding, done) { stderr += String(chunk); done(); } }) };
  return { io, result: () => ({ stdout, stderr }) };
}

test('subcommand help never dispatches login or other mutations, while explicit login still works', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cli-help-'));
  const socketPath = path.join(root, 'core.sock');
  const requests: Array<{ method: string; params: unknown }> = [];
  const server = createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.split('\n')[0]!);
      requests.push({ method: request.method, params: request.params });
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { requestOk: true } })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    for (const args of [
      ['login', '--help'], ['login', '-h'], ['login', '--manual', '--help'],
      ['login', '--resume', '--help'], ['team', 'delete', 'retained-team', '--help'],
      ['serve', '--help'], ['--help'], ['help'], [],
    ]) {
      const output = capture();
      const code = await runCli([...args, '--socket', socketPath], output.io);
      assert.deepEqual(requests, [], `help must not dispatch: ${args.join(' ')}`);
      assert.equal(code, 0, output.result().stderr);
      assert.match(output.result().stdout, /Usage:/);
      assert.equal(output.result().stderr, '');
    }
    const output = capture();
    assert.equal(await runCli(['login', '--json', '--socket', socketPath], output.io), 0);
    assert.deepEqual(requests, [{ method: 'browser.login', params: { mode: 'automated' } }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('human CLI collects an exact answer, preserves unknown delivery and reports independent cleanup', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-human-cli-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Original answer retained.';
  const core = await startCore({ config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const cli = async (...args: string[]) => {
    const output = capture();
    const code = await runCli([...args, '--socket', config.socketPath], output.io);
    return { code, ...output.result() };
  };
  try {
    const created = await cli('team', 'create', '--name', 'Human flow fixture', '--json');
    assert.equal(created.code, 0, created.stderr);
    const team = JSON.parse(created.stdout);
    const sessionRun = await cli('session', 'create', team.teamId, 'main', '--request-id', 'human-session', '--json');
    assert.equal(sessionRun.code, 0, sessionRun.stderr);
    const session = JSON.parse(sessionRun.stdout);
    const ready = await cli('session', 'create', team.teamId, 'main', '--request-id', 'human-session');
    assert.equal(ready.code, 0, ready.stderr);
    assert.match(ready.stdout, /Nothing has been submitted/);
    assert.ok(ready.stdout.includes(`request send ${team.teamId} ${session.sessionId}:0`));
    const view = await cli('team', 'show', team.teamId);
    assert.match(view.stdout, /Human flow fixture/);
    assert.match(view.stdout, /request send/);
    const sent = await cli('request', 'send', team.teamId, `${session.sessionId}:0`, '--prompt', 'A single fixture question', '--request-id', 'human-send', '--json');
    assert.equal(sent.code, 0, sent.stderr);
    const request = JSON.parse(sent.stdout);
    assert.ok(request.requestRef);
    const result = await cli('request', 'wait', team.teamId, request.requestRef, '--wait-ms', '1000');
    assert.match(result.stdout, /Answer collected/);
    assert.match(result.stdout, /Original answer retained/);
    assert.equal(fake.submitCount, 1);
    const missing = await cli('request', 'wait', team.teamId, '11111111-1111-4111-8111-111111111111', '--wait-ms', '0');
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /Failed:/);
    assert.match(missing.stdout, /Inspect: sessplane request show/);
    fake.acknowledgementMode = 'missing';
    const next = await cli('request', 'send', team.teamId, request.roleRef, '--prompt', 'Unknown fixture delivery', '--request-id', 'human-unknown', '--json');
    assert.equal(next.code, 1, next.stderr);
    const unknown = JSON.parse(next.stderr).details;
    const inspected = await cli('request', 'show', team.teamId, unknown.requestRef);
    assert.match(inspected.stdout, /Unconfirmed — do not resend/);
    assert.doesNotMatch(inspected.stdout, /Answer collected/);
    assert.equal(fake.submitCount, 2, 'inspection must not resend');
    const denied = await cli('request', 'delete', team.teamId, request.requestRef);
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /outputs-retrieved/);
    const deleted = await cli('team', 'delete', team.teamId, '--request-id', 'human-cleanup');
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.match(deleted.stdout, /Team: deleted/);
    assert.match(deleted.stdout, /Chats:/);
    assert.match(deleted.stdout, /Tabs:/);
    assert.equal(fake.submitCount, 2);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('preparation displays selectable controls and exact continuation commands without claiming submission', () => {
  const output = capture();
  const input = { teamId: 'team', request: { requestRef: 'request', submissionState: 'prepared', terminal: false,
    configurationCatalog: { selectionAvailable: true, options: [{ id: 'model-id', label: 'Pro · Extended' }] },
    evidence: { snapshotId: 'snapshot', nodes: [{ name: 'Message', ref: '@e1', actions: { choose: ['composer'] } },
      { name: 'Send', ref: '@e2', actions: { choose: ['submit'] } }] } } };
  writeCliResult(output.io, false, input);
  assert.match(output.result().stdout, /Not confirmed sent/);
  assert.match(output.result().stdout, /configure team request model-id/);
  assert.match(output.result().stdout, /choose team request submit @e2 --snapshot-id snapshot/);
  const blocked = capture();
  writeCliResult(blocked.io, false, { ...input, request: { ...input.request, configurationCatalog: { ...input.request.configurationCatalog, selectionAvailable: false } } });
  assert.doesNotMatch(blocked.result().stdout, /configure team request model-id/);
  const json = capture(); writeCliResult(json.io, true, input);
  assert.deepEqual(JSON.parse(json.result().stdout), input);
});

test('timeout, provider failure and partial cleanup never masquerade as generation or deletion success', () => {
  const waiting = capture();
  writeCliResult(waiting.io, false, { teamId: 'team', results: [{ requestRef: 'request', submissionState: 'submitted', terminal: false, waitExpired: true }] });
  assert.match(waiting.result().stdout, /request itself has not been canceled/);
  assert.match(waiting.result().stdout, /request wait team request/);
  const failure = capture();
  writeCliResult(failure.io, false, { requestRef: 'r', terminal: true, submissionState: 'submitted', answerText: null, errorCode: 'provider.thinking-failed' });
  assert.match(failure.result().stdout, /Ended without a collected answer/);
  const error = capture();
  writeCliError(error.io, false, new RpcClientError(-32000, 'No exact acknowledgement', { errorCode: 'session.submission-unknown', details: { teamId: 'team', requestRef: 'request' } }));
  assert.match(error.result().stderr, /request show team request/);
  assert.match(error.result().stderr, /do not send it again/);
  const cleanup = capture();
  writeCliResult(cleanup.io, false, { deleted: true, sessions: [{ providerDeleted: false, providerError: 'provider.unavailable', closedPages: 1, pageErrors: [] }] });
  assert.match(cleanup.result().stdout, /0 deletion confirmed; 1 failed/);
  assert.match(cleanup.result().stdout, /Tabs: 1 closed/);
  const replacement = capture();
  writeCliResult(replacement.io, false, { sessionId: 'successor', cleanup: {
    outcome: 'confirmed', errorCode: null, pageCleanup: { closedPages: 1, pageErrors: [] },
  } });
  assert.match(replacement.result().stdout, /1 deletion confirmed; 0 failed; 0 unconfirmed/);
  assert.match(replacement.result().stdout, /Tabs: 1 closed/);
});

test('a superseded conversation retains its collected original answer without promoting unknown partial text', () => {
  const stored = { requestRef: 'original', terminal: true, submissionState: 'submitted',
    sessionState: 'superseded', providerState: 'complete', responseMessageId: 'original-response',
    answerText: 'The retained original answer.' };
  const output = capture();
  writeCliResult(output.io, false, stored);
  assert.match(output.result().stdout, /Answer collected/);
  assert.match(output.result().stdout, /session is no longer current/);
  assert.match(output.result().stdout, /The retained original answer\./);
  const unknown = capture();
  writeCliResult(unknown.io, false, { ...stored, submissionState: 'submission_unknown' });
  assert.match(unknown.result().stdout, /Unconfirmed — do not resend/);
  assert.doesNotMatch(unknown.result().stdout, /Answer collected|The retained original answer\./);
});
