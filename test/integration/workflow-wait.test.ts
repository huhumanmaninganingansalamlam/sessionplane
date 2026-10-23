import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { callRpc } from '../../src/cli/client.ts';
import { setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { SessionUiService } from '../../src/core/session-ui-service.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { ConversationLoadRecoveryRepository } from '../../src/storage/conversation-load-recovery-repository.ts';
import { EventRepository } from '../../src/storage/event-repository.ts';
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

test('managed collection recovers only a literal continuation lineage without rebinding a lost ACK', async t => {
  for (const { complete, continuation } of [
    { complete: false, continuation: true }, { complete: true, continuation: true },
    { complete: true, continuation: false },
  ]) {
    const f = await fixture();
    const controller = new AbortController();
    let waiting: Promise<any> | undefined;
    try {
      const sessionId = f.sent.sessionId as string;
      await f.core.actorScheduler.updateGeneration(sessionId, 1, {
        sessionState: 'complete', providerState: 'complete', answerText: 'Checkpoint', responseMessageId: 'checkpoint' });
      const next = (await f.invoke('send', { teamId: f.team.teamId, roleRef: `${sessionId}:1`,
        requestId: `continue:managed-continuation:${f.sent.requestRef}`,
        prompt: continuation ? '계속' : 'Execute the next distinct product WP' })).structuredContent;
      if (continuation) f.core.database.raw.prepare("UPDATE outbox SET payload_json=json_set(payload_json, '$.continuationOf', ?) WHERE outbox_id=?")
        .run(f.sent.requestRef, next.requestRef);
      f.core.database.raw.prepare("UPDATE generations SET answer_text=NULL,response_message_id=NULL,reason='approved-continuation-prepared' WHERE session_id=? AND generation=1")
        .run(sessionId);
      const current = f.core.teamDirectory.getSession(sessionId);
      new EventRepository(f.core.database.raw).append({ teamId: f.team.teamId as string, sessionId, generation: 2,
        eventType: 'generation.backend-unverified', createdAt: new Date().toISOString(),
        payload: { recoveryReason: 'backend-user-anchor-absent-from-mapping', recoveryIdentity: {
          conversationId: current.conversationId, pageKey: current.pageKey,
          submittedUserMessageId: current.submittedUserMessageId, submittedUserTurnId: current.submittedUserTurnId } } });
      t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
      t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
        snapshot: f.core.teamDirectory.getSession(sessionId), requested: {},
        evidence: { submissionVerification: { anchorPresent: false, laterUserFound: false,
          activity: 'none', messageTimeout: false, responseCandidate: null } },
      })) as any);
      let reads = 0, reconciliations = 0;
      t.mock.method(SessionUiService.prototype, 'readOriginalWork', (async (original: any, owner: any) => {
        reads++; assert.equal(original.generation, 1); assert.equal(owner.generation, 2);
        return { originalAnchorPresent: true, originalUserMessageId: f.sent.submittedUserMessageId,
          responseUserMessageId: 'visible-literal-continue', submittedUserMessageId: 'visible-literal-continue',
          terminal: complete, responseMessageId: complete ? 'actual-followup-final' : null,
          answerText: complete ? 'Actual collected answer' : null,
          activity: complete ? 'none' : 'weak', activityReason: complete ? null : 'unverified-stop-control' };
      }) as any);
      t.mock.method(SessionUiService.prototype, 'reconcileFollowup', (async (input: any) => {
        reconciliations++;
        assert.equal(input.requestId, 'send'); assert.equal(input.generation, 1);
        assert.equal(input.followupUserMessageId, 'visible-literal-continue');
        assert.equal(input.responseMessageId, 'actual-followup-final');
        return await f.core.submissionService.reconcileFollowup(input, async (original: any) => ({
          pageKey: original.pageKey, conversationId: original.conversationId, bindingEpoch: 1,
          observedAt: new Date().toISOString(), originalPartialResponses: [],
        }));
      }) as any);
      let returned = false;
      waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [next.requestRef],
        waitMs: 600000, continuationApproved: true }, controller.signal).then(x => { returned = true; return x; });
      for (let i = 0; i < 50; i++) await flush();
      assert.equal(reads > 0, continuation, 'A distinct product request must never inherit the previous WP final');
      if (complete && continuation) {
        const [result] = (await waiting).structuredContent.results;
        assert.equal(result.followup.originalRequestRef, f.sent.requestRef);
        assert.equal(result.followup.responseMessageId, 'actual-followup-final');
        assert.equal(result.followup.answerText, 'Actual collected answer');
        assert.equal(reconciliations, 1);
      } else {
        if (continuation) assert.equal(returned, false, 'A Stop control or backend pacing is neither a final nor proof of fresh tool progress');
        assert.equal(reconciliations, 0);
      }
      assert.equal(f.core.teamDirectory.getSession(sessionId).submittedUserMessageId, next.submittedUserMessageId);
      assert.equal(f.fake.submitCount, 2, 'Collection never sends a replacement prompt');
    } finally {
      controller.abort(); await waiting?.catch(() => undefined);
      t.mock.restoreAll(); await f.close();
    }
  }
});

