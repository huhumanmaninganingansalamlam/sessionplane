import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import { ProviderSubmissionError, type ProviderRecoveryRequest, type ProviderSubmissionRequest } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('conversation deletion protects unresolved work, retains answers and persists uncertain outcomes', async () => {
  class DeletingProvider extends FakeProviderAdapter {
    deleted = new Set<string>();
    loseAcknowledgement = false;
    confirmDeletion = false;
    preparationFailure = false;
    duringPrepare: (() => Promise<void>) | null = null;
    override async openSubmission(request: ProviderSubmissionRequest) {
      const operation = await super.openSubmission(request);
      return { ...operation, prepare: async () => {
        await operation.prepare();
        await this.duringPrepare?.();
      } };
    }
    async openDeletion({ session }: ProviderRecoveryRequest) {
      if (this.preparationFailure) throw new ProviderSubmissionError('provider.unavailable',
        'Exact conversation could not be verified for deletion',
        { details: { stage: 'conversation-verification', httpStatus: 429, retryAfterMs: 9000 } });
      return {
        alreadyDeleted: this.confirmDeletion && this.deleted.has(session.conversationId!),
        deleteOnce: async () => {
          assert.ok(!this.deleted.has(session.conversationId!));
          this.deleted.add(session.conversationId!);
          if (this.loseAcknowledgement) throw new Error('Connection lost after provider deletion');
          return true;
        },
        close: async () => {},
      };
    }
  }
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cleanup-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
    observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
  const fake = new DeletingProvider();
  const options = { config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } };
  let core = await startCore(options);
  let sequence = 0;
  const rpc = <T>(method: string, params: object) => callRpc<T>({
    socketPath: config.socketPath, method, params: { clientId: 'cleanup-client', ...params }, timeoutMs: 5000,
  });
  const create = async () => {
    const id = String(++sequence);
    const team = await rpc<{ teamId: string }>('team.create', { requestId: 'team-' + id, name: id });
    const session = await rpc<SessionSnapshot>('session.create', {
      requestId: 'session-' + id, teamId: team.teamId, roleKey: 'main', provider: 'chatgpt',
    });
    await rpc('session.send', { requestId: 'send-' + id, sessionId: session.sessionId, prompt: id });
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await rpc<SessionSnapshot>('session.wait', { sessionId: session.sessionId, generation: 1, waitMs: 10 });
      if (fake.autoFinalText === null || state.terminal) return state;
    }
    throw new Error('Final was not observed');
  };
  const deletion = (session: SessionSnapshot, requestId: string) => ({ requestId,
    sessionId: session.sessionId, generation: session.generation,
    conversationId: session.conversationId, outputsRetrieved: true });
  try {
    const active = await create();
    await assert.rejects(rpc('session.delete', deletion(active, 'active')),
      (error: unknown) => JSON.stringify(error).includes('session.cleanup-not-ready'));
    assert.equal(fake.deleted.size, 0);
    // Seed legacy routing-only retirement to retain coverage for old unresolved records.
    const successor = core.teamDirectory.createSession({ teamId: active.teamId, roleKey: active.roleKey, provider: 'chatgpt' });
    assert.equal((await rpc<SessionSnapshot>('session.get', { sessionId: active.sessionId })).terminal, false);
    fake.emitObservation(active.sessionId, { candidate: { responseMessageId: 'old-final',
      answerText: 'Answer from predecessor', terminalMarker: true, streamingMarker: false }, activity: 'none' });
    let recovered = active;
    for (let attempt = 0; attempt < 100 && !recovered.terminal; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      recovered = await rpc<SessionSnapshot>('session.wait', { sessionId: active.sessionId, generation: 1, waitMs: 10 });
    }
    assert.equal(recovered.answerText, 'Answer from predecessor');
    await assert.rejects(rpc('session.send', { requestId: 'send-to-predecessor', sessionId: active.sessionId, prompt: 'Wrong route' }),
      (error: unknown) => JSON.stringify(error).includes('session.generation-superseded'));
    assert.equal((await rpc<{ deleted: boolean }>('session.delete', deletion(recovered, 'delete-predecessor'))).deleted, true);
    assert.equal((await rpc<SessionSnapshot>('session.get', { teamId: active.teamId, roleKey: active.roleKey })).sessionId, successor.sessionId);
    const waiting = rpc<SessionSnapshot>('session.wait', { sessionId: successor.sessionId, generation: 0, waitMs: 2000 });
    await rpc('session.create', { requestId: 'replace-unsubmitted', teamId: active.teamId,
      roleKey: active.roleKey, provider: 'chatgpt' });
    const superseded = await waiting;
    assert.equal(superseded.sessionState, 'superseded');
    assert.equal(superseded.waitExpired, false);
    await rpc('team.role.create', { requestId: 'role-retirement', teamId: active.teamId,
      roleKey: 'expert.retiring', roleType: 'expert', reportsToRoleKey: 'main' });
    const retiring = await rpc<SessionSnapshot>('session.create', { requestId: 'retiring-session',
      teamId: active.teamId, roleKey: 'expert.retiring', provider: 'chatgpt' });
    await rpc('session.send', { requestId: 'retiring-send', sessionId: retiring.sessionId, prompt: 'Retiring role review' });
    await rpc('team.role.retire', { requestId: 'retire-role', teamId: active.teamId, roleKey: 'expert.retiring' });
    assert.equal((await rpc<SessionSnapshot>('session.get', { sessionId: retiring.sessionId })).terminal, false);
    fake.emitObservation(retiring.sessionId, { candidate: { responseMessageId: 'retired-role-final',
      answerText: 'Retrieved after role retirement', terminalMarker: true, streamingMarker: false }, activity: 'none' });
    let retiredFinal = await rpc<SessionSnapshot>('session.get', { sessionId: retiring.sessionId });
    for (let attempt = 0; attempt < 100 && !retiredFinal.terminal; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      retiredFinal = await rpc<SessionSnapshot>('session.wait', { sessionId: retiring.sessionId, generation: 1, waitMs: 10 });
    }
    assert.equal(retiredFinal.answerText, 'Retrieved after role retirement');
    await assert.rejects(rpc('session.send', { requestId: 'retired-role-send', sessionId: retiring.sessionId, prompt: 'Rejected' }),
      (error: unknown) => JSON.stringify(error).includes('session.generation-superseded'));
    assert.equal((await rpc<{ deleted: boolean }>('session.delete', deletion(retiredFinal, 'delete-retired-role'))).deleted, true);
    await rpc('team.role.create', { requestId: 'role-preparing', teamId: active.teamId,
      roleKey: 'expert.preparing', roleType: 'expert', reportsToRoleKey: 'main' });
    const preparing = await rpc<SessionSnapshot>('session.create', { requestId: 'preparing-session',
      teamId: active.teamId, roleKey: 'expert.preparing', provider: 'chatgpt' });
    fake.duringPrepare = async () => { await rpc('team.role.retire', { requestId: 'retire-during-prepare',
      teamId: active.teamId, roleKey: 'expert.preparing' }); };
    await assert.rejects(rpc('session.send', { requestId: 'preparing-send', sessionId: preparing.sessionId, prompt: 'Must not submit' }),
      (error: unknown) => JSON.stringify(error).includes('session.generation-superseded'));
    fake.duringPrepare = null;
    const notSubmitted = await rpc<SessionSnapshot>('session.get', { sessionId: preparing.sessionId });
    assert.equal(notSubmitted.promptSubmitted, false);
    assert.equal(notSubmitted.submissionState, 'failed_pre_submit');
    fake.autoFinalText = 'Retrieved answer';
    const complete = await create();
    assert.equal(complete.answerText, 'Retrieved answer');
    const input = deletion(complete, 'complete');
    fake.preparationFailure = true;
    await assert.rejects(rpc('session.delete', input), (error: unknown) => {
      const encoded = JSON.stringify(error);
      assert.match(encoded, /provider.unavailable/);
      assert.match(encoded, /conversation-verification/);
      assert.match(encoded, /9000/);
      assert.doesNotMatch(encoded, /internal.invariant-violation/);
      return true;
    });
    assert.equal(fake.deleted.has(complete.conversationId!), false);
    fake.preparationFailure = false; // Retry the same ID after read-only deferral.
    const result = await rpc<{ deleted: boolean }>('session.delete', input);
    assert.equal(result.deleted, true);
    assert.ok(fake.deleted.has(complete.conversationId!));
    assert.deepEqual(await rpc('session.delete', input), result);
    const retained = await rpc<SessionSnapshot>('session.get', { sessionId: complete.sessionId });
    assert.equal(retained.answerText, complete.answerText);
    assert.equal(retained.sessionState, 'superseded');
    const uncertain = await create();
    fake.loseAcknowledgement = true;
    const unknown = await rpc<{ errorCode: string }>('session.delete', deletion(uncertain, 'uncertain'));
    assert.equal(unknown.errorCode, 'provider.deletion-unknown');
    await core.close();
    core = await startCore(options);
    assert.deepEqual(await rpc('session.delete', deletion(uncertain, 'uncertain-new-id')), unknown);
    assert.deepEqual(await rpc('session.delete', deletion(uncertain, 'uncertain')), unknown);
    await assert.rejects(rpc('session.send', { requestId: 'send-after-delete',
      sessionId: uncertain.sessionId, prompt: 'Followup' }),
      (error: unknown) => JSON.stringify(error).includes('session.cleanup-pending'));
    fake.confirmDeletion = true;
    const reconciled = await rpc<{ deleted: boolean }>('session.delete', deletion(uncertain, 'uncertain'));
    assert.equal(reconciled.deleted, true);
    assert.equal((await rpc<SessionSnapshot>('session.get', { sessionId: uncertain.sessionId })).sessionState, 'superseded');
    fake.loseAcknowledgement = false;
    const predecessor = await create();
    fake.autoFinalText = null;
    fake.acknowledgementMode = 'missing';
    await assert.rejects(rpc('session.send', { requestId: 'ambiguous-followup',
      sessionId: predecessor.sessionId, prompt: 'Unacknowledged followup' }),
      (error: unknown) => JSON.stringify(error).includes('session.submission-unknown'));
    const ambiguous = await rpc<SessionSnapshot>('session.get', { sessionId: predecessor.sessionId });
    core.teamDirectory.createSession({ teamId: ambiguous.teamId, roleKey: ambiguous.roleKey, provider: 'chatgpt' });
    await assert.rejects(rpc('session.delete', deletion(ambiguous, 'ambiguous')),
      (error: unknown) => JSON.stringify(error).includes('session.cleanup-not-ready'));
    await core.close();
    const oldDatabase = new DatabaseSync(config.databasePath);
    oldDatabase.prepare("UPDATE sessions SET session_state = 'superseded' WHERE session_id = ?").run(ambiguous.sessionId);
    oldDatabase.close();
    core = await startCore(options);
    const restored = await rpc<SessionSnapshot>('session.get', { sessionId: ambiguous.sessionId });
    assert.equal(restored.terminal, false);
    assert.equal(restored.generation, ambiguous.generation);
    assert.equal(restored.submissionState, 'submission_unknown');
    await assert.rejects(rpc('session.delete', { ...deletion(uncertain, 'wrong-generation'), generation: 2 }),
      (error: unknown) => JSON.stringify(error).includes('session.conversation-mismatch'));
  } finally {
    await core.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('confirmed deletion resumes failed tab closure without another provider delete and protects drafts', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cleanup-tabs-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Saved handoff and final answer';
  let deletes = 0;
  t.mock.method(fake, 'openDeletion', async () => ({ alreadyDeleted: false,
    deleteOnce: async () => { deletes++; return true; }, close: async () => {} }));
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = <T>(method: string, params: object) => callRpc<T>({ socketPath: config.socketPath,
    method, params: { clientId: 'tabs', ...params }, timeoutMs: 10000 });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'tabs' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    await rpc('session.send', { sessionId: session.sessionId, requestId: 'send', prompt: 'Local fixture' });
    const complete = await rpc<SessionSnapshot>('session.wait', { sessionId: session.sessionId, generation: 1, waitMs: 3000 });
    assert.equal(complete.terminal, true);
    const { page } = await core.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main><textarea>human draft</textarea></main>' }));
    await page.goto('https://chatgpt.com/c/' + complete.conversationId);
    const binding = core.pageRegistry.registerPage(page);
    core.pageRegistry.bindPage(binding.pageKey, { sessionId: session.sessionId, generation: 1, conversationId: complete.conversationId! });
    const duplicate = await core.browserOwner!.createPage();
    await duplicate.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main><textarea></textarea></main>' }));
    await duplicate.page.goto('https://chatgpt.com/c/' + complete.conversationId);
    const duplicateTarget = core.pageRegistry.registerPage(duplicate.page).targetId;
    const unrelated = await core.browserOwner!.createPage();
    const input = { sessionId: complete.sessionId, generation: 1, conversationId: complete.conversationId, outputsRetrieved: true, requestId: 'cleanup' };
    await assert.rejects(rpc('session.delete', input), e => JSON.stringify(e).includes('session.cleanup-not-ready'));
    assert.equal(deletes, 0);
    assert.equal(duplicate.page.isClosed(), false);
    assert.equal(await page.locator('textarea').inputValue(), 'human draft');
    await page.locator('textarea').fill('');
    const close = t.mock.method(page, 'close', async () => { throw new Error('Transient close failure'); });
    const first = await rpc<{ deleted: boolean; pageCleanup: { closedPages: number; pageErrors: string[] } }>('session.delete', input);
    assert.equal(first.deleted, true);
    assert.deepEqual(first.pageCleanup, { closedPages: 1, pageErrors: ['browser.unavailable'] });
    assert.equal(page.isClosed(), false);
    assert.equal(duplicate.page.isClosed(), true);
    const control = await unrelated.page.context().browser()!.newBrowserCDPSession();
    assert.equal((await control.send('Target.getTargets')).targetInfos.some(target => target.targetId === duplicateTarget), false);
    await control.detach();
    close.mock.restore();
    const replay = await rpc<typeof first>('session.delete', input);
    assert.deepEqual(replay.pageCleanup, { closedPages: 2, pageErrors: [] });
    assert.equal(page.isClosed(), true);
    assert.equal(unrelated.page.isClosed(), false);
    assert.equal(deletes, 1);
    assert.deepEqual(await rpc('session.delete', input), replay);
    assert.equal((await rpc<SessionSnapshot>('session.get', { sessionId: session.sessionId })).answerText, complete.answerText);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});

