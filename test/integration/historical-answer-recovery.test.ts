import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { SessionRepository } from '../../src/storage/session-repository.ts';
import { ReceiptRepository } from '../../src/storage/receipt-repository.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

test('explicit later responses preserve a completed original and an optional prepared successor', async t => {
  for (const prepared of [false, true]) await t.test(prepared ? 'prepared successor' : 'completed current request', async t => {
    const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-completed-followup-'));
    const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
      observationQuietWindowMs: 25, observationQuietSweepMs: 25, observationActiveSweepMs: 25 });
    const fake = new FakeProviderAdapter();
    const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
      logger: { debug() {}, info() {}, warn() {}, error() {} } });
    try {
      const team = core.teamDirectory.createTeam({ clientId: 'fixture-owner' });
      const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
      const { page, binding } = await core.browserOwner!.createPage();
      let navigations = 0;
      await page.route('https://chatgpt.com/**', route => {
        navigations++;
        return route.fulfill({ contentType: 'text/html', body: '<main><section id="messages"></section><textarea id="prompt-textarea"></textarea></main>' });
      });
      await page.goto(`https://chatgpt.com/c/conversation-${session.sessionId}`);
      const open = fake.openSubmission.bind(fake);
      t.mock.method(fake, 'openSubmission', async request => {
        if (request.generation === 2) throw new SessionPlaneDomainError('provider.preparation-required', 'Prepare only');
        return { ...await open(request), pageKey: binding.pageKey, bindAcknowledgement() {
          core.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId, generation: 1,
            conversationId: `conversation-${session.sessionId}` });
        } };
      });
      const observe = fake.openObservation.bind(fake);
      t.mock.method(fake, 'openObservation', async request => {
        const source = await observe(request);
        t.mock.method(source, 'observe', async () => ({ submittedUserFound: true, laterUserFound: false,
          candidate: { responseMessageId: 'original-answer', answerText: 'Stored original answer', terminalMarker: true, streamingMarker: false },
          activity: 'none' as const, dialogKind: null, networkActivity: false, observationTransport: 'fresh' as const }));
        return source;
      });
      await core.submissionService.send({ clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId, prompt: 'Original work', sessionDeadlineSec: 600 });
      const deadline = Date.now() + 2000;
      while (!core.teamDirectory.getSession(session.sessionId).terminal && Date.now() < deadline)
        await core.actorScheduler.waitSession(session.sessionId, { expectedGeneration: 1, waitMs: 100 });
      const timestamp = new Date().toISOString();
      new SessionRepository(core.database.raw).updateCurrentGeneration(session.sessionId, 1, { reason: 'dom-quiet-stable-final' }, timestamp);
      if (prepared) await assert.rejects(core.submissionService.send({ clientId: 'fixture-owner', requestId: 'pending-distinct-work',
        sessionId: session.sessionId, prompt: 'Preserved pending prompt', sessionDeadlineSec: 600 }), /caller decision/);
      core.pageRegistry.reservePage(binding.pageKey, core.teamDirectory.getSession(session.sessionId));
      await page.locator('#messages').evaluate(node => { node.innerHTML =
        '<div data-message-author-role="user" data-message-id="user-message-1">Original work</div>' +
        '<div data-message-author-role="assistant" data-message-id="original-answer">Stored original answer</div>' +
        '<div data-message-author-role="user" data-message-id="manual-a">Open the existing terminal</div>' +
        '<div data-message-author-role="assistant" data-message-id="answer-a">Terminal ready</div>' +
        '<div data-message-author-role="user" data-message-id="manual-b">Connection is ready</div>' +
        '<div data-message-author-role="assistant" data-message-id="answer-b">Exact later response</div>'; });
      await page.locator('textarea').fill('Preserved pending prompt');
      t.mock.method(page, 'bringToFront', async () => { throw new Error('No focus permitted'); });
      const rows = () => ({ session: core.teamDirectory.getSession(session.sessionId),
        outbox: core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation').all(session.sessionId),
        generations: core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(session.sessionId) });
      const before = rows();
      const requestRef = before.outbox[0]!.outbox_id;
      const show = async (followupId?: string) => {
        let stdout = '', stderr = '';
        const code = await runCli(['request', 'show', team.teamId, requestRef, '--view', 'result', '--json',
          '--socket', config.socketPath, ...(followupId ? ['--followup-message-id', followupId] : [])], {
          stdin: Readable.from([]),
          stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
          stderr: new Writable({ write(chunk, _encoding, done) { stderr += String(chunk); done(); } }),
        });
        assert.equal(code, 0, stderr);
        return JSON.parse(stdout);
      };
      const wait = async (followupUserMessageId: string, waitMs: number) => (await invokeMcpTool({ name: 'sessionplane_wait',
        arguments: { teamId: team.teamId, requestRefs: [requestRef], followupUserMessageId, waitMs },
        socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes })).structuredContent as any;
      const wrong = (await wait('manual-a', 0)).results[0];
      assert.notEqual(wrong.followup?.terminal, true, 'A later user must prevent collecting an earlier follow-up as current');
      await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<button id="active" aria-label="Stop">Stop</button>'));
      const active = (await wait('manual-b', 0)).results[0] as any;
      assert.equal(active.requestOk, true, JSON.stringify(active));
      assert.notEqual(active.followup?.terminal, true, 'Stop preserves the active turn');
      assert.deepEqual(rows(), before);
      await page.locator('#active').evaluate(node => node.remove());
      await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend',
        '<div id="disconnected" role="status">Disconnected. Waiting for the full answer.</div>'));
      const disconnected = (await show('manual-b')).results[0];
      assert.equal(disconnected.followup.userMessageId, 'manual-b');
      assert.equal(disconnected.followup.reason, 'provider-stream-disconnected');
      assert.equal(disconnected.followup.activity, 'unknown');
      assert.equal(disconnected.followup.terminal, false);
      assert.ok(Number.isFinite(Date.parse(disconnected.followup.observedAt)));
      assert.equal(core.actorScheduler.collectors(session.sessionId).length, 0, 'show never adds a collector');
      assert.deepEqual(rows(), before, 'A disconnected read preserves original result and pending draft');
      await page.locator('#disconnected').evaluate(node => node.remove());
      const result = (await wait('manual-b', 5000)).results[0] as any;
      assert.equal(result.requestOk, true, JSON.stringify(result));
      assert.equal(result.followup.terminal, true, JSON.stringify(result));
      assert.equal(result.followup.userMessageId, 'manual-b');
      assert.equal(result.followup.responseMessageId, 'answer-b');
      assert.equal(result.followup.answerText, 'Exact later response');
      assert.equal(result.reconciliation.providerMutation, false);
      assert.equal(result.reconciliation.evidence.originalResponseMessageId, 'original-answer');
      assert.notEqual((await wait('manual-a', 0)).results[0].followup?.terminal, true,
        'A cached later response must not answer an explicitly different follow-up');
      assert.equal((await show('manual-b')).results[0].followup.responseMessageId, 'answer-b');
      assert.equal((await show()).request.submittedUserMessageId, 'user-message-1', 'Unqualified show keeps the original anchor');
      assert.deepEqual(rows(), before, 'Neither the completed answer nor unsubmitted successor is rewritten');
      assert.equal(await page.locator('textarea').inputValue(), 'Preserved pending prompt');
      assert.equal(core.actorScheduler.collectors(session.sessionId).length, 0);
      assert.equal(fake.submitCount, 1);
      assert.equal(navigations, 1);
      if (prepared) {
        await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend',
          '<div role="radiogroup"><button role="radio" aria-checked="true">Chat</button></div>' +
          '<button id="model" aria-haspopup="menu">Extra High</button><button data-testid="send-button">Send</button>'));
        const pendingRef = before.outbox[1]!.outbox_id;
        const pending = (await invokeMcpTool({ name: 'sessionplane_team_get', arguments: {
          teamId: team.teamId, requestRef: pendingRef, view: 'evidence' }, socketPath: config.socketPath,
          timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes })).structuredContent as any;
        const model = { ...pending.request.evidence.nodes.find((n: any) => n.id === 'model'), purpose: 'model', selectedValue: null };
        const receipts = new ReceiptRepository(core.database);
        receipts.execute({ clientId: 'fixture-owner', requestId: `submission-configuration:${requestRef}`,
          method: 'session.submission.configuration', payload: { model }, operation: () => ({ model }) });
        await page.route('https://chatgpt.com/backend-api/conversation', route => route.fulfill({
          status: 200, contentType: 'application/json', body: '{}' }));
        await page.evaluate(conversationId => {
          (window as any).sends = 0;
          document.querySelector('[data-testid="send-button"]')!.addEventListener('click', async () => {
            const editor = document.querySelector('textarea')!;
            if (editor.value !== '계속') throw new Error('Never submit the product draft');
            (window as any).sends++;
            await fetch('/backend-api/conversation', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action: 'next', conversation_id: conversationId, parent_message_id: 'answer-c',
                messages: [{ id: 'recovery-user', author: { role: 'user' }, content: { content_type: 'text', parts: ['계속'] } }] }) });
            editor.value = '';
            document.querySelector('#timeout')?.remove();
            document.querySelector('#messages')!.insertAdjacentHTML('beforeend',
              '<div data-message-author-role="user" data-message-id="recovery-user">계속</div>' +
              '<div data-message-author-role="assistant" data-message-id="recovery-final">Recovered exact work</div>');
          });
        }, `conversation-${session.sessionId}`);
        await page.locator('#messages').evaluate(node => node.insertAdjacentHTML('beforeend',
          '<div data-message-author-role="user" data-message-id="manual-c">Finish the original work</div>' +
          '<div data-message-author-role="assistant" data-message-id="answer-c">Partial response</div>'));
        await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend',
          '<div id="timeout" role="alert">메시지 전송 시간이 초과되었습니다. 다시 시도하세요.</div>'));
        const recover = async (followup = 'manual-c', id = 'recover-exact-followup') => {
          let stdout = '', stderr = '';
          const code = await runCli(['request', 'continue', team.teamId, requestRef, '--followup-message-id', followup,
            '--continuation-approved', '--wait-ms', '0', '--request-id', id, '--socket', config.socketPath, '--json'], {
            stdin: Readable.from([]),
            stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
            stderr: new Writable({ write(chunk, _encoding, done) { stderr += String(chunk); done(); } }),
          });
          return { code, value: JSON.parse(stdout || stderr) };
        };
        assert.equal((await recover('manual-a', 'wrong-followup')).code, 1, 'Do not recover a different historical turn');
        for (const control of ['<button id="guard" data-testid="stop-button">Stop</button>',
          '<button id="guard">항상 허용</button>']) {
          await page.locator('main').evaluate((node, html) => node.insertAdjacentHTML('beforeend', html), control);
          assert.equal((await recover('manual-c', `guard-${control}`)).code, 1);
          assert.equal(await page.locator('textarea').inputValue(), 'Preserved pending prompt');
          await page.locator('#guard').evaluate(node => node.remove());
        }
        assert.equal(await page.evaluate(() => (window as any).sends), 0);
        await page.locator('textarea').fill('A new human edit');
        assert.equal((await recover('manual-c', 'preserve-human-edit')).code, 1);
        assert.equal(await page.locator('textarea').inputValue(), 'A new human edit');
        await page.locator('textarea').fill('Preserved pending prompt');
        const recovered = await recover();
        assert.equal(recovered.code, 0, JSON.stringify(recovered));
        assert.equal(recovered.value.followupUserMessageId, 'recovery-user');
        assert.equal(recovered.value.draftPreservation.restored, true);
        assert.equal(await page.locator('textarea').inputValue(), 'Preserved pending prompt');
        assert.deepEqual(rows(), before, 'A recovery ACK must not become the product generation ACK');
        assert.equal(core.actorScheduler.collectors(session.sessionId).length, 0, 'ACK-only continue never starts a competing wait');
        assert.equal((await recover('manual-c', 'new-id-same-followup')).value.followupUserMessageId, 'recovery-user');
        assert.equal(await page.evaluate(() => (window as any).sends), 1, 'An alternate decision ID cannot resend the same recovery');
        // Simulate interruption after the send/ACK receipt, before draft restoration.
        const key = `followup-continue:${requestRef}:manual-c`;
        const receipt = receipts.get('fixture-owner', key)!;
        receipts.record({ ...receipt, status: 'attempted', result: JSON.parse(receipt.resultJson) });
        await page.locator('textarea').fill('계속');
        assert.equal((await recover()).value.draftPreservation.restored, true);
        assert.equal(await page.locator('textarea').inputValue(), 'Preserved pending prompt');
        assert.equal(await page.evaluate(() => (window as any).sends), 1);
        const exact = (await wait('manual-c', 5000)).results[0];
        assert.equal(exact.followup.userMessageId, 'recovery-user');
        assert.equal(exact.followup.recoveredFromUserMessageId, 'manual-c');
        assert.equal(exact.followup.responseMessageId, 'recovery-final');
        assert.equal(exact.followup.answerText, 'Recovered exact work');
        assert.equal((await show('manual-c')).results[0].followup.recoveredFromUserMessageId, 'manual-c');
        // An interrupted dispatch without an ACK must restore the draft, never resend.
        const uncertain = JSON.parse(receipt.resultJson);
        uncertain.backup.acknowledgement = null;
        receipts.record({ ...receipt, status: 'attempted', result: uncertain });
        await page.locator('textarea').fill('계속');
        const unknown = (await recover('manual-c', 'recover-uncertain-send')).value;
        assert.equal(unknown.requestOk, false);
        assert.equal(unknown.errorCode, 'session.submission-unknown');
        assert.equal(unknown.draftPreservation.restored, true);
        assert.equal(await page.evaluate(() => (window as any).sends), 1);
        assert.deepEqual(rows(), before);
        assert.equal(fake.submitCount, 1);
      }
    } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

