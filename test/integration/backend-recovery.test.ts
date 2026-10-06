import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import type {
  ProviderObservationRequest,
  ProviderRecoveryRequest,
  ProviderRecoveryResult,
} from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface WaitSnapshot extends SessionSnapshot {
  readonly latestEventSequence: number;
}

test('human follow-up final completes the same durable request after restart without resubmission', async () => {
  const fixture = await createFixture('sessionplane-human-followup-');
  let service = fixture.service;
  try {
    const { session } = await createSession(fixture.config.socketPath, 'main', 'human-followup');
    await send(fixture.config.socketPath, session.sessionId, 'human-followup');
    const submitted = service.teamDirectory.getSession(session.sessionId);
    await service.close();
    service = await startCore({ config: fixture.config, startBrowser: false,
      providerAdapters: [fixture.fake], logger: silentLogger() });
    fixture.fake.emitObservation(session.sessionId, {
      laterUserFound: true, submittedUserFound: true, activity: 'none',
      candidate: { responseMessageId: 'human-followup-final', answerText: 'Finished after human intervention',
        terminalMarker: true, streamingMarker: false },
    });
    const final = await waitForSnapshot(fixture.config.socketPath, session.sessionId, s => s.terminal);
    assert.equal(final.responseMessageId, 'human-followup-final');
    assert.equal(final.answerText, 'Finished after human intervention');
    assert.equal(final.generation, submitted.generation);
    assert.equal(final.submittedUserMessageId, submitted.submittedUserMessageId);
    assert.equal(fixture.fake.submitCount, 1);
    await send(fixture.config.socketPath, session.sessionId, 'next-managed-request');
    await assert.rejects(service.actorScheduler.updateGeneration(session.sessionId, final.generation,
      { answerText: 'Late old answer', sessionState: 'complete' }), /stale/);
    assert.equal(service.teamDirectory.getSession(session.sessionId).answerText, null);
  } finally { await service.close(); rmSync(fixture.root, { recursive: true, force: true }); }
});

