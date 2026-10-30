import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../../src/cli/main.ts';
import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('normal CLI team rename persists across restart without changing existing sessions or requests', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-team-rename-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  let core = await startCore({ config, startBrowser: false, providerAdapters: [fake] });
  const rpc = (method: string, params: unknown) => callRpc<any>({ socketPath: config.socketPath, method, params, timeoutMs: 3000 });
  const cli = async (args: string[]) => {
    let stdout = '', stderr = '';
    const code = await runCli([...args, '--socket', config.socketPath, '--client-id', 'rename-owner', '--json'], {
      stdin: Readable.from([]),
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
    });
    return { code, stdout, stderr };
  };
  try {
    const team = await rpc('workflow.team_create', { requestId: 'rename-team', name: 'Project recovery dated task' });
    const sessionId = team.roles[0].currentSessionId;
    await core.submissionService.send({ sessionId, clientId: 'rename-owner', requestId: 'retained-request', prompt: 'Keep original work', sessionDeadlineSec: 600 });
    const before = ['teams', 'team_roles', 'sessions', 'outbox', 'generations'].map(table => ({ table,
      rows: core.database.raw.prepare(`SELECT * FROM ${table}`).all() }));
    const args = ['team', 'rename', team.teamId, '--name', 'Project', '--request-id', 'rename-project'];
    const renamed = await cli(args);
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.equal(JSON.parse(renamed.stdout).name, 'Project');
    assert.equal(JSON.parse(renamed.stdout).teamId, team.teamId);
    for (const { table, rows } of before) {
      const after = core.database.raw.prepare(`SELECT * FROM ${table}`).all();
      if (table === 'teams') {
        assert.equal(after.length, 1);
        assert.equal(after[0]!.name, 'Project');
        const { name: _beforeName, updated_at: _beforeTime, ...beforeTeam } = rows[0]!;
        const { name: _afterName, updated_at: _afterTime, ...afterTeam } = after[0]!;
        assert.deepEqual(afterTeam, beforeTeam);
      } else assert.deepEqual(after, rows, `${table} remains unchanged`);
    }
    const replay = await cli(args);
    assert.equal(replay.code, 0, replay.stderr);
    assert.equal(replay.stdout, renamed.stdout);
    assert.notEqual((await cli(args.map(value => value === 'Project' ? 'Other' : value))).code, 0, 'same ID cannot rename another payload');
    assert.notEqual((await cli(['team', 'rename', team.teamId, '--name', ' ', '--request-id', 'blank-name'])).code, 0);
    assert.notEqual((await cli(['team', 'rename', '00000000-0000-4000-8000-000000000001', '--name', 'Missing', '--request-id', 'missing-team'])).code, 0);
    assert.equal(fake.submitCount, 1);
    assert.equal(fake.stopCount, 0);
    await core.close();
    core = await startCore({ config, startBrowser: false, providerAdapters: [new FakeProviderAdapter()] });
    const restored = await rpc('workflow.team_get', { teamId: team.teamId });
    assert.equal(restored.name, 'Project', 'automatic group title source survives Core restart');
    assert.equal(restored.roles[0].currentSessionId, sessionId);
    assert.equal((await cli(args)).stdout, renamed.stdout, 'receipt remains durable');
    assert.equal(core.database.raw.prepare('SELECT COUNT(*) AS n FROM teams').get()!.n, 1);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