test('original quiet-final can be recovered through latest under an unsubmitted successor without altering either request', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-historical-answer-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state',
    observationQuietWindowMs: 25, observationQuietSweepMs: 25, observationActiveSweepMs: 25 });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  try {
    const team = core.teamDirectory.createTeam({ clientId: 'fixture-owner' });
    const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
    const { page, binding } = await core.browserOwner!.createPage();
    let navigations = 0;
    await page.route('https://chatgpt.com/**', route => {
      navigations++;
      return route.fulfill({ contentType: 'text/html', body: '<main><section id="messages"></section><textarea id="prompt-textarea"></textarea><button aria-label="Scroll to bottom">Latest</button></main>' });
    });
    await page.goto(`https://chatgpt.com/c/conversation-${session.sessionId}`);
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => {
      if (request.generation === 2) throw new SessionPlaneDomainError('provider.preparation-required', 'Prepare only');
      return { ...await open(request), pageKey: binding.pageKey, bindAcknowledgement() {
        core.pageRegistry.reservePage(binding.pageKey, { sessionId: session.sessionId, generation: 1,
          conversationId: `conversation-${session.sessionId}` });
      } };
    });
    const openObservation = fake.openObservation.bind(fake);
    t.mock.method(fake, 'openObservation', async request => {
      const source = await openObservation(request);
      const observe = source.observe.bind(source);
      t.mock.method(source, 'observe', async () => ({ ...await observe(), submittedUserFound: true,
        activity: 'none' as const, candidate: { responseMessageId: 'announcement',
          answerText: 'I will review the evidence.', terminalMarker: false, streamingMarker: false } }));
      return source;
    });
    await core.submissionService.send({ clientId: 'fixture-owner', requestId: 'original', sessionId: session.sessionId, prompt: 'Review', sessionDeadlineSec: 600 });
    const deadline = Date.now() + 2_000;
    while (!core.teamDirectory.getSession(session.sessionId).terminal && Date.now() < deadline) {
      await core.actorScheduler.waitSession(session.sessionId, { expectedGeneration: 1, waitMs: 500 });
    }
    assert.equal(core.teamDirectory.getSession(session.sessionId).reason, 'dom-quiet-stable-final');
    await assert.rejects(core.submissionService.send({ clientId: 'fixture-owner', requestId: 'prepared-only', sessionId: session.sessionId, prompt: 'Finish review', sessionDeadlineSec: 600 }),
      (error: unknown) => error instanceof SessionPlaneDomainError && error.errorCode === 'provider.preparation-required');
    const current = core.teamDirectory.getSession(session.sessionId);
    core.pageRegistry.reservePage(binding.pageKey, current);
    const rows = () => ({ outbox: core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? ORDER BY generation').all(session.sessionId),
      generations: core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(session.sessionId),
      session: core.teamDirectory.getSession(session.sessionId) });
    const before = rows();
    const original = before.outbox[0]!;
    const latest = (id: string, requestRef = original.outbox_id) => invokeMcpTool({ name: 'sessionplane_decide',
      arguments: { teamId: team.teamId, requestRef, requestId: id, decision: 'latest' },
      socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    const transcript = '<div data-message-author-role="user" data-message-id="user-message-1">Review</div><div data-message-author-role="assistant" data-message-id="announcement">I will review the evidence.</div><div data-message-author-role="assistant" data-message-id="actual-final">VERDICT: APPROVE</div>';
    await page.locator('#messages').evaluate((node, html) => { node.innerHTML = html; }, transcript);
    await page.locator('textarea').fill('Preserved user draft');
    t.mock.method(page, 'bringToFront', async () => { throw new Error('No focus allowed'); });
    await page.locator('[data-message-id="actual-final"]').evaluate(node => node.remove());
    assert.equal(((await latest('announcement-only')).structuredContent.answerRecovery as any).reason, 'historical-answer-unchanged');
    await page.locator('#messages').evaluate((node, html) => { node.innerHTML = html; }, transcript);
    const result = await latest('recover-original');
    assert.equal(result.isError, false, JSON.stringify(result));
    const recovered = result.structuredContent.answerRecovery as Record<string, unknown>;
    assert.equal(result.structuredContent.generation, 1);
    assert.equal(result.structuredContent.bindingGeneration, 2);
    assert.equal(recovered.terminal, true);
    assert.equal(recovered.responseMessageId, 'actual-final');
    assert.equal(recovered.answerText, 'VERDICT: APPROVE');
    assert.equal((result.structuredContent.storedResult as any).responseMessageId, 'announcement');
    assert.deepEqual((await latest('recover-original')).structuredContent, result.structuredContent);
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved user draft');

    await page.evaluate(() => { const stop = document.createElement('button'); stop.id = 'active'; stop.setAttribute('aria-label', '중지'); document.querySelector('main')!.append(stop); });
    const get = await invokeMcpTool({ name: 'sessionplane_team_get',
      arguments: { teamId: team.teamId, requestRef: original.outbox_id, view: 'evidence' },
      socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    const observed = get.structuredContent.request as any;
    assert.equal(observed.terminal, false);
    assert.equal(observed.status, 'recovery_required');
    assert.equal(observed.answerText, null);
    assert.equal(observed.storedResult.responseMessageId, 'announcement');
    assert.deepEqual(rows(), before);
    const active = await latest('still-active');
    assert.equal((active.structuredContent.answerRecovery as any).terminal, false);
    assert.equal((active.structuredContent.answerRecovery as any).answerText, null);
    await page.locator('#active').evaluate(node => node.remove());
    await page.evaluate(() => { const dialog = document.createElement('div'); dialog.id = 'limit'; dialog.setAttribute('role', 'dialog'); dialog.textContent = 'Too many requests'; document.body.append(dialog); });
    assert.equal(((await latest('rate-limit')).structuredContent.answerRecovery as any).reason, 'provider-rate-limit-dialog');
    await page.locator('#limit').evaluate(node => node.remove());

    await page.locator('#messages').evaluate(node => { node.innerHTML += '<div data-message-author-role="user" data-message-id="other-user">Other request</div><div data-message-author-role="assistant" data-message-id="other-answer" data-end-turn="true">Wrong answer</div>'; });
    assert.equal(((await latest('later-turn')).structuredContent.answerRecovery as any).terminal, false);
    assert.deepEqual(rows(), before);
    assert.equal(fake.submitCount, 1);
    assert.equal(navigations, 1);

    // Replay Areum's quiet-final -> prepared successor -> explicit idle timeout.
    const reconcile = (id: string) => invokeMcpTool({ name: 'sessionplane_decide', arguments: {
      teamId: team.teamId, requestRef: original.outbox_id, requestId: id, decision: 'reconcile_failure' },
      socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend',
      '<div role="alert" id="timeout">메시지 전송 시간이 초과되었습니다. 다시 시도하세요.</div>'));
    await page.locator('textarea').fill('');
    assert.equal((await reconcile('later-user-failure')).isError, true);
    await page.locator('[data-message-id="other-user"], [data-message-id="other-answer"], [data-message-id="actual-final"]').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    await page.locator('textarea').fill('Preserved draft');
    assert.equal((await reconcile('draft-failure')).isError, true);
    assert.equal(await page.locator('textarea').inputValue(), 'Preserved draft');
    await page.locator('textarea').fill('');
    await page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<button id="running" aria-label="Stop">Stop</button>'));
    assert.equal((await reconcile('active-failure')).isError, true);
    await page.locator('#running').evaluate(node => node.remove());
    assert.deepEqual(rows(), before);
    const sessions = new SessionRepository(core.database.raw);
    assert.equal(sessions.getUniqueConversationSession(`conversation-${session.sessionId}`)?.sessionId, session.sessionId,
      'Restored unbound tabs retain exact durable conversation ownership for grouping');
    assert.equal(sessions.getUniqueConversationSession('unmanaged-conversation'), null,
      'Unmanaged tabs cannot inherit a team from title or recency');
    const timestamp = (core.database.raw.prepare('SELECT updated_at FROM sessions WHERE session_id=?').get(session.sessionId) as { updated_at: string }).updated_at;
    await page.locator('#messages').evaluate(node => { node.innerHTML =
      '<div data-message-author-role="user" data-message-id="user-message-1">Review</div>' +
      '<div data-message-author-role="assistant" data-message-id="work-partial">Original work details</div>' +
      '<div data-message-author-role="user" data-message-id="unclaimed-continue">계속</div>' +
      '<div data-message-author-role="assistant" data-message-id="work-answer">Original work result proc_123</div>' +
      '<div data-message-author-role="user" data-message-id="unrelated">Different work</div>' +
      '<div data-message-author-role="assistant" data-message-id="wrong-answer">Unrelated answer</div>'; });
    sessions.updateCurrentGeneration(session.sessionId, 2, { submissionState: 'submission_unknown', promptSubmitted: true }, timestamp);
    const currentRows = rows();
    const workRead = await invokeMcpTool({ name: 'sessionplane_team_get', arguments: { view: 'evidence',
      teamId: team.teamId, requestRef: original.outbox_id }, socketPath: config.socketPath,
      timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    const work = (workRead.structuredContent.request as any).workResult;
    assert.equal(work.originalAnchorPresent, true);
    assert.equal(work.responseUserMessageId, 'unclaimed-continue');
    assert.equal(work.observedMessages.at(-1).text, 'Original work result proc_123');
    assert.equal(work.observedMessages.some((message: any) => message.messageId === 'wrong-answer'), false);
    assert.equal(work.providerMutation, false);
    assert.deepEqual(rows(), currentRows, 'Historical read preserves UNKNOWN successor and immutable original');
    await page.locator('#messages').evaluate(node => { node.innerHTML =
      '<div data-message-author-role="user" data-message-id="user-message-1">Review</div>' +
      '<div data-message-author-role="assistant" data-message-id="announcement">I will review the evidence.</div>'; });
    for (const submissionState of ['submitted', 'submission_unknown'] as const) {
      sessions.updateCurrentGeneration(session.sessionId, 2, { submissionState, promptSubmitted: true }, timestamp);
      assert.equal((await reconcile(`protect-${submissionState}`)).isError, true,
        'A submitted or uncertain successor must never be reconciled through its predecessor');
    }
    sessions.updateCurrentGeneration(session.sessionId, 2, { submissionState: 'prepared', promptSubmitted: false }, timestamp);
    assert.deepEqual(rows(), before);
    const closed = await reconcile('close-historical-timeout');
    assert.equal(closed.isError, false, JSON.stringify(closed));
    const closure = closed.structuredContent.reconciliation as any;
    assert.equal(closure.historical, true);
    assert.equal(closure.disposition, 'failed');
    assert.equal(closure.providerMutation, false);
    assert.equal(closure.successorSubmitted, false);
    assert.equal(closure.successorRequestRef, before.outbox[1]!.outbox_id);
    assert.deepEqual(rows(), before, 'Closure preserves the original result and unsubmitted successor');
    assert.deepEqual((await reconcile('close-historical-timeout')).structuredContent.reconciliation, closure);
    const read = await invokeMcpTool({ name: 'sessionplane_team_get', arguments: { view: 'evidence',
      teamId: team.teamId, requestRef: original.outbox_id }, socketPath: config.socketPath,
      timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    const failed = read.structuredContent.request as any;
    assert.equal(failed.terminal, true);
    assert.equal(failed.errorCode, 'provider.execution-failed');
    assert.equal(failed.answerText, null);
    assert.equal(failed.storedResult.responseMessageId, 'announcement');
    assert.equal(fake.submitCount, 1);
    assert.equal(navigations, 1);

    // A literal recovery attempt can remain UNKNOWN after the original work
    // final is readable. Reconciliation releases tracking without inventing ACKs.
    core.database.raw.prepare('UPDATE generations SET answer_text=NULL,response_message_id=NULL WHERE session_id=? AND generation=1').run(session.sessionId);
    const successorPayload = JSON.parse(before.outbox[1]!.payload_json);
    core.database.raw.prepare('UPDATE outbox SET payload_json=? WHERE session_id=? AND generation=2')
      .run(JSON.stringify({ ...successorPayload, prompt: '계속', continuationOf: original.outbox_id }), session.sessionId);
    sessions.updateCurrentGeneration(session.sessionId, 2, { sessionState: 'observing', submissionState: 'submission_unknown',
      promptSubmitted: true, submittedUserMessageId: null, submittedUserTurnId: null, answerText: null,
      responseMessageId: null }, timestamp);
    await page.locator('#timeout').evaluate(node => node.remove());
    await page.locator('#messages').evaluate(node => { node.innerHTML =
      '<div data-message-author-role="user" data-message-id="user-message-1">Review</div>' +
      '<div data-message-author-role="assistant" data-message-id="work-final">Completed original work</div>'; });
    const finishWork = (id: string) => invokeMcpTool({ name: 'sessionplane_decide', arguments: {
      teamId: team.teamId, requestRef: original.outbox_id, requestId: id, decision: 'reconcile_followup',
      followupUserMessageId: 'user-message-1', responseMessageId: 'work-final', followupCompleted: true,
      responseSha256: createHash('sha256').update('Completed original work').digest('hex') },
      socketPath: config.socketPath, timeoutMs: 10000, maxLineBytes: config.rpcMaxLineBytes });
    await page.locator('textarea').fill('Preserve draft');
    assert.equal((await finishWork('draft-protected')).isError, true);
    await page.locator('textarea').fill('');
    await page.locator('#messages').evaluate(node => { node.innerHTML +=
      '<div data-message-author-role="user" data-message-id="new-work">Other work</div>'; });
    assert.equal((await finishWork('new-work-protected')).isError, true);
    await page.locator('[data-message-id="new-work"]').evaluate(node => node.remove());
    const unknownOutbox = rows().outbox[1];
    await page.locator('textarea').fill('계속');
    const released = await finishWork('release-work-tracking');
    assert.equal(released.isError, false, JSON.stringify(released));
    assert.equal((released.structuredContent.reconciliation as any).disposition, 'tracking-cancelled');
    assert.equal(await page.locator('textarea').inputValue(), '계속', 'Retiring tracking preserves the unsent recovery draft');
    assert.equal(core.teamDirectory.getSession(session.sessionId).sessionState, 'cancelled');
    assert.equal(core.teamDirectory.getSession(session.sessionId).submissionState, 'submission_unknown');
    assert.equal(core.teamDirectory.getSession(session.sessionId).submittedUserMessageId, null);
    assert.deepEqual(rows().outbox[1], unknownOutbox, 'Original delivery uncertainty is not acknowledged or rewritten');
    t.mock.method(fake, 'openSubmission', async () => { throw new SessionPlaneDomainError('provider.preparation-required', 'Prepare next distinct work'); });
    await assert.rejects(core.submissionService.send({ clientId: 'fixture-owner', requestId: 'next-distinct-work',
      sessionId: session.sessionId, expectedGeneration: 2, prompt: 'Next authorized work', sessionDeadlineSec: 600 }),
      /caller decision/);
    assert.equal(core.teamDirectory.getSession(session.sessionId).generation, 3, 'Next work is admitted rather than session.busy');
    const reconciledRows = rows();
    await page.goto('https://chatgpt.com/c/foreign-conversation');
    assert.equal((await latest('wrong-conversation')).structuredContent.requestOk, false);
    assert.deepEqual(rows(), reconciledRows);
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
});