test('CLI retains submitted missing-anchor pacing until the same ACK answer is recovered', async t => {
  for (const canonical of [false, true]) {
  const f = await fixture();
  try {
    const session = f.core.teamDirectory.getSession(f.sent.sessionId as string);
    new EventRepository(f.core.database.raw).append({ teamId: f.team.teamId as string,
      sessionId: session.sessionId, generation: 1, eventType: 'generation.backend-unverified',
      createdAt: new Date().toISOString(), payload: {
        recoveryReason: canonical ? 'backend-assistant-not-final' : 'backend-user-anchor-absent-from-mapping',
        ...(canonical ? { serverObservation: { anchorNodeId: session.submittedUserMessageId,
          currentNodeId: 'last-tool-result', nextUserFound: false, assistantCount: 1,
          messages: [{ messageId: 'last-tool-result', role: 'tool', status: 'finished_successfully', textLength: 0 }] } } : {}),
        recoveryIdentity: { conversationId: session.conversationId, pageKey: canonical ? session.pageKey : 'previous-owned-page',
          submittedUserMessageId: session.submittedUserMessageId, submittedUserTurnId: session.submittedUserTurnId } } });
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
      snapshot: f.core.teamDirectory.getSession(session.sessionId),
      evidence: { submissionVerification: { anchorPresent: false, laterUserFound: false,
        activity: 'unknown', messageTimeout: false, responseCandidate: null } }, requested: {},
    })) as any);
    await f.core.actorScheduler.updateGeneration(session.sessionId, 1, {
      providerState: 'unknown', observationTransport: canonical ? 'fresh' : 'deferred',
      reason: canonical ? 'dom-user-anchor-missing' : 'backend-conversation-probe-paced',
      nextCheckAt: new Date(Date.now() + 60_000).toISOString() });
    let stdout = '', stderr = '';
    const waiting = runCli(['request', 'wait', f.team.teamId as string, f.sent.requestRef as string,
      '--wait-ms', '600000', '--continuation-approved', '--socket', f.config.socketPath, '--json'], {
      stdin: Readable.from([]), stdout: new Writable({ write(c, _e, done) { stdout += c; done(); } }),
      stderr: new Writable({ write(c, _e, done) { stderr += c; done(); } }) });
    await f.untilSubscribed(session.sessionId);
    const pending = (await f.invoke('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef: f.sent.requestRef })).structuredContent.request as any;
    assert.equal(pending.status, 'recovery_required');
    assert.equal(workflowWaitOutcome(pending), false);
    assert.equal(workflowWaitOutcome({ ...pending, observationTransport: 'fresh',
      reason: 'unverified-stop-control' }), false);
    assert.equal(workflowWaitOutcome({ ...pending, errorCode: 'provider.actionable-alert' }), true);
    assert.equal(workflowWaitOutcome({ ...pending, recovery: { userActionRequired: true } }), true);
    if (canonical) {
      for (const change of [{ currentIdentityMatches: false }, { serverObservation: { nextUserFound: true } }]) {
        assert.equal(workflowWaitOutcome({ ...pending, submissionVerification: { ...pending.submissionVerification,
          serverObservation: { ...pending.submissionVerification.serverObservation, ...change } } }), true);
      }
    }
    if (!canonical) for (const backend of [
      { currentIdentityMatches: false, recoveryReason: 'backend-user-anchor-absent-from-mapping' },
      { currentIdentityMatches: true, recoveryReason: 'backend-user-anchor-not-on-current-branch' },
    ]) assert.equal(workflowWaitOutcome({ ...pending,
      reason: 'backend-user-anchor-absent-from-mapping', observationTransport: 'fresh',
      submissionVerification: { ...pending.submissionVerification, backend } }), true);
    await f.core.actorScheduler.updateGeneration(session.sessionId, 1, { sessionState: 'complete', providerState: 'complete',
      responseMessageId: 'original-ack-final', answerText: 'Original recovered answer' });
    assert.equal(await waiting, 0, stderr);
    const [result] = JSON.parse(stdout).results;
    assert.equal(result.responseMessageId, 'original-ack-final');
    assert.equal(result.submittedUserMessageId, session.submittedUserMessageId);
    assert.equal(result.terminal, true);
    assert.equal(f.fake.submitCount, 1, 'No continuation into unknown/disconnected generation');
  } finally { t.mock.restoreAll(); await f.close(); }
  }
});

