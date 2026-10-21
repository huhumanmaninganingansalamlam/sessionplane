import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { SessionUiService } from '../../src/core/session-ui-service.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { ConversationLoadRecoveryRepository } from '../../src/storage/conversation-load-recovery-repository.ts';
import { workflowWaitOutcome } from '../../src/domain/workflow-wait.ts';
import { runCli } from '../../src/cli/main.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { invokeMcpTool } from '../../src/mcp/tools.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-outcome-wait-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', observationActiveSweepMs: 600_000 });
  const fake = new FakeProviderAdapter();
  const core = await startCore({ config, startBrowser: false, providerAdapters: [fake],
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const invoke = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) =>
    await invokeMcpTool({ name: 'sessionplane_' + name, arguments: args, socketPath: config.socketPath,
      timeoutMs: 5000, maxLineBytes: config.rpcMaxLineBytes, ...(signal ? { signal } : {}) });
  const team = (await invoke('team_create', { requestId: 'team' })).structuredContent;
  const sent = (await invoke('send', { teamId: team.teamId,
    roleRef: (team.roles as any[])[0].roleRef, requestId: 'send', prompt: 'Wait for the existing answer' })).structuredContent;
  const untilSubscribed = async (sessionId: string) => {
    for (let i = 0; i < 100; i++) {
      if (core.actorScheduler.actorFor(sessionId).subscriberCount) return;
      await flush();
    }
    assert.fail('Wait did not subscribe');
  };
  return { core, config, fake, invoke, team, sent, untilSubscribed,
    close: async () => { await core.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('short workflow wait holds progress/429 for a full minute and cancellation only releases its subscription', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let returned = false;
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef], waitMs: 20_000, untilResult: false })
      .then(r => { returned = true; return r; });
    await f.untilSubscribed(f.sent.sessionId as string);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { reason: 'backend-http-429', observationTransport: 'deferred' });
    await flush();
    await flush();
    assert.equal(returned, false, 'Transient progress must not wake the model');
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { reason: 'provider-network-activity', observationTransport: 'dom' });
    await flush();
    await flush();
    assert.equal(returned, false, 'Hither provider-network-activity must stay inside the external wait');
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { errorCode: 'provider.observation-unavailable', reason: 'dom-observation-timeout',
        providerState: 'unknown', observationTransport: 'unavailable' });
    await flush();
    await flush();
    assert.equal(returned, false, 'A DOM observation timeout must not expire the caller wait');
    t.mock.timers.tick(59_999);
    await flush();
    assert.equal(returned, false, 'A sub-minute request must not expire early');
    t.mock.timers.tick(1);
    const result = (await waiting).structuredContent.results as any[];
    assert.equal(result[0].waitExpired, true);
    assert.equal(result[0].terminal, false);
    assert.equal(result[0].submittedUserMessageId, f.sent.submittedUserMessageId);
    assert.equal(result[0].conversationUsage, undefined);
    assert.equal(result[0].evidence, undefined);
    const view = (await f.invoke('team_get', { teamId: f.team.teamId, requestRef: f.sent.requestRef })).structuredContent.request as any;
    assert.notEqual(view.activity.lastGenerationStateChange?.eventType, 'generation.backend-deferred');
    assert.equal(view.activity.latestStoredArtifactChangeAt, null);

    const controller = new AbortController();
    const cancelled = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef], waitMs: 7_260_000 }, controller.signal);
    await f.untilSubscribed(f.sent.sessionId as string);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    for (let i = 0; i < 100 && f.core.actorScheduler.actorFor(f.sent.sessionId as string).subscriberCount; i++) await flush();
    assert.equal(f.core.actorScheduler.actorFor(f.sent.sessionId as string).subscriberCount, 0);
    assert.equal(f.core.teamDirectory.getSession(f.sent.sessionId as string).terminal, false);
    assert.equal(f.fake.submitCount, 1);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('one completed result wakes a multi-request long wait immediately; actual errors also wake without replay', async () => {
  const f = await fixture();
  try {
    const roles = (await f.invoke('role_create', { teamId: f.team.teamId, requestId: 'role', roleKey: 'other' })).structuredContent.roles as any[];
    const other = (await f.invoke('send', { teamId: f.team.teamId, roleRef: roles.find(r => r.roleKey === 'other').roleRef,
      requestId: 'other-send', prompt: 'Independent existing work' })).structuredContent;
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef, other.requestRef], waitMs: 7_260_000 });
    await f.untilSubscribed(f.sent.sessionId as string);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, {
      sessionState: 'complete', providerState: 'complete', responseMessageId: 'exact-final', answerText: 'Exact result',
    });
    const result = (await waiting).structuredContent.results as any[];
    assert.equal(result[0].answerText, 'Exact result');
    assert.equal(result[0].terminal, true);
    assert.equal(result[1].terminal, false);
    assert.equal(f.core.actorScheduler.actorFor(other.sessionId as string).subscriberCount, 0);
    const errorWait = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [other.requestRef], waitMs: 7_260_000 });
    await f.untilSubscribed(other.sessionId as string);
    await f.core.actorScheduler.updateGeneration(other.sessionId as string, 1,
      { providerState: 'blocked', reason: 'provider-actionable-alert' });
    const blocked = (await errorWait).structuredContent.results as any[];
    assert.equal(blocked[0].providerState, 'blocked');
    assert.equal(blocked[0].waitExpired, false);
    await f.core.actorScheduler.updateGeneration(other.sessionId as string, 1,
      { providerState: 'unknown', reason: null, errorCode: null });
    const failureWait = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [other.requestRef], waitMs: 600_000 });
    await f.untilSubscribed(other.sessionId as string);
    await f.core.actorScheduler.updateGeneration(other.sessionId as string, 1,
      { providerState: 'error', errorCode: 'provider.execution-failed', reason: 'verified-failure' });
    const [failed] = (await failureWait).structuredContent.results as any[];
    assert.equal(failed.errorCode, 'provider.execution-failed');
    assert.equal(failed.waitExpired, false);
    assert.equal(f.fake.submitCount, 2);
  } finally { await f.close(); }
});


