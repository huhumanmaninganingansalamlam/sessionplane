import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { remoteArtifacts } from '../../src/cli/remote-artifacts.ts';

// Subprocess/stdio integration; real SSH authentication is a separate runtime check.
test('remote relay collects exact answers/files without replay and keeps core alive', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-remote-'));
  const oldPath = process.env.PATH;
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nfor arg do command="$arg"; done\nexec /bin/sh -c "$command"\n', { mode: 0o700 });
  const executable = path.join(root, 'sessplane');
  writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' --experimental-strip-types '${path.resolve('src/cli/main.ts')}' "$@"\n`, { mode: 0o700 });
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.remote', observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
  const fake = new FakeProviderAdapter(); fake.autoFinalText = 'Remote answer collected';
  let core = await startCore({ config, startBrowser: false, providerAdapters: [fake], logger: { debug() {}, info() {}, warn() {}, error() {} } });
  process.env.PATH = bin + path.delimiter + oldPath;
  const remote = { host: 'fixture', executable, socketPath: config.socketPath };
  const rpc = <T = any>(method: string, params: object) => callRpc<T>({ socketPath: '/no-host-core', remote, method, params, timeoutMs: 10000 });
  try {
    const team = await rpc('team.create', { clientId: 'remote-test', requestId: 'team', primaryRoleKey: 'main' });
    const session = await rpc('session.create', { clientId: 'remote-test', requestId: 'session', teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const submitted = await rpc('session.send', { clientId: 'remote-test', requestId: 'send', sessionId: session.sessionId, prompt: 'Return fixture file' });
    assert.equal(submitted.generation, 1);
    const done = await rpc('session.wait', { clientId: 'remote-test', sessionId: session.sessionId, generation: 1, waitMs: 3000 });
    assert.equal(done.answerText, 'Remote answer collected');
    const bytes = Buffer.from('remote artifact\n'.repeat(12000));
    fake.addArtifact(session.sessionId, { providerArtifactId: 'file', name: 'result.txt', sourceUrl: 'https://chatgpt.com/file', mediaType: 'text/plain' }, bytes);
    const view = await rpc('workflow.team_get', { teamId: team.teamId });
    const requestRef = view.requests[0].requestRef;
    const outputDir = path.join(root, 'host-downloads');
    const waited = await rpc('workflow.wait', { teamId: team.teamId, requestRefs: [requestRef], waitMs: 0, outputDir });
    assert.equal(waited.results[0].requestRef, requestRef);
    assert.equal(waited.results[0].files.exportError, undefined);
    const exported = waited.results[0].files.exports[0];
    assert.deepEqual(readFileSync(exported.outputPath), bytes);
    writeFileSync(exported.outputPath, 'User file');
    const conflict = await rpc('workflow.wait', { teamId: team.teamId, requestRefs: [requestRef], waitMs: 0, outputDir });
    assert.equal(conflict.results[0].answerText, done.answerText);
    assert.match(conflict.results[0].files.exportError.message, /Refusing/);
    assert.equal(readFileSync(exported.outputPath, 'utf8'), 'User file');
    const mcp = await invokeMcpTool({ remote, socketPath: '/no-host-core', timeoutMs: 10000, maxLineBytes: 2e6, name: 'sessionplane_team_get', arguments: { teamId: team.teamId, requestRef } });
    assert.equal(mcp.isError, false);
    assert.equal((mcp.structuredContent.request as any).sessionId, session.sessionId);
    assert.equal(fake.submitCount, 1);
    assert.equal((await callRpc<any>({ socketPath: config.socketPath, method: 'system.health' })).requestOk, true);
    await assert.rejects(callRpc({ remote: { ...remote, socketPath: path.join(root, 'missing.sock') }, socketPath: config.socketPath, method: 'system.health' }), (error: RpcClientError) => {
      assert.equal((error.data as any).details.requestDispatched, false); return true;
    });
    assert.equal(fake.submitCount, 1);
    // A real isolated browser tab on the remote core is closed by replacement,
    // independently of provider deletion availability. Host clients own no browser.
    await core.close();
    core = await startCore({ config, browserHeadless: true, providerAdapters: [fake], logger: { debug() {}, info() {}, warn() {}, error() {} } });
    const { page } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Collected remote answer</main>' }));
    await page.goto('https://chatgpt.com/c/' + done.conversationId);
    const successor = await rpc('session.create', { clientId: 'remote-test', requestId: 'replace', teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    assert.equal(successor.cleanup.pageCleanup.closedPages, 1);
    assert.equal(page.isClosed(), true);
    assert.notEqual(successor.sessionId, session.sessionId);
    assert.equal((await rpc('session.get', { clientId: 'remote-test', sessionId: session.sessionId })).answerText, done.answerText);
    writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
printf '{"sessionplaneRemote":1}\\n'
read request
echo "fixture connection lost" >&2
exit 255
`, { mode: 0o700 });
    await assert.rejects(rpc('system.health', {}), (error: RpcClientError) => {
      assert.equal((error.data as any).details.requestDispatched, true);
      assert.match(error.message, /fixture connection lost/); return true;
    });
    writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho "Permission denied (publickey)" >&2\nexit 255\n', { mode: 0o700 });
    await assert.rejects(rpc('system.health', {}), (error: RpcClientError) => {
      assert.equal((error.data as any).details.requestDispatched, false);
      assert.match(error.message, /Permission denied/); return true;
    });
    assert.equal(fake.submitCount, 1);
  } finally {
    process.env.PATH = oldPath;
    await core.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt remote artifact leaves no partial host output', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-remote-corrupt-'));
  try {
    await assert.rejects(remoteArtifacts({ socketPath: '', method: 'artifact.export', params: { artifactId: 'file', outputPath: path.join(root, 'output') } }, async () => ({
      artifact: { artifactId: 'file', sizeBytes: 3, sha256: '0'.repeat(64) }, offset: 0, data: Buffer.from('bad').toString('base64'),
    })), /checksum/);
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