test('CLI retains the original ACK through automatic load recovery without a backend anchor event', async t => {
  const f = await fixture();
  try {
    const session = f.core.teamDirectory.getSession(f.sent.sessionId as string);
    const load = { conversationId: session.conversationId!, sessionId: session.sessionId, pageKey: session.pageKey!,
      bindingEpoch: 1, url: `https://chatgpt.com/c/${session.conversationId}`, attempts: 12, state: 'held' as const,
      reason: 'load-retry-button-unavailable', lastOutcome: 'clicked' as const,
      lastCheckedAt: new Date().toISOString(), lastAttemptAt: null, notifiedAt: null };
    new ConversationLoadRecoveryRepository(f.core.database).save(load);
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
      snapshot: f.core.teamDirectory.getSession(session.sessionId),
      evidence: { submissionVerification: { anchorPresent: false, laterUserFound: false,
        activity: 'none', messageTimeout: false, responseCandidate: null } }, requested: {},
    })) as any);
    await f.core.actorScheduler.updateGeneration(session.sessionId, 1,
      { providerState: 'unknown', observationTransport: 'unavailable', reason: 'dom-user-anchor-missing' });
    let stdout = '', stderr = '', returned = false;
    const waiting = runCli(['request', 'wait', f.team.teamId as string, f.sent.requestRef as string,
      '--wait-ms', '600000', '--socket', f.config.socketPath, '--json'], {
      stdin: Readable.from([]), stdout: new Writable({ write(c, _e, done) { stdout += c; done(); } }),
      stderr: new Writable({ write(c, _e, done) { stderr += c; done(); } }) })
      .then(code => { returned = true; return code; });
    await f.untilSubscribed(session.sessionId);
    const pending = (await f.invoke('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef: f.sent.requestRef })).structuredContent.request as any;
    assert.equal(pending.submissionVerification.backend, null);
    assert.equal(pending.status, 'recovery_required');
    assert.equal(returned, false, 'Automatic load recovery must remain inside the original CLI wait');
    for (const changed of [
      { conversationLoadRecovery: { ...pending.conversationLoadRecovery, conversationId: 'different-chat' } },
      { conversationLoadRecovery: { ...pending.conversationLoadRecovery, sessionId: 'different-session' } },
      { conversationLoadRecovery: { ...pending.conversationLoadRecovery, pageKey: 'different-page' } },
      { conversationLoadRecovery: { ...pending.conversationLoadRecovery, state: 'exhausted' } },
      { userActionRequired: true }, { errorCode: 'provider.actionable-alert' },
      { recovery: { decisionRequired: true } }, { stopOutcome: { state: 'unknown' } },
    ]) assert.equal(workflowWaitOutcome({ ...pending, ...changed }), true);
    await f.core.actorScheduler.updateGeneration(session.sessionId, 1, { sessionState: 'complete', providerState: 'complete',
      responseMessageId: 'same-ack-after-load', answerText: 'Recovered original answer' });
    assert.equal(await waiting, 0, stderr);
    const [result] = JSON.parse(stdout).results;
    assert.equal(result.responseMessageId, 'same-ack-after-load');
    assert.equal(result.submittedUserMessageId, session.submittedUserMessageId);
    assert.equal(f.fake.submitCount, 1, 'Load recovery must never submit or continue');
  } finally { t.mock.restoreAll(); await f.close(); }
});

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
    const view = (await f.invoke('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef: f.sent.requestRef })).structuredContent.request as any;
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
    t.mock.method(EventRepository.prototype, 'latestServerObservation', () => {
      const current = f.core.teamDirectory.getSession(f.sent.sessionId as string);
      return { observedAt: new Date().toISOString(), recoveryIdentity: {
        conversationId: current.conversationId, pageKey: current.pageKey,
        submittedUserMessageId: current.submittedUserMessageId, submittedUserTurnId: current.submittedUserTurnId },
        serverObservation: {} };
    });
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
      snapshot: f.core.teamDirectory.getSession(f.sent.sessionId as string),
      evidence: { submissionVerification: { anchorPresent: true, laterUserFound: false,
        activity: 'strong', activityReason: 'streaming', messageTimeout: false, responseCandidate: null } }, requested: {},
    })) as any);
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
    const status = async () => (await f.invoke('team_get', {
      teamId: f.team.teamId, requestRef: f.sent.requestRef,
    })).structuredContent.request as any;
    const before = await status();
    assert.deepEqual(before.collection.waits, [{ requestRef: f.sent.requestRef, continuationApproved: true }]);
    assert.equal(before.managedContinuation.active, true);
    assert.ok(Date.parse(before.managedContinuation.nextReviewAt) > Date.now());
    t.mock.timers.tick(1800000);
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(reviews, 1);
    assert.equal(returned, false);
    const reviewed = await status();
    assert.equal(reviewed.managedContinuation.lastReviewReason, 'provider.failure-unverified');
    assert.equal(Date.parse(reviewed.managedContinuation.nextReviewAt) -
      Date.parse(reviewed.managedContinuation.lastReviewAt), 1800000);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, { reason: 'provider-stream-disconnected' });
    for (let i = 0; i < 20; i++) await flush();
    assert.equal(reviews, 1, 'Progress cannot cause rapid broad reviews');
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { sessionState: 'complete', providerState: 'complete', answerText: 'Original final', responseMessageId: 'final' });
    await waiting;
    assert.equal(f.fake.submitCount, 1);
    assert.deepEqual((await status()).collection.waits, []);
  } finally { t.mock.timers.reset(); await f.close(); }
});