test('provider deletion deferral and uncertain acknowledgement independently close only idle owned pages', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-cleanup-deferred-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 5, observationQuietSweepMs: 5 });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Retrieved original reviewer answer';
  let mode: 'deferred' | 'rejected' | 'unknown' = 'deferred';
  let duringPrepare: (() => Promise<void>) | undefined;
  let deletes = 0;
  t.mock.method(fake, 'openDeletion', async () => {
    await duringPrepare?.();
    if (mode === 'deferred') throw new ProviderSubmissionError('provider.unavailable', 'Verification deferred',
      { details: { stage: 'conversation-verification', httpStatus: 429, retryAfterMs: 9000 } });
    return { alreadyDeleted: false, deleteOnce: async () => {
      deletes++;
      if (mode === 'unknown') throw new Error('Acknowledgement lost');
      return false;
    }, close: async () => {} };
  });
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const rpc = <T>(method: string, params: object) => callRpc<T>({ socketPath: config.socketPath,
    method, params: { clientId: 'deferred', ...params }, timeoutMs: 10000 });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'deferred' });
    const unrelated = await core.browserOwner!.createPage();
    await unrelated.page.route('https://chatgpt.com/**', route => route.abort('failed'));
    await unrelated.page.goto('https://chatgpt.com/c/unrelated-failed-navigation').catch(() => {});
    for (const outcome of ['deferred', 'failed-navigation', 'failed-navigation-draft', 'failed-navigation-late-navigation', 'rejected', 'unknown', 'draft', 'attachment-draft', 'file-input-draft', 'generating', 'navigated', 'late-navigation'] as const) {
      mode = outcome === 'rejected' || outcome === 'unknown' ? outcome : 'deferred';
      core.teamDirectory.createRole({ teamId: team.teamId, roleKey: outcome, roleType: 'expert' });
      const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: outcome, provider: 'chatgpt' });
      await rpc('session.send', { sessionId: session.sessionId, requestId: 'send-' + outcome, prompt: 'Local fixture' });
      const complete = await rpc<SessionSnapshot>('session.wait', { sessionId: session.sessionId, generation: 1, waitMs: 3000 });
      assert.equal(complete.terminal, true);
      const { page, binding } = await core.browserOwner!.createPage();
      const failedNavigation = outcome.startsWith('failed-navigation');
      await page.route('https://chatgpt.com/**', route => failedNavigation ? route.abort('failed') :
        route.fulfill({ contentType: 'text/html', body: '<main><article><div data-testid="file-pill">old-response.txt</div></article><form><textarea></textarea><button data-testid="attachment-button">Attach</button></form></main>' }));
      if (failedNavigation) {
        await assert.rejects(page.goto('https://chatgpt.com/c/' + complete.conversationId), /ERR_FAILED/);
        await page.waitForURL('chrome-error://chromewebdata/');
        assert.equal(core.pageRegistry.getBinding(binding.pageKey).sessionId, null);
        if (outcome === 'failed-navigation-draft') await page.setContent('<textarea>Preserve error-page draft</textarea>');
      } else {
        await page.goto('https://chatgpt.com/c/' + complete.conversationId);
        core.pageRegistry.bindPage(binding.pageKey, { sessionId: session.sessionId, generation: 1, conversationId: complete.conversationId! });
      }
      let prepared = false;
      const locator = page.locator.bind(page);
      const locatorMock = t.mock.method(page, 'locator', (...args: Parameters<typeof page.locator>) => {
        const found = locator(...args);
        if (outcome === 'late-navigation' || outcome === 'failed-navigation-late-navigation') {
          const evaluateAll = found.evaluateAll.bind(found);
          t.mock.method(found, 'evaluateAll', async (...parameters: Parameters<typeof found.evaluateAll>) => {
            const value = await evaluateAll(...parameters);
            if (prepared) {
              prepared = false;
              if (failedNavigation) {
                const navigated = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() });
                await page.goto('https://chatgpt.com/c/new-human-conversation').catch(() => {});
                await navigated;
              } else {
                await page.goto('https://chatgpt.com/c/new-human-conversation');
                await page.locator('textarea').fill('New conversation draft');
              }
            }
            return value;
          });
        }
        return found;
      });
      duringPrepare = async () => {
        prepared = true;
        if (outcome === 'file-input-draft') {
          await page.setContent('<form><textarea></textarea><input type="file" data-testid="attachment-input"></form>');
          await page.locator('input[type="file"]').setInputFiles({ name: 'unsent-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Preserve original attachment') });
        }
        if (outcome === 'attachment-draft') await page.setContent('<form><textarea></textarea><input type="file"><div data-testid="file-pill">unsent-notes.txt</div></form>');
        if (outcome === 'draft') await page.locator('textarea').fill('Preserve human draft');
        if (outcome === 'generating') await page.evaluate(() => {
          const stop = document.createElement('button'); stop.setAttribute('aria-label', 'Stop');
          stop.textContent = 'Stop'; document.body.append(stop);
        });
        if (outcome === 'navigated') await page.goto('https://chatgpt.com/c/different-conversation');
      };
      const input = { sessionId: session.sessionId, generation: 1, conversationId: complete.conversationId,
        outputsRetrieved: true, requestId: 'cleanup-' + outcome };
      type Result = { deleted: boolean; errorCode: string; pageCleanup: { closedPages: number; pageErrors: string[] } };
      if (mode === 'deferred') {
        await assert.rejects(rpc('session.delete', input), (error: unknown) => {
          assert.ok(error instanceof RpcClientError);
          const data = error.data as { errorCode: string; details: { retryAfterMs: number; deletionAttempted: boolean; deleted: boolean; pageCleanup: Result['pageCleanup'] } };
          const details = data.details;
          if (outcome === 'failed-navigation-draft') {
            assert.equal(data.errorCode, 'session.cleanup-not-ready');
            return true;
          }
          assert.equal(data.errorCode, 'provider.unavailable');
          assert.equal(details.retryAfterMs, 9000);
          assert.equal(details.deletionAttempted, false);
          assert.equal(details.deleted, false);
          assert.equal(details.pageCleanup.closedPages, outcome === 'deferred' || outcome === 'failed-navigation' ? 1 : 0, outcome);
          if (outcome !== 'deferred' && outcome !== 'failed-navigation') assert.equal(details.pageCleanup.pageErrors.length, 1);
          return true;
        });
      } else {
        const first = await rpc<Result>('session.delete', input);
        assert.equal(first.deleted, false);
        assert.equal(first.errorCode, mode === 'unknown' ? 'provider.deletion-unknown' : 'provider.deletion-rejected');
        assert.equal(first.pageCleanup.closedPages, 1);
        const attempts = deletes;
        const replay = await rpc<Result>('session.delete', input);
        assert.equal(replay.pageCleanup.closedPages, 1);
        assert.equal(deletes, attempts, 'Repeated cleanup must not repeat a provider DELETE');
      }
      assert.equal(page.isClosed(), ['deferred', 'failed-navigation', 'rejected', 'unknown'].includes(outcome));
      assert.equal(core.pageRegistry.getBinding(binding.pageKey).sessionId, failedNavigation ? null : session.sessionId);
      if (outcome === 'failed-navigation') {
        const control = await unrelated.page.context().browser()!.newBrowserCDPSession();
        assert.equal((await control.send('Target.getTargets')).targetInfos.some(target => target.targetId === binding.targetId), false);
        await control.detach();
      }
      if (outcome === 'failed-navigation-draft') assert.equal(await page.locator('textarea').inputValue(), 'Preserve error-page draft');
      if (outcome === 'draft') assert.equal(await page.locator('textarea').inputValue(), 'Preserve human draft');
      if (outcome === 'attachment-draft') assert.equal(await page.getByTestId('file-pill').textContent(), 'unsent-notes.txt');
      if (outcome === 'late-navigation') assert.equal(await page.locator('textarea').inputValue(), 'New conversation draft');
      if (outcome === 'failed-navigation-late-navigation') {
        const control = await page.context().newCDPSession(page);
        assert.equal((await control.send('Target.getTargetInfo')).targetInfo.url, 'https://chatgpt.com/c/new-human-conversation');
        await control.detach();
      }
      locatorMock.mock.restore();
      const after = await rpc<SessionSnapshot>('session.get', { sessionId: session.sessionId });
      assert.equal(after.answerText, complete.answerText);
      assert.equal(after.generation, complete.generation);
      assert.equal(after.conversationId, complete.conversationId);
      assert.equal(unrelated.page.isClosed(), false);
    }
    assert.equal(deletes, 2);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
