import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('ten confirmed turns recommend handoff; failures, replays, restart and replacement retain correct counts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-turns-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Verified answer';
  const options = { config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } };
  let service = await startCore(options);
  const rpc = (method: string, params: Record<string, unknown>) => callRpc<any>({
    socketPath: config.socketPath, method: `workflow.${method}`, params, timeoutMs: 10_000,
  });
  try {
    let team = await rpc('team_create', { requestId: 'turn-team' });
    const teamId = team.teamId;
    assert.equal(team.roles[0].conversationUsage.confirmedTurnCount, 0);
    fake.prepareError = new ProviderSubmissionError('provider.composer-unavailable', 'Synthetic preparation failure');
    await assert.rejects(rpc('send', { teamId, roleRef: team.roles[0].roleRef,
      requestId: 'failed-turn', prompt: 'Not submitted' }));
    fake.prepareError = null;
    team = await rpc('team_get', { teamId });
    assert.equal(team.roles[0].conversationUsage.confirmedTurnCount, 0);
    let lastRequest: string = '';
    for (let turn = 1; turn <= 10; turn++) {
      const input = { teamId, roleRef: team.roles[0].roleRef, requestId: `turn-${turn}`, prompt: `Question ${turn}` };
      const sent = await rpc('send', input);
      lastRequest = sent.requestRef;
      assert.equal(sent.conversationUsage.confirmedTurnCount, turn);
      assert.equal(sent.conversationUsage.handoffRecommended, turn >= 10);
      const replay = await rpc('send', input);
      assert.equal(replay.conversationUsage.confirmedTurnCount, turn);
      const waited = await rpc('wait', { teamId, requestRefs: [lastRequest], waitMs: 5_000 });
      assert.equal(waited.results[0].terminal, true);
      assert.equal(waited.results[0].conversationUsage.confirmedTurnCount, turn);
      team = await rpc('team_get', { teamId });
    }
    assert.match(team.roles[0].conversationUsage.recommendation, /handoff.*sessionplane_session_replace/);
    assert.equal(fake.submitCount, 10);
    await service.close();
    service = await startCore(options);
    team = await rpc('team_get', { teamId });
    assert.equal(team.roles[0].conversationUsage.confirmedTurnCount, 10);
    const replaced = await rpc('session_replace', { teamId, roleRef: team.roles[0].roleRef, requestId: 'replace-after-handoff' });
    assert.equal(replaced.roles[0].conversationUsage.confirmedTurnCount, 0);
    assert.equal(replaced.roles[0].conversationUsage.handoffRecommended, false);
    const historical = await rpc('team_get', { teamId, requestRef: lastRequest });
    assert.equal(historical.request.conversationUsage.confirmedTurnCount, 10);
    fake.acknowledgementMode = 'missing';
    await assert.rejects(rpc('send', { teamId, roleRef: replaced.roles[0].roleRef,
      requestId: 'unknown-turn', prompt: 'Unacknowledged attempt' }), /acknowledgement was not proven/);
    const unknown = await rpc('team_get', { teamId });
    assert.equal(unknown.roles[0].conversationUsage.confirmedTurnCount, 0);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