test('approved broad review recovers an exact idle unanswered turn while backend probes are paced', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
      snapshot: f.core.teamDirectory.getSession(f.sent.sessionId as string),
      evidence: { submissionVerification: { anchorPresent: true, laterUserFound: false,
        activity: 'none', messageTimeout: false, responseCandidate: null,
        turnBoundary: [{ role: 'user', text: 'Wait for the existing answer' }] } }, requested: {},
    })) as any);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1, {
      providerState: 'unknown', observationTransport: 'deferred', reason: 'backend-conversation-probe-paced',
      nextCheckAt: new Date(Date.now() + 3600000).toISOString() });
    const reviews: any[] = [];
    t.mock.method(SessionUiService.prototype, 'prepareContinuation', async input => {
      reviews.push(input);
      throw new SessionPlaneDomainError('provider.preparation-required', 'Actual fresh submit control unavailable');
    });
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef],
      waitMs: 3600000, untilResult: false, continuationApproved: true });
    await f.untilSubscribed(f.sent.sessionId as string);
    assert.equal(reviews.length, 0, 'A new ACK must not immediately trigger another continue');
    t.mock.timers.tick(1800000);
    for (let i = 0; i < 30; i++) await flush();
    const result = (await waiting).structuredContent;
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].userConfirmedInterruption.submittedUserMessageId, f.sent.submittedUserMessageId);
    assert.equal(result.results[0].recovery.userActionRequired, true, 'A real inability to submit is returned');
    assert.equal(f.fake.submitCount, 1, 'A failed fresh control check never submits');
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


