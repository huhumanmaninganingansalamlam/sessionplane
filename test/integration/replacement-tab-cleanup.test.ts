import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { callRpc } from '../../src/cli/client.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import type { ReplacementCleanup } from '../../src/core/conversation-cleanup-service.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';

test('replacement reports and resumes predecessor tab closure without another successor or deletion', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-replacement-tabs-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
  const fake = new FakeProviderAdapter(); fake.autoFinalText = 'Retrieved final handoff';
  let deletes = 0;
  t.mock.method(fake, 'openDeletion', async () => ({ alreadyDeleted: false,
    deleteOnce: async () => { deletes++; return true; }, close: async () => {} }));
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = <T>(method: string, params: object) => callRpc<T>({ socketPath: config.socketPath,
    method, params: { clientId: 'replacement-tabs', ...params }, timeoutMs: 10000 });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'replacement-tabs' });
    const old = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await rpc('session.send', { sessionId: old.sessionId, requestId: 'send', prompt: 'Local handoff fixture' });
    const complete = await rpc<SessionSnapshot>('session.wait', { sessionId: old.sessionId, generation: 1, waitMs: 3000 });
    assert.equal(complete.terminal, true);
    const { page } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>Maximum length reached; handoff saved.</main>' }));
    await page.goto('https://chatgpt.com/c/' + complete.conversationId);
    const close = t.mock.method(page, 'close', async () => { throw new Error('Close interrupted'); });
    const input = { requestId: 'replace', teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' };
    const next = await rpc<SessionSnapshot & { cleanup: ReplacementCleanup }>('session.create', input);
    assert.equal(next.cleanup.outcome, 'confirmed');
    assert.deepEqual(next.cleanup.pageCleanup, { closedPages: 0, pageErrors: ['browser.unavailable'] });
    assert.equal(page.isClosed(), false);
    assert.equal(close.mock.callCount(), 1);
    close.mock.restore();
    const replay = await rpc<typeof next>('session.create', input);
    assert.equal(replay.sessionId, next.sessionId);
    assert.deepEqual(replay.cleanup.pageCleanup, { closedPages: 1, pageErrors: [] });
    assert.equal(page.isClosed(), true);
    assert.equal(deletes, 1);
    assert.equal((await rpc<SessionSnapshot>('session.get', { sessionId: old.sessionId })).answerText, complete.answerText);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('unavailable replacement deletion closes only idle resolved predecessor tabs and resumes guarded closure', async t => {
  for (const state of ['idle', 'draft', 'generating', 'unknown'] as const) {
    await t.test(state, async () => {
      const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-unavailable-cleanup-'));
      const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
      const fake = new FakeProviderAdapter();
      if (state !== 'unknown') fake.autoFinalText = 'Collected predecessor handoff';
      let attempts = 0;
      t.mock.method(fake, 'openDeletion', async () => {
        attempts++;
        throw new ProviderSubmissionError('provider.unavailable', 'Conversation lookup unavailable');
      });
      const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
        logger: { debug() {}, info() {}, warn() {}, error() {} } });
      const rpc = <T>(method: string, params: object) => callRpc<T>({ socketPath: config.socketPath,
        method, params: { clientId: 'unavailable-tabs', ...params }, timeoutMs: 10000 });
      try {
        const team = core.teamDirectory.createTeam({ clientId: 'unavailable-tabs' });
        const old = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
        await rpc('session.send', { sessionId: old.sessionId, requestId: 'send', prompt: 'Handoff fixture' });
        const before = await rpc<SessionSnapshot>('session.wait', { sessionId: old.sessionId, generation: 1, waitMs: state === 'unknown' ? 20 : 3000 });
        assert.equal(before.terminal, state !== 'unknown');
        const { page } = await core.browserOwner!.createPage();
        const body = state === 'draft' ? '<textarea>Keep human draft</textarea>' : state === 'generating'
          ? '<button data-testid="stop-button">Stop</button>' : '<main>Collected handoff</main>';
        await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body }));
        await page.goto('https://chatgpt.com/c/' + before.conversationId);
        const input = { requestId: 'replace', teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' };
        const next = await rpc<SessionSnapshot & { cleanup: ReplacementCleanup }>('session.create', input);
        assert.equal(next.cleanup.outcome, 'not-attempted');
        assert.equal(next.cleanup.errorCode, state === 'draft' || state === 'generating'
          ? 'session.cleanup-not-ready' : 'provider.unavailable');
        assert.equal(page.isClosed(), state === 'idle');
        if (state === 'draft') assert.equal(await page.locator('textarea').inputValue(), 'Keep human draft');
        if (state === 'draft' || state === 'generating') {
          assert.deepEqual(next.cleanup.pageCleanup, { closedPages: 0, pageErrors: ['session.cleanup-not-ready'] });
          // The user finishes their draft/generation; the same replacement may now close the tab.
          await page.setContent('<main>Idle now</main>');
        }
        const replay = await rpc<typeof next>('session.create', input);
        assert.equal(replay.sessionId, next.sessionId);
        assert.equal(page.isClosed(), state !== 'unknown');
        assert.equal(attempts, state === 'draft' || state === 'generating' ? 0 : 1,
          'Unsafe UI prevents deletion; receipt replay never retries provider deletion');
        const preserved = await rpc<SessionSnapshot>('session.get', { sessionId: old.sessionId });
        assert.equal(preserved.answerText, before.answerText);
        assert.equal(preserved.submissionState, before.submissionState);
      } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
});