test('workflow reads expose provider alert text separately from backend 429 and exact recovery', async (t) => {
  class AlertProvider extends FakeProviderAdapter {
    alertActive = true;
    override async openObservation(request: ProviderObservationRequest) {
      const source = await super.openObservation(request);
      const observe = source.observe.bind(source);
      source.observe = async () => ({ ...await observe(), ...(this.alertActive ? {
        observationTransport: 'unavailable' as const, errorCode: 'provider.actionable-alert',
        reason: 'provider-actionable-alert', activity: 'unknown' as const, candidate: null,
      } : { observationTransport: 'fresh' as const, errorCode: undefined, reason: null }) });
      return source;
    }
  }
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-workflow-alert-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', backendRecoveryAfterMs: 10,
    observationActiveSweepMs: 5, observationQuietSweepMs: 5, probeSuccessIntervalMs: 1,
    probeMin429BackoffMs: 100, probeMax429BackoffMs: 100 });
  const fake = new AlertProvider();
  const service = await startCore({ config, browserHeadless: true, providerAdapters: [fake], logger: silentLogger() });
  const backendSnapshots: SessionSnapshot[] = [];
  const update = service.actorScheduler.updateGeneration.bind(service.actorScheduler);
  t.mock.method(service.actorScheduler, 'updateGeneration', async (...args: Parameters<typeof update>) => {
    const snapshot = await update(...args);
    if (args[3] === 'generation.backend-deferred') backendSnapshots.push(snapshot);
    return snapshot;
  });
  const workflow = <T>(method: string, params: object) => rpc<T>(config.socketPath, 'workflow.' + method, params);
  try {
    const { teamId, session } = await createSession(config.socketPath, 'main', 'visible-error');
    fake.queueRecovery(session.sessionId, { kind: 'deferred', observationTransport: 'deferred',
      responseMessageId: null, answerText: null, reason: 'backend-http-429', retryAfterMs: 100, nextCheckAt: null });
    await send(config.socketPath, session.sessionId, 'visible-error');
    const current = service.teamDirectory.getSession(session.sessionId);
    const page = await service.browserOwner!.createPage();
    await page.page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html',
      body: '<main><textarea></textarea></main><aside role="alert">network error</aside>' }));
    await page.page.goto('https://chatgpt.com/c/' + current.conversationId);
    service.pageRegistry.bindPage(page.binding.pageKey, { sessionId: session.sessionId, generation: 1,
      conversationId: current.conversationId! });
    await service.actorScheduler.updateGeneration(session.sessionId, 1, { pageKey: page.binding.pageKey });
    const requestRef = (service.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id = ?')
      .get(session.sessionId) as { outbox_id: string }).outbox_id;
    await waitForSnapshot(config.socketPath, session.sessionId, state =>
      state.errorCode === 'provider.actionable-alert' && backendSnapshots.length > 0);
    assert.equal(backendSnapshots[0]!.observationTransport, 'deferred');
    assert.equal(backendSnapshots[0]!.errorCode, 'provider.actionable-alert');
    assert.equal(backendSnapshots[0]!.reason, 'provider-actionable-alert');
    const deferredEvent = service.database.raw.prepare(
      "SELECT payload_json FROM events WHERE session_id = ? AND event_type = 'generation.backend-deferred' ORDER BY sequence DESC LIMIT 1",
    ).get(session.sessionId) as { payload_json: string };
    assert.equal(JSON.parse(deferredEvent.payload_json).recoveryReason, 'backend-http-429');
    const read = await workflow<{ request: SessionSnapshot & { evidence: { providerAlerts: string[] } } }>(
      'team_get', { teamId, requestRef });
    assert.equal(read.request.errorCode, 'provider.actionable-alert');
    assert.equal(read.request.reason, 'provider-actionable-alert');
    assert.equal(read.request.terminal, false);
    assert.deepEqual(read.request.evidence.providerAlerts, ['network error']);
    const waited = await workflow<{ results: Array<SessionSnapshot & { evidence: { providerAlerts: string[] } }> }>(
      'wait', { teamId, requestRefs: [requestRef], waitMs: 5 });
    assert.equal(waited.results[0]!.errorCode, 'provider.actionable-alert');
    assert.deepEqual(waited.results[0]!.evidence.providerAlerts, ['network error']);
    fake.queueRecovery(session.sessionId, { kind: 'unavailable', observationTransport: 'unavailable',
      responseMessageId: null, answerText: null, reason: 'backend-auth-rejected',
      retryAfterMs: null, nextCheckAt: null });
    await waitForSnapshot(config.socketPath, session.sessionId, () => !!service.database.raw.prepare(
      "SELECT 1 FROM events WHERE session_id = ? AND event_type = 'generation.backend-unavailable' AND json_extract(payload_json, '$.recoveryReason') = 'backend-auth-rejected'",
    ).get(session.sessionId));
    fake.queueRecovery(session.sessionId, { kind: 'complete', observationTransport: 'fresh',
      responseMessageId: 'exact-alert-recovery', answerText: 'Recovered exact final',
      reason: 'backend-exact-final', retryAfterMs: null, nextCheckAt: null });
    const final = await waitForSnapshot(config.socketPath, session.sessionId, state => state.terminal);
    assert.equal(final.errorCode, null);
    assert.equal(final.answerText, 'Recovered exact final');
    assert.equal(fake.submitCount, 1);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('explicit failure reconciliation preserves submission, rejects unproved/live errors and permits one next same-chat send', async () => {
  class FailedProvider extends FakeProviderAdapter {
    override async openObservation(request: ProviderObservationRequest) {
      const source = await super.openObservation(request);
      const observe = source.observe.bind(source);
      source.observe = async () => ({ ...await observe(), observationTransport: 'unavailable' as const,
        errorCode: 'provider.actionable-alert', reason: 'provider-actionable-alert', activity: 'unknown' as const, candidate: null });
      return source;
    }
  }
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-failure-reconcile-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', backendRecoveryAfterMs: 60_000 });
  const fake = new FailedProvider();
  let service = await startCore({ config, browserHeadless: true, providerAdapters: [fake], logger: silentLogger() });
  const workflow = <T>(method: string, params: object) => rpc<T>(config.socketPath, 'workflow.' + method, params);
  try {
    const { teamId, session } = await createSession(config.socketPath, 'main', 'failed-review');
    await send(config.socketPath, session.sessionId, 'failed-review');
    const original = service.teamDirectory.getSession(session.sessionId);
    const { page, binding } = await service.browserOwner!.createPage();
    await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
    await page.goto('https://chatgpt.com/c/' + original.conversationId);
    service.pageRegistry.bindPage(binding.pageKey, { sessionId: session.sessionId, generation: 1, conversationId: original.conversationId! });
    await service.actorScheduler.updateGeneration(session.sessionId, 1, { pageKey: binding.pageKey });
    await waitForSnapshot(config.socketPath, session.sessionId, state => state.errorCode === 'provider.actionable-alert');
    const requestRef = (service.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=?').get(session.sessionId) as { outbox_id: string }).outbox_id;
    const user = `<div data-message-author-role="user" data-message-id="${original.submittedUserMessageId}">Question</div>`;
    const failure = '<div class="group/activity-header"><button aria-labelledby="fail"></button><span id="fail">Thinking failed</span></div>';
    const choose = { teamId, requestRef, requestId: 'close-failure', decision: 'reconcile_failure' };
    for (const [name, body] of [
      ['general timeout', `${user}<div role="alert">Request timed out</div>`],
      ['refusal', `${user}<div data-message-author-role="assistant" data-message-id="refusal" data-end-turn="true">I cannot help</div>`],
      ['ordinary words', `${user}<div data-message-author-role="assistant" data-message-id="ordinary"><div class="markdown">Thinking failed</div></div>`],
      ['missing anchor', failure], ['historical error', failure + user],
      ['auth alert', `${user}${failure}<aside role="alert">Sign in to continue</aside>`],
      ['verification dialog', `${user}${failure}<div role="dialog">Verify you are human</div>`],
      ['safety alert', `${user}${failure}<aside role="alert">Request blocked</aside>`],
      ['live stop', `${user}${failure}<button aria-label="Stop generating">Stop</button>`],
      ['live thinking', `${user}${failure}<span data-testid="thinking">Thinking</span>`],
      ['later user', `${user}${failure}<div data-message-author-role="user" data-message-id="later">Continue</div>`],
      ['final candidate', `${user}${failure}<div data-message-author-role="assistant" data-message-id="final" data-end-turn="true">Answer</div>`],
      ['quoted header', `${user}<div class="markdown">${failure}</div>`],
      ['hidden error', `${user}<div hidden>${failure}</div>`],
      ['closed composer', `${user}${failure}`],
    ]) {
      await page.setContent(`<main>${body}<textarea></textarea></main>`);
      if (name === 'closed composer') await page.locator('textarea').evaluate(node => node.remove());
      await assert.rejects(workflow('decide', choose), /Thinking failed|unverified/i, name);
      assert.equal(service.teamDirectory.getSession(session.sessionId).terminal, false, name);
      assert.equal(service.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE request_id='close-failure'").get()!.n, 0);
    }
    await page.setContent(`<main>${user}${failure}<textarea></textarea></main>`);
    const result = await workflow<SessionSnapshot & { reconciliation: { evidence: { providerAlerts: string[] } } }>('decide', choose);
    assert.equal(result.sessionState, 'failed'); assert.equal(result.terminal, true);
    assert.equal(result.submissionState, 'submitted'); assert.equal(result.promptSubmitted, true);
    assert.equal(result.errorCode, 'provider.execution-failed'); assert.equal(result.responseMessageId, null);
    assert.equal(result.answerText, null); assert.equal(result.submittedUserMessageId, original.submittedUserMessageId);
    assert.deepEqual(result.reconciliation.evidence.providerAlerts, ['Thinking failed']);
    assert.equal((await workflow<SessionSnapshot>('decide', choose)).terminal, true);
    await assert.rejects(workflow('decide', { ...choose, decision: 'focus' }), /identity|arguments|different/i);
    await assert.rejects(service.actorScheduler.updateGeneration(session.sessionId, 1, { sessionState: 'observing' }), /terminal/i);
    assert.equal(service.database.raw.prepare("SELECT count(*) AS n FROM events WHERE event_type='generation.failure-reconciled'").get()!.n, 1);
    await service.close();
    service = await startCore({ config, startBrowser: false, providerAdapters: [fake], logger: silentLogger() });
    const restored = service.teamDirectory.getSession(session.sessionId);
    assert.equal(restored.terminal, true); assert.equal(restored.submittedUserMessageId, original.submittedUserMessageId);
    const followup = { teamId, roleRef: `${session.sessionId}:1`, requestId: 'next-analysis-only', prompt: 'Continue without execution', model: '5.6 Pro', sessionDeadlineSec: 60 };
    await workflow('send', followup); await workflow('send', followup);
    assert.equal(fake.submitCount, 2, 'One original and one idempotent next generation; no replay');
    assert.equal(service.teamDirectory.getSession(session.sessionId).generation, 2);
    await assert.rejects(workflow('decide', { ...choose, requestId: 'stale-close' }), /current|superseded/i);
    const saved = service.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(session.sessionId)!;
    assert.equal(saved.submitted_user_message_id, original.submittedUserMessageId);
    assert.equal(saved.prompt_submitted, 1); assert.equal(saved.error_code, 'provider.execution-failed');
    assert.equal(saved.response_message_id, null);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an unresponsive renderer cannot block exact backend completion or core shutdown', { timeout: 5_000 }, async () => {
  class HungRenderer extends FakeProviderAdapter {
    override async openObservation(request: ProviderObservationRequest) {
      const source = await super.openObservation(request);
      source.observe = () => new Promise(() => {});
      return source;
    }
  }
  const fixture = await createFixture('sessionplane-hung-renderer-', new HungRenderer());
  try {
    const { session } = await createSession(fixture.config.socketPath, 'main', 'hung-renderer');
    fixture.fake.queueRecovery(session.sessionId, {
      kind: 'complete', observationTransport: 'fresh', responseMessageId: 'exact-server-final',
      answerText: 'Recovered with the renderer unresponsive', reason: 'backend-exact-final',
      retryAfterMs: null, nextCheckAt: null,
    });
    await send(fixture.config.socketPath, session.sessionId, 'hung-renderer');
    const final = await waitForSnapshot(fixture.config.socketPath, session.sessionId, state => state.terminal);
    assert.equal(final.answerText, 'Recovered with the renderer unresponsive');
    assert.equal(final.responseMessageId, 'exact-server-final');
    assert.equal(final.errorCode, null);
    const pending = await createSession(fixture.config.socketPath, 'main', 'hung-shutdown');
    await send(fixture.config.socketPath, pending.session.sessionId, 'hung-shutdown');
  } finally {
    await fixture.service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('stale DOM recovers an exact server final and backend 429 remains deferred, not blocked', async () => {
  const fixture = await createFixture('sessionplane-backend-recovery-');
  const { config, fake, service } = fixture;
  try {
    const { teamId, session } = await createSession(config.socketPath, 'main', 'primary');
    fake.queueRecovery(session.sessionId, {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: 'server-assistant-1',
      answerText: 'Recovered exact server final',
      reason: 'backend-exact-final',
      retryAfterMs: null,
      nextCheckAt: null,
    });
    await send(config.socketPath, session.sessionId, 'recover-final');

    const complete = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.terminal,
    );
    assert.equal(complete.sessionState, 'complete');
    assert.equal(complete.providerState, 'complete');
    assert.equal(complete.responseMessageId, 'server-assistant-1');
    assert.equal(complete.answerText, 'Recovered exact server final');
    assert.equal(fake.recoveryCount, 1);

    await rpc(config.socketPath, 'team.role.create', {
      clientId: 'backend-client',
      requestId: 'role-429',
      teamId,
      roleKey: 'expert.backend',
      roleType: 'expert',
      reportsToRoleKey: 'main',
    });
    const limitedSession = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'backend-client',
      requestId: 'session-429',
      teamId,
      roleKey: 'expert.backend',
      provider: 'chatgpt',
    });
    fake.queueRecovery(limitedSession.sessionId, {
      kind: 'deferred',
      observationTransport: 'deferred',
      responseMessageId: null,
      answerText: null,
      reason: 'backend-http-429',
      retryAfterMs: 100,
      nextCheckAt: null,
    });
    const beforeLimited = fake.recoveryCount;
    await send(config.socketPath, limitedSession.sessionId, 'recover-429');
    const deferred = await waitForSnapshot(
      config.socketPath,
      limitedSession.sessionId,
      (snapshot) =>
        snapshot.observationTransport === 'deferred' &&
        snapshot.reason === 'backend-http-429',
    );
    assert.equal(deferred.providerState, 'unknown');
    assert.equal(deferred.terminal, false);
    assert.equal(deferred.errorCode, null);
    assert.notEqual(deferred.nextCheckAt, null);
    assert.equal(fake.recoveryCount, beforeLimited + 1);

    fake.emitObservation(limitedSession.sessionId, {
      activity: 'strong',
      candidate: null,
      networkActivity: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const afterSpinner = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'backend-client',
      sessionId: limitedSession.sessionId,
    });
    assert.equal(afterSpinner.observationTransport, 'deferred');
    assert.equal(afterSpinner.providerState, 'unknown');

    fake.emitObservation(limitedSession.sessionId, {
      submittedUserFound: false, candidate: null, activity: 'unknown',
      observationTransport: 'unavailable',
      errorCode: 'provider.conversation-unavailable',
      reason: 'conversation-surface-unavailable',
    });
    const unreadable = await waitForSnapshot(config.socketPath, limitedSession.sessionId,
      (snapshot) => snapshot.errorCode === 'provider.conversation-unavailable');
    assert.equal(unreadable.terminal, false);
    assert.equal(unreadable.providerState, 'unknown');
    assert.equal(unreadable.reason, 'conversation-surface-unavailable');
    assert.equal(unreadable.submittedUserMessageId, deferred.submittedUserMessageId);
    fake.emitObservation(limitedSession.sessionId, {
      submittedUserFound: true, activity: 'weak', observationTransport: 'fresh',
      errorCode: undefined, reason: null,
      candidate: { responseMessageId: 'restored-answer', answerText: 'Recovered', terminalMarker: true, streamingMarker: false },
    });
    const restored = await waitForSnapshot(config.socketPath, limitedSession.sessionId,
      (snapshot) => snapshot.terminal);
    assert.equal(restored.errorCode, null);
    assert.equal(restored.answerText, 'Recovered');
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('spinner without an assistant candidate does not suppress exact backend recovery', async () => {
  const fixture = await createFixture('sessionplane-backend-activity-');
  const { config, fake, service } = fixture;
  try {
    const { session } = await createSession(config.socketPath, 'main', 'activity');
    fake.queueRecovery(session.sessionId, {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: 'server-after-activity',
      answerText: 'Recovered after activity stopped',
      reason: 'backend-exact-final',
      retryAfterMs: null,
      nextCheckAt: null,
    });
    await send(config.socketPath, session.sessionId, 'strong-activity');

    fake.emitObservation(session.sessionId, {
      activity: 'strong',
      candidate: null,
      networkActivity: false,
    });

    const complete = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.terminal,
    );
    assert.equal(complete.answerText, 'Recovered after activity stopped');
    assert.equal(fake.recoveryCount, 1);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('an expired submitted generation still delivers its later final answer', async () => {
  const fixture = await createFixture('sessionplane-expired-observation-');
  const { config, fake, service } = fixture;
  try {
    const { session } = await createSession(config.socketPath, 'main', 'expired');
    await send(config.socketPath, session.sessionId, 'expired', 1);

    const expired = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.reason === 'session-deadline-unverified',
    );
    assert.equal(expired.providerState, 'unknown');
    assert.equal(expired.terminal, false);
    assert.equal(expired.promptSubmitted, true);
    fake.emitObservation(session.sessionId, {
      candidate: {
        responseMessageId: 'assistant-after-deadline',
        answerText: 'Completed after the deadline',
        terminalMarker: true,
        streamingMarker: false,
      },
      activity: 'none',
    });
    const completed = await waitForSnapshot(config.socketPath, session.sessionId, (snapshot) => snapshot.terminal);
    assert.equal(completed.answerText, 'Completed after the deadline');
    assert.equal(completed.responseMessageId, 'assistant-after-deadline');
    assert.equal(fake.submitCount, 1);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});


test('future probe nextCheckAt suppresses repeated paced recovery calls until due', async (t) => {
  const fixture = await createFixture(
    'sessionplane-backend-pacing-',
    new FakeProviderAdapter(),
    {
      backendRecoveryAfterMs: 15,
      observationActiveSweepMs: 5,
      observationQuietSweepMs: 5,
      probeSuccessIntervalMs: 180,
    },
  );
  const { config, fake, service } = fixture;
  try {
    const { session } = await createSession(config.socketPath, 'main', 'pacing');
    fake.queueRecovery(session.sessionId, {
      kind: 'pending',
      observationTransport: 'fresh',
      responseMessageId: null,
      answerText: null,
      reason: 'backend-pending',
      retryAfterMs: null,
      nextCheckAt: null,
    });
    fake.queueRecovery(session.sessionId, {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: 'server-after-pacing',
      answerText: 'Recovered after pacing window',
      reason: 'backend-exact-final',
      retryAfterMs: null,
      nextCheckAt: null,
    });

    await send(config.socketPath, session.sessionId, 'paced-recovery');
    const paced = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.nextCheckAt !== null && snapshot.terminal === false,
    );
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    assert.notEqual(paced.nextCheckAt, null);
    assert.equal(fake.recoveryCount, 1);

    const before = await rpc<{
      readonly metrics: Readonly<Record<string, number>>;
    }>(config.socketPath, 'system.health', {});
    await new Promise((resolve) => setTimeout(resolve, 70));
    const during = await rpc<{
      readonly metrics: Readonly<Record<string, number>>;
    }>(config.socketPath, 'system.health', {});
    assert.equal(
      during.metrics.backend_probe_deferred_total,
      before.metrics.backend_probe_deferred_total,
    );
    assert.equal(fake.recoveryCount, 1);

    t.mock.timers.tick(Date.parse(paced.nextCheckAt!) - Date.now() + 1);
    const complete = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.terminal,
    );
    assert.equal(complete.answerText, 'Recovered after pacing window');
    assert.equal(fake.recoveryCount, 2);
  } finally {
    t.mock.timers.reset();
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('DOM completion clears a previously persisted backend nextCheckAt', async () => {
  const fixture = await createFixture(
    'sessionplane-dom-complete-clears-pacing-',
    new FakeProviderAdapter(),
    {
      backendRecoveryAfterMs: 15,
      observationActiveSweepMs: 5,
      observationQuietSweepMs: 5,
      probeSuccessIntervalMs: 5_000,
    },
  );
  const { config, fake, service } = fixture;
  try {
    const { session } = await createSession(config.socketPath, 'main', 'dom-clears-pacing');
    fake.queueRecovery(session.sessionId, {
      kind: 'pending',
      observationTransport: 'fresh',
      responseMessageId: null,
      answerText: null,
      reason: 'backend-pending',
      retryAfterMs: null,
      nextCheckAt: null,
    });
    await send(config.socketPath, session.sessionId, 'dom-clears-pacing');
    const paced = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.nextCheckAt !== null && !snapshot.terminal,
    );
    assert.notEqual(paced.nextCheckAt, null);

    fake.emitObservation(session.sessionId, {
      candidate: {
        responseMessageId: 'dom-final-after-pacing',
        answerText: 'DOM completed after backend pacing',
        terminalMarker: true,
        streamingMarker: false,
      },
      activity: 'none',
    });
    const complete = await waitForSnapshot(
      config.socketPath,
      session.sessionId,
      (snapshot) => snapshot.terminal,
    );
    assert.equal(complete.reason, 'dom-terminal-marker');
    assert.equal(complete.nextCheckAt, null);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('concurrent same-account recovery preserves each session final', async () => {
  const fake = new DelayedPerSessionRecoveryAdapter(80);
  const fixture = await createFixture('sessionplane-backend-isolation-', fake);
  const { config, service } = fixture;
  try {
    const alpha = await createSession(config.socketPath, 'alpha', 'isolation-alpha');
    const beta = await createSession(config.socketPath, 'beta', 'isolation-beta');

    await Promise.all([
      send(config.socketPath, alpha.session.sessionId, 'isolation-alpha'),
      send(config.socketPath, beta.session.sessionId, 'isolation-beta'),
    ]);

    const [alphaFinal, betaFinal] = await Promise.all([
      waitForSnapshot(config.socketPath, alpha.session.sessionId, (snapshot) => snapshot.terminal),
      waitForSnapshot(config.socketPath, beta.session.sessionId, (snapshot) => snapshot.terminal),
    ]);

    assert.equal(alphaFinal.answerText, `answer:${alpha.session.sessionId}`);
    assert.equal(betaFinal.answerText, `answer:${beta.session.sessionId}`);
    assert.equal(alphaFinal.responseMessageId, `response:${alpha.session.sessionId}`);
    assert.equal(betaFinal.responseMessageId, `response:${beta.session.sessionId}`);
    assert.equal(fake.recoveryCount, 2);
  } finally {
    await service.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(
  prefix: string,
  fake: FakeProviderAdapter = new FakeProviderAdapter(),
  timing: {
    readonly observationActiveSweepMs?: number;
    readonly observationQuietSweepMs?: number;
    readonly backendRecoveryAfterMs?: number;
    readonly probeSuccessIntervalMs?: number;
  } = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    backendRequestTimeoutMs: 100,
    observationActiveSweepMs: timing.observationActiveSweepMs ?? 10,
    observationQuietSweepMs: timing.observationQuietSweepMs ?? 10,
    observationQuietWindowMs: 5,
    backendRecoveryAfterMs: timing.backendRecoveryAfterMs ?? 30,
    probeSuccessIntervalMs: timing.probeSuccessIntervalMs ?? 1,
    probeMin429BackoffMs: 100,
    probeMax429BackoffMs: 100,
  });
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });
  return { root, config, fake, service };
}

class DelayedPerSessionRecoveryAdapter extends FakeProviderAdapter {
  readonly #delayMs: number;

  constructor(delayMs: number) {
    super('chatgpt');
    this.#delayMs = delayMs;
  }

  override async recover(request: ProviderRecoveryRequest): Promise<ProviderRecoveryResult> {
    this.recoveryCount += 1;
    await new Promise((resolve) => setTimeout(resolve, this.#delayMs));
    return {
      kind: 'complete',
      observationTransport: 'fresh',
      responseMessageId: `response:${request.session.sessionId}`,
      answerText: `answer:${request.session.sessionId}`,
      reason: 'fake-session-isolated-final',
      retryAfterMs: null,
      nextCheckAt: null,
    };
  }
}

async function createSession(socketPath: string, roleKey: string, suffix: string) {
  const team = await rpc<TeamSnapshot>(socketPath, 'team.create', {
    clientId: 'backend-client',
    requestId: `team-${suffix}`,
    name: `Backend ${suffix}`,
    primaryRoleKey: roleKey,
  });
  const session = await rpc<SessionSnapshot>(socketPath, 'session.create', {
    clientId: 'backend-client',
    requestId: `session-${suffix}`,
    teamId: team.teamId,
    roleKey,
    provider: 'chatgpt',
  });
  return { teamId: team.teamId, session };
}

async function send(socketPath: string, sessionId: string, suffix: string, deadlineSec = 600): Promise<void> {
  await rpc(socketPath, 'session.send', {
    clientId: 'backend-client',
    requestId: `send-${suffix}`,
    sessionId,
    prompt: `Backend recovery ${suffix}`,
    sessionDeadlineSec: deadlineSec,
  });
}

async function waitForSnapshot(
  socketPath: string,
  sessionId: string,
  predicate: (snapshot: WaitSnapshot) => boolean,
): Promise<WaitSnapshot> {
  let cursor = 0;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const snapshot = await rpc<WaitSnapshot>(socketPath, 'session.wait', {
      clientId: 'backend-client',
      sessionId,
      afterEventSequence: cursor,
      waitMs: 25,
    });
    cursor = Math.max(cursor, snapshot.latestEventSequence);
    if (predicate(snapshot)) {
      return snapshot;
    }
  }
  throw new Error('Timed out waiting for backend recovery state');
}

async function rpc<Result>(socketPath: string, method: string, params: unknown): Promise<Result> {
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 5_000 });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