test('new approved wait observes a disconnected exact ACK immediately despite stale server evidence', async t => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
      snapshot: f.core.teamDirectory.getSession(f.sent.sessionId as string),
      evidence: { submissionVerification: { anchorPresent: true, laterUserFound: false,
        activity: 'unknown', activityReason: 'provider-stream-disconnected',
        messageTimeout: false, responseCandidate: null } }, requested: {},
    })) as any);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { reason: 'provider-stream-disconnected' });
    t.mock.method(EventRepository.prototype, 'latestServerObservation', () => null);
    let reviews = 0;
    t.mock.method(SessionUiService.prototype, 'prepareContinuation', async () => {
      reviews++;
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Fresh exact server evidence is required');
    });
    const outcome = (await f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef],
      waitMs: 600000, continuationApproved: true })).structuredContent;
    const result = (outcome.results as any[])[0];
    assert.equal(reviews, 1, 'Stale/absent server evidence cannot suppress the provider recovery check');
    assert.equal(result.recovery.userActionRequired, true);
    assert.equal(result.recovery.reason, 'provider.failure-unverified');
    assert.match(result.recovery.url, /chatgpt.com\/c\//);
    assert.equal(result.terminal, false);
    assert.equal(f.fake.submitCount, 1, 'A rejected continue never sends');
    assert.equal(f.core.teamDirectory.getSession(f.sent.sessionId as string).generation, 1);
  } finally { t.mock.timers.reset(); t.mock.restoreAll(); await f.close(); }
});


test('an interrupted continuation attempts existing recovery instead of assuming manual refresh is necessary', async t => {
  const f = await fixture();
  try {
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { sessionState: 'complete', providerState: 'complete', answerText: 'Retained checkpoint', responseMessageId: 'old' });
    const next = (await f.invoke('send', { teamId: f.team.teamId, roleRef: `${f.sent.sessionId}:1`,
      requestId: `continue:managed-continuation:${f.sent.requestRef}`, prompt: '계속' })).structuredContent;
    // This fixture represents the existing durable same-chat continuation.
    f.core.database.raw.prepare("UPDATE outbox SET payload_json=json_set(payload_json, '$.continuationOf', ?) WHERE outbox_id=?")
      .run(f.sent.requestRef, next.requestRef);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 31 * 60_000 });
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
      snapshot: f.core.teamDirectory.getSession(f.sent.sessionId as string),
      evidence: { submissionVerification: { anchorPresent: true, laterUserFound: false,
        activity: 'unknown', activityReason: 'provider-stream-disconnected',
        messageTimeout: false, responseCandidate: null } }, requested: {},
    })) as any);
    t.mock.method(EventRepository.prototype, 'latestServerObservation', () => null);
    let refreshes = 0, reviews = 0, focused = 0;
    t.mock.method(SessionUiService.prototype, 'refresh', async () => { refreshes++; return {} as any; });
    t.mock.method(SessionUiService.prototype, 'prepareContinuation', async () => {
      reviews++;
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Retry remains uncertain');
    });
    t.mock.method(SessionUiService.prototype, 'focus', async () => { focused++; return { pageKey: 'exact-page', url: 'https://chatgpt.com/c/exact' }; });
    const outcome = (await f.invoke('wait', { teamId: f.team.teamId, requestRefs: [f.sent.requestRef],
      waitMs: 600000, continuationApproved: true })).structuredContent;
    assert.equal(refreshes, 0);
    assert.equal(reviews, 1);
    assert.equal(focused, 0);
    assert.equal((outcome.results as any[])[0].recovery.reason, 'provider.failure-unverified');
    assert.equal((outcome.results as any[])[0].recovery.userActionRequired, true);
    assert.equal(f.fake.submitCount, 2, 'Only the two preexisting submissions exist');
  } finally { t.mock.timers.reset(); t.mock.restoreAll(); await f.close(); }
});