test('default MCP wait keeps multiple expired rounds internal and returns only the exact answer', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let returned = false;
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef], waitMs: 600_000 })
      .then(result => { returned = true; return result; });
    await f.untilSubscribed(f.sent.sessionId as string);
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(600_001);
      for (let j = 0; j < 12; j++) await flush();
      assert.equal(returned, false, 'Routine ten-minute expiry must not invoke the model');
    }
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, {
      sessionState: 'complete', providerState: 'complete', responseMessageId: 'same-request-answer', answerText: 'Recovered final',
      completedAt: new Date().toISOString() });
    const result = (await waiting).structuredContent.results as any[];
    assert.equal(result[0].responseMessageId, 'same-request-answer');
    assert.equal(result[0].waitExpired, false);
    assert.equal(f.fake.submitCount, 1);
  } finally { t.mock.timers.reset(); await f.close(); }
});

test('ten-minute wait survives the TabletAuto observation timeout then returns the exact completion immediately', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let returned = false;
    let stdout = '', stderr = '';
    const waiting = runCli(['request', 'wait', f.team.teamId as string, f.sent.requestRef as string,
      '--wait-ms', '600000', '--socket', f.config.socketPath, '--json'], {
      stdin: Readable.from([]),
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
    }).then(code => { returned = true; assert.equal(code, 0, stderr); return JSON.parse(stdout); });
    await f.untilSubscribed(f.sent.sessionId as string);
    t.mock.timers.tick(116_547);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, {
      providerState: 'unknown', observationTransport: 'unavailable',
      errorCode: 'provider.observation-unavailable', reason: 'dom-observation-timeout',
    });
    await flush();
    await flush();
    assert.equal(returned, false);
    await f.untilSubscribed(f.sent.sessionId as string);
    t.mock.timers.tick(4_000);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, {
      providerState: 'generating', observationTransport: 'dom', errorCode: null, reason: 'provider-network-activity',
    });
    await flush();
    await flush();
    assert.equal(returned, false);
    await f.untilSubscribed(f.sent.sessionId as string);
    t.mock.timers.tick(400_000);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, {
      sessionState: 'complete', providerState: 'complete', responseMessageId: 'recovered-final', answerText: 'Original completed answer',
    });
    const [result] = (await waiting).results as any[];
    assert.equal(result.responseMessageId, 'recovered-final');
    assert.equal(result.answerText, 'Original completed answer');
    assert.equal(result.waitExpired, false);
    assert.equal(result.submittedUserMessageId, f.sent.submittedUserMessageId);
    assert.equal(f.fake.submitCount, 1);
  } finally { t.mock.timers.reset(); await f.close(); }
});


