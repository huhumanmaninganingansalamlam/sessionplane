import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('team MCP deduplicates sends, rejects stale/cross-team refs and keeps concurrent role results exact', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-team-mcp-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const service = await startCore({ config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const invoke = async (name: string, args: Record<string, unknown>) => await invokeMcpTool({
    name: 'sessionplane_' + name, arguments: args, socketPath: config.socketPath,
    timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes,
  });
  try {
    const disabled = await invoke('team_create', { requestId: 'disabled', provider: 'gemini' });
    assert.equal(disabled.structuredContent.errorCode, 'provider.disabled');
    assert.equal(service.teamDirectory.listTeams('sessionplane-mcp').teams.length, 0);
    const created = await invoke('team_create', { requestId: 'team' });
    assert.equal(created.isError, false);
    const teamId = created.structuredContent.teamId;
    assert.equal((await invoke('team_create', { requestId: 'team' })).structuredContent.teamId, teamId);
    const withExpert = await invoke('role_create', { teamId, requestId: 'expert', roleKey: 'expert.database' });
    const roles = withExpert.structuredContent.roles as Array<{ roleRef: string }>;
    const inputs = roles.map((role, i) => ({ teamId, roleRef: role.roleRef, requestId: 'send-' + i, prompt: 'Review ' + i }));
    const sent = await Promise.all(inputs.map((input) => invoke('send', input)));
    for (const result of sent) assert.equal(result.isError, false, JSON.stringify(result));
    const first = sent[0]!.structuredContent;
    assert.equal((await invoke('send', inputs[0]!)).structuredContent.requestRef, first.requestRef);
    const stale = await invoke('send', { ...inputs[0], requestId: 'stale' });
    assert.equal(stale.structuredContent.errorCode, 'session.generation-superseded');
    const other = await invoke('team_create', { requestId: 'other' });
    const otherSend = await invoke('send', { teamId: other.structuredContent.teamId,
      roleRef: (other.structuredContent.roles as Array<{ roleRef: string }>)[0]!.roleRef,
      requestId: inputs[0]!.requestId, prompt: inputs[0]!.prompt });
    assert.equal(otherSend.isError, false);
    assert.notEqual(otherSend.structuredContent.requestRef, first.requestRef);
    const wrong = await invoke('team_get', { teamId: other.structuredContent.teamId, requestRef: first.requestRef });
    assert.equal(wrong.structuredContent.errorCode, 'input.invalid');
    const waiting = await invoke('wait', { teamId, requestRefs: [first.requestRef], waitMs: 1 });
    assert.equal((waiting.structuredContent.results as Array<{ waitExpired: boolean }>)[0]!.waitExpired, true);
    for (const [i, result] of sent.entries()) {
      fake.emitObservation(result.structuredContent.sessionId as string, {
        candidate: { responseMessageId: 'answer-' + i, answerText: 'Result ' + i, terminalMarker: true, streamingMarker: false }, activity: 'none',
      });
    }
    let results: Array<{ terminal: boolean; answerText: string; requestRef: string }> = [];
    for (let i = 0; i < 20; i++) {
      const waited = await invoke('wait', { teamId, requestRefs: sent.map((s) => s.structuredContent.requestRef), waitMs: 100, outputDir: path.join(root, 'outputs') });
      results = waited.structuredContent.results as typeof results;
      if (results.every((r) => r.terminal)) break;
    }
    assert.deepEqual(results.map((r) => r.answerText), ['Result 0', 'Result 1']);
    const refreshed = await invoke('team_get', { teamId });
    const nextRole = (refreshed.structuredContent.roles as Array<{ roleRef: string }>)[0]!.roleRef;
    const next = await invoke('send', { teamId, roleRef: nextRole, requestId: 'next', prompt: 'Next review' });
    assert.equal(next.isError, false);
    const oldStop = await invoke('stop', { teamId, requestRef: first.requestRef, requestId: 'old-stop' });
    assert.equal(oldStop.structuredContent.errorCode, 'session.generation-superseded');
    fake.addArtifact(first.sessionId as string, { providerArtifactId: 'native-file', name: 'review.txt',
      sourceUrl: 'https://fixture.invalid/review.txt', mediaType: 'text/plain' }, 'review bytes');
    const history = await invoke('wait', { teamId, requestRefs: [first.requestRef, otherSend.structuredContent.requestRef], waitMs: 0, outputDir: path.join(root, 'historical-files') });
    assert.equal(history.isError, false);
    const historicalResults = history.structuredContent.results as Array<{ answerText: string; errorCode?: string; files: { exports: Array<{ outputPath: string }> } }>;
    assert.equal(historicalResults[1]!.errorCode, 'input.invalid');
    assert.equal(readFileSync(historicalResults[0]!.files.exports[0]!.outputPath, 'utf8'), 'review bytes');
    const all = await invoke('team_get', { teamId, history: true });
    const entries = all.structuredContent.requests as Array<{ requestRef: string }>;
    assert.ok(entries.some((r) => r.requestRef === first.requestRef));
    assert.ok(entries.some((r) => r.requestRef === next.structuredContent.requestRef));
    const older = await invoke('team_get', { teamId, beforeRequestRef: entries[0]!.requestRef });
    assert.deepEqual((older.structuredContent.requests as typeof entries).map((r) => r.requestRef), entries.slice(1).map((r) => r.requestRef));
    const wrongCursor = await invoke('team_get', { teamId, beforeRequestRef: otherSend.structuredContent.requestRef });
    assert.equal(wrongCursor.structuredContent.errorCode, 'input.invalid');
    assert.equal(((history.structuredContent.results as Array<{ answerText: string }>)[0]!).answerText, 'Result 0');
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