test('managed retry uses current recovery eligibility instead of a previous-Continue count', async t => {
  for (const previousEvidence of [{ disconnectedRecovery: true }, { userConfirmedInterruption: { evidenceRef: 'Approved managed idle review' } }]) {
  const f = await fixture();
  try {
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { sessionState: 'complete', providerState: 'complete', answerText: 'Retained checkpoint', responseMessageId: 'old' });
    const next = (await f.invoke('send', { teamId: f.team.teamId, roleRef: `${f.sent.sessionId}:1`,
      requestId: `continue:managed-continuation:${f.sent.requestRef}`, prompt: '계속' })).structuredContent;
    f.core.database.raw.prepare("UPDATE outbox SET payload_json=json_set(payload_json, '$.continuationOf', ?) WHERE outbox_id=?")
      .run(f.sent.requestRef, next.requestRef);
    f.core.receipts.execute({ clientId: `team:${f.team.teamId}`,
      requestId: `managed-continuation:${f.sent.requestRef}`, method: 'session.continuation.prepare', payload: {},
      operation: () => ({ evidence: previousEvidence }) });
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() + 31 * 60_000 });
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    const activityReason = 'provider-stream-disconnected';
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
      snapshot: f.core.teamDirectory.getSession(f.sent.sessionId as string),
      evidence: { submissionVerification: { anchorPresent: true, laterUserFound: false,
        activity: 'unknown', activityReason, messageTimeout: false,
        responseCandidate: null, turnBoundary: [{ role: 'user', text: '계속' },
          { role: 'assistant', text: '' }] } }, requested: {},
    })) as any);
    t.mock.method(EventRepository.prototype, 'latestServerObservation', () => null);
    let reviews = 0;
    t.mock.method(SessionUiService.prototype, 'prepareContinuation', async () => {
      reviews++;
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Current submit unavailable');
    });
    const refresh = t.mock.method(SessionUiService.prototype, 'refresh', async () => ({} as any));
    const focus = t.mock.method(SessionUiService.prototype, 'focus', async () => ({} as any));
    const read = async () => (await f.invoke('wait', { teamId: f.team.teamId, requestRefs: [next.requestRef],
      waitMs: 600000, continuationApproved: true })).structuredContent.results as any[];
    const [result] = await read();
    assert.equal(result.requestRef, next.requestRef);
    assert.equal(result.submittedUserMessageId, next.submittedUserMessageId);
    assert.equal(result.terminal, false);
    assert.equal(result.recovery.userActionRequired, true);
    assert.equal(result.recovery.reason, 'provider.failure-unverified');
    assert.equal(reviews, 1, 'A previous Continue does not skip the currently eligible recovery attempt');
    t.mock.timers.tick(31 * 60_000);
    assert.equal((await read())[0].recovery.reason, 'provider.failure-unverified');
    assert.equal(reviews, 2, 'The next broad review uses current controls, not a fixed retry count');
    assert.equal(refresh.mock.callCount(), 0);
    assert.equal(focus.mock.callCount(), 0);
    assert.equal(f.fake.submitCount, 2, 'Only the original and its existing Continue were submitted');
  } finally { t.mock.timers.reset(); t.mock.restoreAll(); await f.close(); }
  }
});


test('CLI and MCP keep one exact wait through connection loss and the successor socket gap', async t => {
  for (const client of ['cli', 'mcp', 'cursor'] as const) await t.test(client, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-wait-reconnect-'));
    const socketPath = path.join(root, 'rpc.sock'), observed: any[] = [];
    const params = client === 'cursor'
      ? { clientId: 'owner', teamId: 'team', afterEventSequence: 42, waitMs: 60000 }
      : { teamId: 'team', requestRefs: ['original'], waitMs: 60000, continuationApproved: true, untilResult: false };
    const final = { requestOk: true, results: [{ requestRef: 'original', submittedUserMessageId: 'original-ack',
      terminal: true, answerText: 'Recovered original result' }], afterEventSequence: 43 };
    let reconnecting: Promise<void> | undefined;
    const server = net.createServer(socket => {
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        const request = JSON.parse(input.trim()); observed.push(request);
        // One caller sees maintenance; another races commit without that response.
        if (client === 'mcp' && observed.length === 1) {
          socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'draining',
            data: { errorCode: 'core.maintenance', details: { operationStarted: false } } } }) + '\n');
        } else if (observed.length === (client === 'mcp' ? 2 : 1)) {
          socket.destroy();
          reconnecting = new Promise<void>(resolve => server.close(() => {
            setTimeout(() => server.listen(socketPath, resolve), 500);
          }));
        } else socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: final }) + '\n');
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      let result: unknown;
      if (client === 'mcp') {
        const response = await invokeMcpTool({ name: 'sessionplane_wait', arguments: { ...params, untilResult: true },
          socketPath, timeoutMs: 5000, maxLineBytes: 4096 });
        assert.equal(response.isError, false, JSON.stringify(response.structuredContent));
        result = response.structuredContent;
      } else if (client === 'cli') {
        let stdout = '', stderr = '';
        const code = await runCli(['request', 'wait', 'team', 'original', '--wait-ms', '60000',
          '--continuation-approved', '--socket', socketPath, '--json'], { stdin: Readable.from([]),
          stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
          stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }) });
        assert.equal(code, 0, stderr); result = JSON.parse(stdout);
      } else result = await callRpc({ socketPath, method: 'team.wait', params, timeoutMs: 5000 });
      assert.deepEqual((result as any).results, final.results);
      assert.ok(observed.length >= 2);
      for (const request of observed) {
        assert.equal(request.method, client === 'cursor' ? 'team.wait' : 'workflow.wait');
        assert.deepEqual(request.params, params, 'Same request, ACK chain, approval and cursor; no send or control replay');
      }
    } finally {
      await reconnecting;
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('successor collection retains explicit continuation approval without inventing it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-approved-collection-'));
  const socketPath = path.join(root, 'rpc.sock');
  const observed: any[] = [];
  const server = net.createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.trim());
      observed.push(request);
      const result = request.method === 'workflow.wait'
        ? { results: [{ terminal: true, answerText: 'Retained successor answer' }] }
        : { teamId: 'team', requestRef: 'successor', promptSubmitted: true, terminal: false };
      socket.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  try {
    for (const approved of [true, undefined]) {
      observed.length = 0;
      await callRpc({ socketPath, method: 'workflow.decide', collectContinuation: true,
        params: { decision: 'continue', ...(approved ? { continuationApproved: true } : {}) } });
      assert.equal(observed[1].method, 'workflow.wait');
      assert.equal(observed[1].params.continuationApproved, approved);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});