test('CLI retains paced UNKNOWN ACK recovery through collection without a selection or replay', async t => {
  const f = await fixture();
  try {
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, {
      sessionState: 'complete', providerState: 'complete', responseMessageId: 'previous', answerText: 'Previous' });
    f.fake.acknowledgementMode = 'missing';
    await assert.rejects(f.core.submissionService.send({ clientId: `team:${f.team.teamId}`, requestId: 'unknown',
      sessionId: f.sent.sessionId as string, expectedGeneration: 1, prompt: 'Exact next prompt', sessionDeadlineSec: 60 }));
    const request = f.core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=? AND generation=2')
      .get(f.sent.sessionId as string) as { outbox_id: string };
    let probes = 0;
    const nextCheckAt = new Date(Date.now() + 150).toISOString();
    f.fake.recoverAcknowledgement = async input => {
      probes++;
      if (probes === 1) {
        input.onRecoveryObservation?.({ kind: 'deferred', source: 'backend', reason: 'backend-http-429',
          observedAt: new Date().toISOString(), nextCheckAt, httpStatus: 429, endpointCategory: 'conversation-detail' });
        return null;
      }
      assert.ok(Date.now() >= Date.parse(nextCheckAt), 'Respect the actual provider delay');
      assert.equal(input.selection, undefined, 'Do not choose a rendered candidate to bypass canonical proof');
      return { conversationId: input.session.conversationId!, submittedUserMessageId: 'exact-canonical-user',
        submittedUserTurnId: 'exact-canonical-user' };
    };
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async function(input: any) {
      return await f.core.submissionService.inspectSubmission(input, async snapshot => ({
        submissionCandidates: snapshot.submissionState === 'submission_unknown' ? [{ messageId: 'visible-user' }] : [] }));
    }) as any);
    f.fake.autoFinalText = 'Same request final';
    let output = '', error = '';
    const code = await runCli(['request', 'wait', f.team.teamId as string, request.outbox_id,
      '--wait-ms', '600000', '--socket', f.config.socketPath, '--json'], {
      stdin: Readable.from([]), stdout: new Writable({ write(c, _e, done) { output += c; done(); } }),
      stderr: new Writable({ write(c, _e, done) { error += c; done(); } }) });
    assert.equal(code, 0, error);
    const [result] = JSON.parse(output).results;
    assert.equal(result.submissionState, 'submitted');
    assert.equal(result.submittedUserMessageId, 'exact-canonical-user');
    assert.equal(result.answerText, 'Same request final');
    assert.equal(result.terminal, true);
    assert.equal(f.fake.submitCount, 2, 'Only the two original fixture sends occurred');
    assert.equal(probes, 2);
    const pending = { status: 'needs_decision', submissionState: 'submission_unknown', promptSubmitted: true,
      acknowledgementRecovery: { kind: 'deferred', currentIdentityMatches: true } };
    assert.equal(workflowWaitOutcome(pending), false);
    assert.equal(workflowWaitOutcome({ ...pending, acknowledgementRecovery: { kind: 'unverified', currentIdentityMatches: true } }), true);
    assert.equal(workflowWaitOutcome({ ...pending, acknowledgementRecovery: { kind: 'deferred', currentIdentityMatches: false } }), true);
    assert.equal(workflowWaitOutcome({ ...pending, status: 'recovery_required' }), true);
    assert.equal(workflowWaitOutcome({ ...pending, errorCode: 'provider.actionable-alert' }), true);
  } finally { t.mock.restoreAll(); await f.close(); }
});