test('direct successor collection paces a carried disconnect from the submitted ACK, including reconnect', async t => {
  const f = await fixture();
  try {
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 1,
      { sessionState: 'complete', providerState: 'complete', answerText: 'Checkpoint', responseMessageId: 'old' });
    const next = (await f.invoke('send', { teamId: f.team.teamId, roleRef: `${f.sent.sessionId}:1`,
      requestId: `continue:managed-continuation:${f.sent.requestRef}`, prompt: '계속' })).structuredContent;
    // Existing continuation was prepared long before its actual ACK.
    const ackAt = Date.now();
    f.core.database.raw.prepare("UPDATE outbox SET payload_json=json_set(payload_json, '$.continuationOf', ?), created_at=?, updated_at=? WHERE outbox_id=?")
      .run(f.sent.requestRef, new Date(ackAt - 3600000).toISOString(), new Date(ackAt).toISOString(), next.requestRef);
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: ackAt + 13848 });
    t.mock.method(f.core.recoveryService, 'ensurePage', async () => {});
    t.mock.method(SessionUiService.prototype, 'inspectSubmission', (async () => ({
      snapshot: f.core.teamDirectory.getSession(f.sent.sessionId as string),
      evidence: { submissionVerification: { anchorPresent: true, laterUserFound: false,
        activity: 'unknown', activityReason: 'provider-stream-disconnected',
        messageTimeout: false, responseCandidate: null } }, requested: {},
    })) as any);
    t.mock.method(EventRepository.prototype, 'latestServerObservation', () => null);
    let reviews = 0;
    t.mock.method(SessionUiService.prototype, 'prepareContinuation', async () => {
      reviews++;
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Current submit unavailable');
    });
    const cancelled = new AbortController();
    const waiting = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [next.requestRef],
      waitMs: 3600000, untilResult: false, continuationApproved: true }, cancelled.signal).catch(() => undefined);
    await f.untilSubscribed(f.sent.sessionId as string);
    assert.equal(reviews, 0, 'A new wait on the actual successor cannot immediately send again');
    cancelled.abort(); await waiting;
    // The same successor can be reattached without resetting or bypassing cadence.
    const resumed = f.invoke('wait', { teamId: f.team.teamId, requestRefs: [next.requestRef],
      waitMs: 3600000, untilResult: false, continuationApproved: true });
    await f.untilSubscribed(f.sent.sessionId as string);
    t.mock.timers.tick(30 * 60000 - 13848 - 1);
    for (let i = 0; i < 30; i++) await flush();
    assert.equal(reviews, 0, 'No follow-up before thirty minutes from actual ACK');
    t.mock.timers.tick(2);
    await f.core.actorScheduler.updateGeneration(f.sent.sessionId as string, 2, { reason: 'cadence-review-wakeup' });
    for (let i = 0; i < 30; i++) await flush();
    assert.equal(reviews, 1, 'The due continuation still executes at the broad boundary');
    const row = ((await resumed).structuredContent.results as any[])[0];
    assert.equal(row.recovery.reason, 'provider.failure-unverified');
    assert.equal(f.fake.submitCount, 2);
  } finally { t.mock.timers.reset(); t.mock.restoreAll(); await f.close(); }
});