test('authorized broad continuation review stays inside the wait and runs at thirty-minute intervals', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let reviews = 0;
    t.mock.method(SessionUiService.prototype, 'prepareContinuation', async () => {
      reviews++;
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Still generating or uncertain');
    });
    let returned = false;
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef], waitMs: 3600000,
      untilResult: false, continuationApproved: true }).then(value => { returned = true; return value; });
    await f.untilSubscribed(f.sent.sessionId as string);
    assert.equal(reviews, 0);
    t.mock.timers.tick(1800000);
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(reviews, 1);
    assert.equal(returned, false);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, { reason: 'provider-stream-disconnected' });
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(reviews, 1, 'Progress cannot cause rapid broad reviews');
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { sessionState: 'complete', providerState: 'complete', answerText: 'Original final', responseMessageId: 'final' });
    await waiting;
    assert.equal(f.fake.submitCount, 1);
  } finally { t.mock.timers.reset(); await f.close(); }
});


test('prepared load recovery stays inside wait and returns only the same ready-to-configure request', async t => {
  const f = await fixture();
  try {
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { sessionState: 'complete', providerState: 'complete', answerText: 'Original final', responseMessageId: 'original-final' });
    f.fake.prepareError = new ProviderSubmissionError('provider.preparation-required', 'Composer unavailable');
    let ready = false;
    t.mock.method(SessionUiService.prototype, 'inspect', async () => ({
      preparationAvailability: { available: ready, reason: ready ? 'composer-ready' : 'composer-unavailable' },
      configurationCatalog: { status: 'cached', selectionAvailable: false }, nodes: [],
    }) as any);
    const prepared = (await f.invoke('send', { teamId: f.team.teamId,
      roleRef: `${f.sent.sessionId}:1`, requestId: 'next-prepared', prompt: 'Preserved next operation' })).structuredContent;
    const session = f.core.teamDirectory.getSession(f.sent.sessionId as string);
    new ConversationLoadRecoveryRepository(f.core.database).save({ conversationId: session.conversationId!,
      sessionId: session.sessionId, pageKey: session.pageKey!, bindingEpoch: 1,
      url: `https://chatgpt.com/c/${session.conversationId}`, attempts: 82, state: 'held',
      reason: 'load-retry-button-unavailable', lastOutcome: 'clicked', lastCheckedAt: new Date().toISOString(),
      lastAttemptAt: null, notifiedAt: null });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let returned = false;
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [prepared.requestRef], waitMs: 600000,
      untilResult: false }).then(value => { returned = true; return value; });
    await f.untilSubscribed(session.sessionId);
    assert.equal(returned, false);
    t.mock.timers.tick(60000);
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(returned, false, 'Cached/unselectable catalog cannot wake the model');
    ready = true;
    t.mock.timers.tick(60000);
    const [result] = (await waiting).structuredContent.results as any[];
    assert.equal(result.status, 'needs_decision');
    assert.equal(result.requestRef, prepared.requestRef);
    assert.equal(result.promptSubmitted, false);
    assert.equal(result.evidence.preparationAvailability.available, true);
    assert.equal(f.fake.submitCount, 1, 'Preparation waiting never submits');
    for (const state of ['held', 'waiting', 'attempting']) assert.equal(workflowWaitOutcome({
      requestOk: true, submissionState: 'submitted', promptSubmitted: true, terminal: false,
      errorCode: 'provider.conversation-unavailable', conversationLoadRecovery: { state } }), false);
    assert.equal(workflowWaitOutcome({ requestOk: true, promptSubmitted: true, terminal: false,
      errorCode: 'provider.conversation-unavailable', conversationLoadRecovery: { state: 'exhausted' } }), true);
    assert.equal(workflowWaitOutcome({ ...result, terminal: true, sessionState: 'superseded' }), true);
  } finally { t.mock.timers.reset(); await f.close(); }
});
