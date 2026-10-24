import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Readable, Writable } from 'node:stream';
import { runCli } from '../../src/cli/main.ts';
import type { Page } from 'playwright-core';
import { resolveConfig } from '../../src/config.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { EventRepository } from '../../src/storage/event-repository.ts';
import { workflowSchemas } from '../../src/rpc/methods/workflow.ts';
import { SessionUiService } from '../../src/core/session-ui-service.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { ThinkingFailureRecovery } from '../../src/core/thinking-failure-recovery.ts';
import { ChatGptConfigurationMenu } from '../../src/providers/chatgpt/configuration-catalog.ts';
import type { BrowserSnapshot } from '../../src/browser/ref-snapshot.ts';
import type { PreparationChoices, ProviderSubmissionRequest, ProviderObservationRequest } from '../../src/providers/provider-adapter.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

const failure = '<div class="group/activity-header"><button aria-labelledby="failed"></button><span id="failed">Thinking failed</span></div>';
const configuration = '<div role="menu" id="model-menu"><div role="menuitem" id="configuration" aria-label="5.5 Pro">5.5 Pro Extra High</div></div>';

class FailedChat extends FakeProviderAdapter {
  page!: Page;
  pageKey!: string;
  core!: CoreService;
  failureCount = 2;
  missingTimeoutAnchor = false;
  idleToolTurn = false;
  surface: ((users: string) => string) | null = null;
  afterPrepare: ((request: ProviderSubmissionRequest) => void) | null = null;
  readonly submittedAt: number[] = [];
  override async openSubmission(request: ProviderSubmissionRequest) {
    const operation = await super.openSubmission(request);
    const conversationId = request.session.conversationId ?? `conversation-${request.session.sessionId}`;
    this.core.pageRegistry.reservePage(this.pageKey, { sessionId: request.session.sessionId,
      generation: request.generation, conversationId: request.session.conversationId });
    return { ...operation, pageKey: this.pageKey, prepareForObservation: async () => {},
      bindAcknowledgement: acknowledgement => { operation.bindAcknowledgement(acknowledgement);
        this.core.pageRegistry.bindPage(this.pageKey, { sessionId: request.session.sessionId,
          generation: request.generation, conversationId: acknowledgement.conversationId }); },
      prepare: async (choices?: PreparationChoices) => {
        if (!choices?.composer) throw new ProviderSubmissionError('provider.preparation-required', 'Select composer');
        await this.page.locator('textarea').fill(request.prompt);
        if (!choices.model || !choices.submit) throw new ProviderSubmissionError('provider.preparation-required', 'Select model and submit');
        await this.afterPrepare?.(request);
      },
      submitOnce: async () => {
        await operation.submitOnce(); this.submittedAt.push(Date.now());
        if (this.page.url() !== `https://chatgpt.com/c/${conversationId}`) await this.page.goto(`https://chatgpt.com/c/${conversationId}`);
        const users = Array.from({ length: request.generation }, (_, i) =>
          `<div data-message-author-role="user" data-message-id="user-message-${i + 1}">${i === 0 ? 'Original' : '계속'}</div>`).join('');
        const surface = this.surface?.(users) ?? users + (request.generation <= this.failureCount ? failure :
          '<div data-message-author-role="assistant" data-message-id="final" data-end-turn="true">Normal final</div>');
        await this.page.setContent(`<main>${configuration}${surface}<textarea></textarea><button data-testid="send-button">Send</button></main>`);
      } };
  }
  override async openObservation(request: ProviderObservationRequest) {
    const source = await super.openObservation(request);
    const observe = source.observe.bind(source);
    source.observe = async () => ({ ...await observe(), activity: 'none' as const,
      ...(this.idleToolTurn && request.generation === 1 ? {
        observationTransport: 'fresh' as const, errorCode: undefined, reason: null, candidate: null,
      } : request.generation <= this.failureCount && this.missingTimeoutAnchor ? {
        observationTransport: 'deferred' as const, errorCode: undefined, reason: 'dom-user-anchor-missing', candidate: null,
      } : request.generation <= this.failureCount ? { observationTransport: 'unavailable' as const, errorCode: 'provider.actionable-alert',
        reason: 'provider-actionable-alert', candidate: null } : { errorCode: undefined, reason: null,
        candidate: { responseMessageId: 'normal-final', answerText: 'Normal final', terminalMarker: true, streamingMarker: false } }) });
    return source;
  }
}

async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-opt-in-failure-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state', backendRecoveryAfterMs: 60_000,
    observationQuietSweepMs: 20, observationActiveSweepMs: 20, observationQuietWindowMs: 10 });
  const fake = new FailedChat();
  const core = await startCore({ config, browserHeadless: true, providerAdapters: [fake], logger: { debug() {}, info() {}, warn() {}, error() {} } });
  fake.core = core;
  const team = core.teamDirectory.createTeam({ clientId: 'fixture', primaryRoleKey: 'main' });
  const session = core.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'main', provider: 'chatgpt' });
  const { page, binding } = await core.browserOwner!.createPage(); fake.page = page; fake.pageKey = binding.pageKey;
  await page.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main></main>' }));
  await page.goto('https://chatgpt.com/');
  await page.setContent(`<main>${configuration}<textarea></textarea><button data-testid="send-button">Send</button></main>`);
  const rpc = <T>(method: string, arguments_: object) => callRpc<T>({ socketPath: config.socketPath,
    method: 'workflow.' + method, params: arguments_, timeoutMs: 15_000 });
  async function submit(optIn = true) {
    try {
      await core.submissionService.send({ clientId: `team:${team.teamId}`, requestId: 'original', sessionId: session.sessionId,
        expectedGeneration: 0, prompt: 'Original operation snapshot', model: '5.5 Pro', effort: 'Extra High',
        sessionDeadlineSec: 60, ...(optIn ? { thinkingFailureRecovery: true } : {}) });
    } catch (error) { assert.match(String(error), /preparation|decision/i); }
    const requestRef = (core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=?').get(session.sessionId) as { outbox_id: string }).outbox_id;
    for (const purpose of ['model', 'composer', 'submit']) {
      const observed = await rpc<{ request: { evidence: BrowserSnapshot } }>('team_get', { view: 'evidence', teamId: team.teamId, requestRef });
      const evidence = observed.request.evidence;
      const node = evidence.nodes.find(n => purpose === 'model' ? n.id === 'configuration' :
        purpose === 'composer' ? n.role === 'textbox' : n.submitControl === true)!;
      assert.ok(node, purpose);
      try {
        await rpc('decide', { teamId: team.teamId, requestRef, requestId: 'initial-' + purpose,
          decision: 'choose', purpose, snapshotId: evidence.snapshotId, ref: node.ref });
      } catch (error) {
        assert.equal(purpose, 'submit'); assert.equal(fake.acknowledgementMode, 'missing');
        assert.ok(error instanceof RpcClientError);
        assert.equal((error.data as { errorCode: string }).errorCode, 'session.submission-unknown');
      }
    }
    return requestRef;
  }
  return { root, config, fake, core, team, session, rpc, submit,
    close: async () => { await core.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function until(predicate: () => boolean, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= end) throw new Error('Fixture state timeout'); await delay(20); }
}

test('opt-in continues once per proven failure, backs off, preserves 5.5 Pro/deadline/receipts and stops on normal final', async () => {
  const f = await fixture();
  try {
    const rootRef = await f.submit();
    const deadline = f.core.database.raw.prepare('SELECT deadline_at FROM sessions WHERE session_id=?').get(f.session.sessionId)!.deadline_at;
    await until(() => f.core.teamDirectory.getSession(f.session.sessionId).generation === 3 &&
      f.core.teamDirectory.getSession(f.session.sessionId).sessionState === 'complete');
    assert.equal(f.fake.submitCount, 3);
    assert.deepEqual(f.fake.submissionRequests.filter((r, i, all) => all.findIndex(x => x.generation === r.generation) === i).map(r => r.prompt),
      ['Original operation snapshot', '계속', '계속']);
    assert.ok(f.fake.submissionRequests.every(r => r.model === '5.5 Pro' && r.effort === 'Extra High'));
    assert.ok(f.fake.submittedAt[1]! - f.fake.submittedAt[0]! >= 1_000);
    assert.ok(f.fake.submittedAt[2]! - f.fake.submittedAt[1]! >= 2_000);
    assert.equal(f.core.database.raw.prepare('SELECT deadline_at FROM sessions WHERE session_id=?').get(f.session.sessionId)!.deadline_at, deadline);
    const generations = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(f.session.sessionId);
    assert.equal(generations[0]!.error_code, 'provider.execution-failed');
    assert.equal(generations[0]!.submitted_user_message_id, 'user-message-1');
    assert.equal(generations[0]!.prompt_submitted, 1); assert.equal(generations[0]!.answer_text, null);
    assert.equal(generations[1]!.error_code, 'provider.execution-failed');
    assert.equal(generations[2]!.answer_text, 'Normal final');
    assert.equal(f.core.database.raw.prepare("SELECT count(*) AS n FROM events WHERE event_type='generation.failure-reconciled'").get()!.n, 2);
    const get = await f.rpc<{ request: { thinkingFailureRecovery: { successorRequestRef: string; enabled: boolean; state: string; sender: string } } }>('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef: rootRef });
    assert.ok(get.request.thinkingFailureRecovery.successorRequestRef);
    assert.equal(get.request.thinkingFailureRecovery.enabled, false);
    assert.equal(get.request.thinkingFailureRecovery.state, 'complete');
    assert.equal(get.request.thinkingFailureRecovery.sender, 'coordinator');
    f.core.thinkingFailureRecovery.restore(); await delay(200);
    assert.equal(f.fake.submitCount, 3, 'No late continuation or repeated original submit');
  } finally { await f.close(); }
});

test('default off and negative current surfaces never auto-submit', async t => {
  for (const [name, surface, optIn] of [
    ['default off', (u: string) => u + failure, false],
    ['generic thinking=false', (u: string) => u, true],
    ['permission/auth', (u: string) => u + failure + '<div role="alert">Sign in to continue</div>', true],
    ['safety/refusal', (u: string) => u + failure + '<div role="alert">Request blocked</div>', true],
    ['active Stop', (u: string) => u + failure + '<button aria-label="Stop generating">Stop</button>', true],
    ['later user', (u: string) => u + failure + '<div data-message-author-role="user" data-message-id="human">Continue</div>', true],
    ['final candidate', (u: string) => u + failure + '<div data-message-author-role="assistant" data-message-id="final" data-end-turn="true">Normal final</div>', true],
  ] as const) await t.test(name, async () => {
    const f = await fixture();
    try { f.fake.surface = surface; await f.submit(optIn); await delay(1_300); assert.equal(f.fake.submitCount, 1); }
    finally { await f.close(); }
  });
});

test('fresh backoff reinspection preserves human follow-up/draft/model changes and expired budgets', async t => {
  for (const kind of ['user', 'draft', 'literal-draft', 'model', 'closed-menu', 'expired'] as const) await t.test(kind, async () => {
    const f = await fixture();
    try {
      await f.submit();
      await until(() => f.core.teamDirectory.getSession(f.session.sessionId).reason === 'thinking-failed-reconciled');
      if (kind === 'user') await f.fake.page.locator('main').evaluate(node => {
        const user = document.createElement('div'); user.dataset.messageAuthorRole = 'user';
        user.dataset.messageId = 'human'; user.textContent = 'Already continued'; node.append(user);
      });
      if (kind === 'draft') await f.fake.page.locator('textarea').fill('Human reserved draft');
      if (kind === 'literal-draft') await f.fake.page.locator('textarea').fill('계속');
      if (kind === 'model') await f.fake.page.locator('#configuration').evaluate(node => { node.textContent = '6 Pro Medium'; });
      if (kind === 'closed-menu') await f.fake.page.locator('#model-menu').evaluate(node => node.remove());
      if (kind === 'expired') t.mock.method(f.core.thinkingFailureRecovery, 'now', () => Date.now() + 120_000);
      const failed = f.core.teamDirectory.getSession(f.session.sessionId);
      await Promise.all([f.core.thinkingFailureRecovery.observe(failed), f.core.thinkingFailureRecovery.observe(failed)]);
      await delay(1_300); assert.equal(f.fake.submitCount, 1); assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).generation, 1);
      assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).submittedUserMessageId, 'user-message-1');
      const paused = await f.rpc<{ request: { thinkingFailureRecovery: { enabled: boolean; state: string } } }>('team_get', { view: 'evidence',
        teamId: f.team.teamId, requestRef: (f.core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=?').get(f.session.sessionId) as { outbox_id: string }).outbox_id });
      assert.equal(paused.request.thinkingFailureRecovery.enabled, false);
      assert.equal(paused.request.thinkingFailureRecovery.state, 'paused');
      f.core.thinkingFailureRecovery.restore(); await delay(50);
      assert.equal(f.fake.submitCount, 1, 'A paused chain never reattempts automatically');
    } finally { await f.close(); }
  });
});

test('restoring interrupted backoff uses durable failed identity once and never replays an unknown submission', async t => {
  const f = await fixture();
  let restored: ThinkingFailureRecovery | undefined;
  try {
    f.fake.failureCount = 1;
    await f.submit();
    await until(() => f.core.teamDirectory.getSession(f.session.sessionId).reason === 'thinking-failed-reconciled');
    await f.core.thinkingFailureRecovery.close();
    restored = new ThinkingFailureRecovery(f.core.thinkingFailureRecovery.services);
    // Rewire the native pre-submit guard to the restored owner, as core startup does.
    t.mock.method(f.core.thinkingFailureRecovery, 'validateContinuation', restored.validateContinuation.bind(restored));
    restored.restore(); restored.restore();
    await until(() => f.core.teamDirectory.getSession(f.session.sessionId).sessionState === 'complete');
    assert.equal(f.fake.submitCount, 2);
    restored.restore(); await delay(100); assert.equal(f.fake.submitCount, 2);
  } finally { await restored?.close(); await f.close(); }

  const unknown = await fixture();
  try {
    unknown.fake.acknowledgementMode = 'missing';
    await unknown.submit();
    const snapshot = unknown.core.teamDirectory.getSession(unknown.session.sessionId);
    assert.equal(snapshot.submissionState, 'submission_unknown');
    await unknown.core.thinkingFailureRecovery.observe(snapshot);
    unknown.core.thinkingFailureRecovery.restore(); await delay(200);
    assert.equal(unknown.fake.submitCount, 1);
    assert.equal(unknown.core.teamDirectory.getSession(unknown.session.sessionId).generation, 1);
  } finally { await unknown.close(); }
});

test('public opt-in is explicit true only; existing sends remain off', () => {
  const base = { teamId: '11111111-1111-4111-8111-111111111111', roleRef: '22222222-2222-4222-8222-222222222222:1', requestId: 'analysis', prompt: 'Hello' };
  assert.equal(workflowSchemas.send.parse(base).thinkingFailureRecovery, undefined);
  assert.equal(workflowSchemas.send.parse({ ...base, thinkingFailureRecovery: true }).thinkingFailureRecovery, true);
  assert.throws(() => workflowSchemas.send.parse({ ...base, thinkingFailureRecovery: false }));
  assert.throws(() => workflowSchemas.send.parse({ ...base, failureContinuation: {} }));
});

test('closing the recovery owner during child preparation preserves its saved draft without submitting', async () => {
  const f = await fixture();
  try {
    f.fake.afterPrepare = request => {
      if (request.generation === 2) void f.core.thinkingFailureRecovery.close();
    };
    const rootRef = await f.submit();
    await until(() => f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE request_id=?").get(
      `thinking-failure-paused:${rootRef}`)!.n === 1);
    const child = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(child.generation, 2); assert.equal(child.promptSubmitted, false);
    assert.equal(child.submissionState, 'prepared'); assert.equal(f.fake.submitCount, 1);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), '계속');
    f.core.thinkingFailureRecovery.restore(); await delay(100); assert.equal(f.fake.submitCount, 1);
  } finally { await f.close(); }
});

for (const trailingEmpty of [false, true]) test(`approved interrupted tool continuation${trailingEmpty ? ' after empty finished assistant through managed wait' : ''} preserves original ACK and uses one ordinary successor`, async t => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const input = { teamId: f.team.teamId, requestRef, requestId: 'approved-continue',
      decision: 'continue', continuationApproved: true };
    if (trailingEmpty) {
      input.requestId = `managed-continuation:${requestRef}`;
      f.fake.idleToolTurn = true;
    }
    const identity = { conversationId: original.conversationId, pageKey: original.pageKey,
      submittedUserMessageId: original.submittedUserMessageId, submittedUserTurnId: original.submittedUserTurnId };
    const evidence = { anchorNodeId: original.submittedUserMessageId, currentNodeId: 'tool-done',
      nextUserFound: false, assistantCount: 1, messages: [{ messageId: 'tool-done', role: 'tool' as const,
        channel: 'commentary', status: 'finished_successfully', endTurn: true, hidden: false, textLength: 0 }] };
    const record = async (patch = {}, scope = identity) => f.core.actorScheduler.updateGeneration(original.sessionId, 1,
      {}, 'generation.backend-pending', 'backend-assistant-not-final', scope, { ...evidence, ...patch });
    await assert.rejects(f.rpc('decide', input), /server evidence|idle|draft|active/);
    for (const patch of [{ nextUserFound: true }, { messages: [{ ...evidence.messages[0]!, status: 'in_progress' }] },
      // Never confuse an actual final or live/meaningful assistant with the
      // completed empty placeholder after a successful tool return.
      { messages: [{ ...evidence.messages[0]!, role: 'assistant', textLength: 42 }, evidence.messages[0]!] },
      { currentNodeId: 'empty-assistant', messages: [evidence.messages[0]!, { ...evidence.messages[0]!,
        messageId: 'empty-assistant', role: 'assistant', endTurn: false, status: 'in_progress' }] },
      { currentNodeId: 'nonempty', messages: [evidence.messages[0]!, { ...evidence.messages[0]!,
        messageId: 'nonempty', role: 'assistant', endTurn: false, textLength: 3 }] }]) {
      await record(patch); await assert.rejects(f.rpc('decide', input), /server evidence|idle|draft|active/);
    }
    await record({}, { ...identity, conversationId: 'different' });
    await assert.rejects(f.rpc('decide', input), /server evidence|idle|draft|active/);
    if (trailingEmpty) Object.assign(evidence, { currentNodeId: 'empty-assistant',
      messages: [...evidence.messages, { ...evidence.messages[0]!, messageId: 'empty-assistant',
        role: 'assistant', endTurn: false, textLength: 0 }] });
    await record();
    const body = '<main>' + configuration + '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>';
    for (const unsafe of ['<textarea>Separate draft</textarea>',
      '<textarea></textarea><button data-testid="stop-button">Stop</button>',
      '<div data-message-author-role="user" data-message-id="already-continued">계속</div><textarea></textarea>',
      '<div data-message-author-role="assistant" data-message-id="final">Final</div><textarea></textarea>']) {
      await f.fake.page.setContent(body + unsafe + '</main>');
      await assert.rejects(f.rpc('decide', input), /draft|active|idle|cleanup/);
      assert.equal(f.core.teamDirectory.getSession(original.sessionId).terminal, false);
    }
    const readServer = EventRepository.prototype.latestServerObservation;
    t.mock.method(EventRepository.prototype, 'latestServerObservation', function (...args) {
      const result = readServer.apply(this, args);
      return result ? { ...result, observedAt: new Date(Date.now() - 20 * 60_000).toISOString() } : result;
    });
    await f.fake.page.setContent(body + '<textarea></textarea></main>');
    await assert.rejects(f.rpc('decide', input), /Fresh exact server evidence/);
    await f.fake.page.setContent(body + '<div data-message-author-role="assistant" data-message-id="partial">Preserved partial</div><div role="status">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div><textarea>계속</textarea><button data-testid="send-button">Send</button></main>');
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="continued-answer">Continued answer</div>';
    let prepared;
    if (trailingEmpty) {
      f.core.database.raw.prepare('UPDATE outbox SET created_at=? WHERE outbox_id=?')
        .run(new Date(Date.now() - 31 * 60_000).toISOString(), requestRef);
      const waiting = f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef],
        waitMs: 60000, continuationApproved: true });
      const waited = await waiting;
      prepared = waited.results[0];
    } else prepared = await f.rpc<any>('decide', input);
    assert.equal(prepared.generation, 2, JSON.stringify(prepared)); assert.equal(prepared.promptSubmitted, true);
    assert.equal(prepared.continuationOf, requestRef); assert.equal(f.fake.submitCount, 2);
    const stored = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(original.sessionId)!;
    assert.equal(stored.submitted_user_message_id, original.submittedUserMessageId);
    assert.equal(stored.answer_text, null); assert.equal(stored.response_message_id, null);
    assert.equal(stored.reason, 'approved-continuation-prepared');
    await f.rpc('decide', input); assert.equal(f.fake.submitCount, 2);
    const successor = f.core.database.raw.prepare('SELECT payload_json FROM outbox WHERE outbox_id=?').get(prepared.requestRef)!;
    const payload = JSON.parse(String(successor.payload_json));
    assert.equal(payload.prompt, '계속'); assert.equal(payload.continuationOf, requestRef);
  } finally { await f.close(); }
});

test('approved managed wait resumes an exact disconnected tool turn despite stale Stop without server results or human confirmation', async t => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    f.fake.idleToolTurn = true;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    f.core.database.raw.prepare('UPDATE outbox SET created_at=? WHERE outbox_id=?')
      .run(new Date(Date.now() - 31 * 60_000).toISOString(), requestRef);
    await f.fake.page.setContent('<main>' + configuration +
      '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>' +
      '<div role="status">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div>' +
      '<textarea></textarea><button data-testid="stop-button">Stop</button></main>');
    const verify = SessionUiService.prototype.verifyContinuation;
    let checked = false;
    t.mock.method(SessionUiService.prototype, 'verifyContinuation', async function (...args) {
      try { return await verify.apply(this, args); } finally { checked = true; }
    });
    const readServer = EventRepository.prototype.latestServerObservation;
    t.mock.method(EventRepository.prototype, 'latestServerObservation', function (...args) {
      const result = readServer.apply(this, args);
      return result ? { ...result, observedAt: new Date(Date.now() - 20 * 60_000).toISOString() } : result;
    });
    f.fake.afterPrepare = async request => {
      if (request.generation === 2) assert.equal(await f.fake.page.locator('[data-testid="stop-button"]').count(), 1);
    };
    f.fake.failureCount = 1;
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="continued-final" data-end-turn="true">Recovered tool work</div>';
    const waiting = f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef],
      waitMs: 60000, continuationApproved: true });
    await until(() => checked);
    const result = await waiting;
    assert.equal(result.results[0].recovery?.userActionRequired, undefined);
    assert.equal(result.results[0].generation, 2);
    assert.equal(result.results[0].terminal, true);
    assert.ok(result.results[0].submittedUserMessageId);
    assert.equal(f.fake.submitCount, 2);
    assert.equal(f.core.teamDirectory.getSession(original.sessionId).generation, 2);
    const authorizations = f.core.database.raw.prepare("SELECT count(*) AS n FROM request_receipts WHERE request_id LIKE 'continuation-authorization:%'").get()!;
    assert.equal(authorizations.n, 0, 'Automatic approval must not be recorded as human confirmation');
  } finally { await f.close(); }
});

test('completed original permission inspection verifies its ACK and never inherits a held successor control', async () => {
  const f = await fixture();
  try {
    f.fake.idleToolTurn = true;
    f.fake.surface = users => users;
    const requestRef = await f.submit(false);
    f.core.observationService.stop(f.session.sessionId, 1);
    await f.fake.page.setContent(`<main>${configuration}
      <div data-message-author-role="user" data-message-id="user-message-1" data-turn-id="user-turn-1">Original</div>
      <div data-message-author-role="assistant" data-message-id="original-final">Retained final</div>
      <section><div role="alert">hostspan-desktop Process Start Command: original review</div>
      <button onclick="window.grants=(window.grants||0)+1">Always allow</button></section>
      <textarea>Preserved original draft</textarea></main>`);
    await f.core.actorScheduler.updateGeneration(f.session.sessionId, 1, { sessionState: 'complete', providerState: 'complete',
      completedAt: new Date().toISOString(), responseMessageId: 'original-final', answerText: 'Retained final', reason: 'dom-quiet-stable-final' });
    const permission = (requestId: string, extra: object = {}) => f.rpc<any>('decide', { teamId: f.team.teamId, requestRef,
      requestId, decision: 'hostspan_permission', action: 'inspect', appName: 'hostspan-desktop',
      toolName: 'Process Start', allowMode: 'always', ...extra });
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const history = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(f.session.sessionId);
    const inspected = await permission('completed-inspect');
    assert.equal(inspected.permission.outcome, 'inspected');
    assert.equal(inspected.permission.requestAcknowledgementVerified, true);
    await assert.rejects(permission('completed-grant', { action: 'allow', evidenceHash: inspected.permission.evidenceHash }), /completed turn permits inspection only/i);
    assert.deepEqual(f.core.teamDirectory.getSession(f.session.sessionId), original);
    await assert.rejects(f.core.submissionService.send({ clientId: `team:${f.team.teamId}`, requestId: 'new-observation',
      sessionId: f.session.sessionId, expectedGeneration: 1, prompt: 'Observe a new screen, no input', sessionDeadlineSec: 600 }), { errorCode: 'provider.preparation-required' });
    const pending = f.core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=? AND generation=2').get(f.session.sessionId)!;
    await f.fake.page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend',
      '<div data-message-author-role="user" data-message-id="successor-user">Observe a new screen, no input</div>'));
    await f.rpc('decide', { teamId: f.team.teamId, requestRef: pending.outbox_id,
      requestId: 'real-human-consent', decision: 'human_review', action: 'pause' });
    const held = f.core.teamDirectory.getSession(f.session.sessionId);
    const inspectedOriginal = await permission('historical-inspect');
    assert.equal(inspectedOriginal.generation, 2);
    assert.equal(inspectedOriginal.permissionGeneration, 1);
    assert.equal(inspectedOriginal.permission.outcome, 'not-current');
    assert.equal(inspectedOriginal.permission.requestAcknowledgementVerified, true);
    assert.equal(inspectedOriginal.permission.originalUserMessageId, 'user-message-1');
    assert.equal(inspectedOriginal.permission.currentUserMessageId, 'successor-user');
    assert.equal(inspectedOriginal.permission.permissionControlAvailable, false);
    const retrieved = (await f.rpc<any>('team_get', { teamId: f.team.teamId, requestRef, view: 'result' })).request;
    assert.equal(retrieved.generation, 1);
    assert.equal(retrieved.requestRef, requestRef);
    assert.equal(retrieved.responseMessageId, 'original-final');
    assert.equal(retrieved.answerText, 'Retained final');
    assert.equal(retrieved.observationHeld, true);
    await assert.rejects(permission('historical-grant', { action: 'allow', evidenceHash: inspected.permission.evidenceHash }), /permission|review/i);
    await f.fake.page.locator('[data-message-id="user-message-1"]').evaluate(node => node.remove());
    await assert.rejects(permission('missing-original'), /original ACK is not uniquely mounted/);
    assert.equal(await f.fake.page.evaluate(() => (window as any).grants ?? 0), 0);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserved original draft');
    assert.deepEqual(f.core.teamDirectory.getSession(f.session.sessionId), held);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(f.session.sessionId), history);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.fake.stopCount, 0);
  } finally { await f.close(); }
});

test('original HostSpan grant remains controllable after an approved continuation is prepared but not sent', async t => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    f.fake.idleToolTurn = true;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const question = '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>';
    await f.fake.page.setContent(`<main>${configuration}${question}
      <div role="status">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div><textarea></textarea></main>`);
    t.mock.method(SessionUiService.prototype, 'prepareFailureContinuation', async () => {
      // The original tool asks permission after continuation preparation has
      // moved page ownership, but before the new user message is dispatched.
      await f.fake.page.setContent(`<main>${configuration}${question}
        <section id="permission"><div role="alert">hostspan-desktop Process Start Command: original review</div>
        <button onclick="throw Error('Do not choose once')">Allow once</button>
        <button onclick="window.grants=(window.grants||0)+1;document.querySelector('#permission').remove()">Always allow</button></section>
        <textarea>Preserved user draft</textarea><button data-testid="stop-button">Stop</button></main>`);
      throw new SessionPlaneDomainError('provider.preparation-required', 'Original tool permission requires resolution');
    });
    await assert.rejects(f.rpc('decide', { teamId: f.team.teamId, requestRef,
      requestId: 'approved-continue', decision: 'continue', continuationApproved: true }), /permission/);
    const pending = f.core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? AND generation=2').get(f.session.sessionId)!;
    assert.equal(pending.submission_state, 'prepared');
    const current = f.core.teamDirectory.getSession(f.session.sessionId);
    const history = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(f.session.sessionId)!;
    const permission = (ref: string, requestId: string, extra: object = {}) => f.rpc<any>('decide', {
      teamId: f.team.teamId, requestRef: ref, requestId, decision: 'hostspan_permission',
      action: 'inspect', appName: 'hostspan-desktop', toolName: 'Process Start', allowMode: 'always', ...extra });
    const inspected = await permission(requestRef, 'inspect-original');
    assert.equal(inspected.permissionRequestRef, requestRef);
    assert.equal(inspected.permissionGeneration, 1);
    assert.equal(inspected.generation, 2);
    assert.equal(inspected.permission.requestAcknowledgementVerified, true);
    const viaPending = await permission(String(pending.outbox_id), 'inspect-pending');
    assert.equal(viaPending.permission.evidenceHash, inspected.permission.evidenceHash);
    assert.equal(viaPending.permissionRequestRef, requestRef);
    // An unrelated preparation must not acquire the previous turn's permission.
    const payload = String(pending.payload_json);
    f.core.database.raw.prepare('UPDATE outbox SET payload_json=? WHERE outbox_id=?')
      .run(JSON.stringify({ ...JSON.parse(payload), prompt: 'Unrelated work' }), pending.outbox_id);
    await assert.rejects(permission(String(pending.outbox_id), 'unrelated'), /permission|continuation|ACK/i);
    f.core.database.raw.prepare('UPDATE outbox SET payload_json=? WHERE outbox_id=?').run(payload, pending.outbox_id);
    const receipt = f.core.database.raw.prepare('SELECT result_json FROM outbox WHERE outbox_id=?').get(requestRef)!;
    f.core.database.raw.prepare('UPDATE outbox SET result_json=? WHERE outbox_id=?')
      .run(JSON.stringify({ ...JSON.parse(String(receipt.result_json)), submittedUserMessageId: 'different-ack' }), requestRef);
    await assert.rejects(permission(requestRef, 'different-ack'), /ACK/i);
    f.core.database.raw.prepare('UPDATE outbox SET result_json=? WHERE outbox_id=?').run(receipt.result_json!, requestRef);
    await f.fake.page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend',
      '<div id="later" data-message-author-role="user" data-message-id="later-user">New user</div>'));
    await assert.rejects(permission(requestRef, 'later-user'), /anchor|current turn/i);
    await f.fake.page.locator('#later').evaluate(node => node.remove());
    const allowed = await permission(requestRef, 'allow-original', { action: 'allow', evidenceHash: inspected.permission.evidenceHash });
    assert.equal(allowed.permission.outcome, 'clicked');
    assert.equal(allowed.permission.allowMode, 'always');
    assert.equal(allowed.permission.permissionStillVisible, false);
    await permission(requestRef, 'allow-original', { action: 'allow', evidenceHash: inspected.permission.evidenceHash });
    assert.equal(await f.fake.page.evaluate(() => (window as any).grants), 1);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserved user draft');
    assert.equal(await f.fake.page.locator('[data-testid="stop-button"]').count(), 1);
    assert.deepEqual(f.core.teamDirectory.getSession(f.session.sessionId), current);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(f.session.sessionId), history);
    assert.equal(original.submittedUserMessageId, history.submitted_user_message_id);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.fake.stopCount, 0);
    let returned = false;
    const waiting = f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef],
      waitMs: 60000, continuationApproved: true }).then(result => { returned = true; return result; });
    await delay(2000);
    assert.equal(returned, false, 'Historical tracking cancellation must not complete the original work wait');
    await f.fake.page.setContent(`<main>${configuration}${question}
      <div data-message-author-role="assistant" data-message-id="original-review-final" data-end-turn="true">Original review complete; git status exit0</div>
      <textarea>Preserved user draft</textarea></main>`);
    new EventRepository(f.core.database.raw).append({ teamId: f.team.teamId,
      sessionId: f.session.sessionId, generation: 2, eventType: 'fixture.final-rendered', payload: {}, createdAt: new Date().toISOString() });
    f.core.actorScheduler.refreshSession(f.session.sessionId);
    const collected = (await waiting).results[0];
    assert.equal(collected.generation, 1);
    assert.equal(collected.terminal, true);
    assert.equal(collected.workResult.responseMessageId, 'original-review-final');
    assert.match(collected.workResult.answerText, /git status exit0/);
    assert.equal(collected.workResult.ownerRequestRef, pending.outbox_id);
    assert.equal(f.fake.submitCount, 1);
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(f.session.sessionId), history);
    assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).submittedUserMessageId, null);
  } finally { await f.close(); }
});

test('missing recovery ACK controls only the exact retained work permission across literal Continues', async () => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    f.fake.idleToolTurn = true;
    f.fake.failureCount = 10;
    const workRef = await f.submit(false);
    let requestRef = workRef;
    for (let i = 0; i < 2; i++) {
      const current = f.core.teamDirectory.getSession(f.session.sessionId);
      const result = await f.rpc<any>('decide', { teamId: f.team.teamId, requestRef,
        requestId: `approved-continue-${i}`, decision: 'continue', continuationApproved: true,
        userConfirmedInterruption: { conversationId: current.conversationId,
          submittedUserMessageId: current.submittedUserMessageId, evidenceRef: 'Exact idle original inspected by user' } });
      requestRef = result.requestRef;
    }
    const current = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(current.generation, 3);
    assert.equal(current.submittedUserMessageId, 'user-message-3');
    const history = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(current.sessionId);
    const users = '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>' +
      '<div data-message-author-role="user" data-message-id="user-message-2">계속</div>' +
      '<div data-message-author-role="user" data-message-id="mounted-continue">계속</div>';
    await f.fake.page.setContent(`<main>${configuration}${users}
      <div class="group/activity-header"><button aria-expanded="false" onclick="window.unrelatedClicks=(window.unrelatedClicks||0)+1">hostspan-desktop 통합 사용함</button></div>
      <div class="group/activity-header"><button aria-expanded="false" aria-controls="work" onclick="window.reveals=(window.reveals||0)+1;this.setAttribute('aria-expanded','true');document.querySelector('#work').hidden=false">이전 활동</button></div>
      <div id="work" hidden><section id="permission"><div role="alert">hostspan-desktop File Patch target: original workspace/source.ts</div>
        <button onclick="window.grants=(window.grants||0)+1;document.querySelector('#permission').remove();document.querySelector('main').insertAdjacentHTML('beforeend','<div data-message-author-role=assistant data-message-id=work-final data-end-turn=true>Original work patch applied</div>')">Always allow</button></section></div>
      <textarea>Preserved user draft</textarea></main>`);
    const permission = (requestId: string, extra: object = {}) => f.rpc<any>('decide', {
      teamId: f.team.teamId, requestRef, requestId, decision: 'hostspan_permission',
      action: 'inspect', appName: 'hostspan-desktop', toolName: 'File Patch', allowMode: 'always', ...extra });
    await f.rpc('team_get', { teamId: f.team.teamId, requestRef, view: 'evidence' });
    assert.equal(await f.fake.page.evaluate(() => (window as any).reveals ?? 0), 0, 'Passive observation remains click0');
    const payload = f.core.database.raw.prepare('SELECT payload_json FROM outbox WHERE outbox_id=?').get(requestRef)!;
    f.core.database.raw.prepare('UPDATE outbox SET payload_json=? WHERE outbox_id=?')
      .run(JSON.stringify({ ...JSON.parse(String(payload.payload_json)), continuationOf: 'foreign-request' }), requestRef);
    await assert.rejects(permission('foreign-lineage'), /anchor|current turn/i);
    f.core.database.raw.prepare('UPDATE outbox SET payload_json=? WHERE outbox_id=?').run(payload.payload_json!, requestRef);
    for (const [index, html] of [
      '<div data-message-author-role="user" data-message-id="other-wp">Different work</div>',
      '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>',
    ].entries()) {
      await f.fake.page.locator('main').evaluate((node, html) => node.insertAdjacentHTML('beforeend', '<aside id="unsafe">' + html + '</aside>'), html);
      await assert.rejects(permission('unsafe-' + index), /anchor|current turn/i);
      await f.fake.page.locator('#unsafe').evaluate(node => node.remove());
    }
    const inspected = await permission('inspect-exact-work');
    assert.equal(inspected.requestRef, requestRef);
    assert.equal(inspected.permissionRequestRef, requestRef);
    assert.equal(inspected.workRequestRef, workRef);
    assert.equal(inspected.workGeneration, 1);
    assert.equal(inspected.permission.requestAcknowledgementVerified, false);
    assert.equal(inspected.permission.workAcknowledgementVerified, true);
    assert.equal(inspected.permission.currentUserMessageId, 'mounted-continue');
    assert.equal(inspected.permission.workUserMessageId, 'user-message-1');
    assert.ok(inspected.permission.evidenceHash);
    assert.equal(await f.fake.page.evaluate(() => (window as any).unrelatedClicks ?? 0), 0);
    const allowed = await permission('allow-exact-work', { action: 'allow', evidenceHash: inspected.permission.evidenceHash });
    assert.equal(allowed.permission.outcome, 'clicked');
    assert.equal(allowed.permission.permissionStillVisible, false);
    assert.equal(await f.fake.page.evaluate(() => (window as any).grants), 1);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserved user draft');
    const recovered = await f.rpc<any>('team_get', { teamId: f.team.teamId, requestRef, view: 'evidence' });
    assert.equal(recovered.request.workResult.responseMessageId, 'work-final');
    assert.equal(recovered.request.workResult.originalRequestRef, workRef);
    assert.equal(f.core.teamDirectory.getSession(current.sessionId).submittedUserMessageId, 'user-message-3');
    assert.deepEqual(f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(current.sessionId), history);
    assert.equal(f.fake.submitCount, 3);
    assert.equal(f.fake.stopCount, 0);
  } finally { await f.close(); }
});

test('continuation reobserves the configured version after chooser identity changes despite a generic model hint', async t => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    f.fake.idleToolTurn = true;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const observed = await f.rpc<any>('team_get', { teamId: f.team.teamId, requestRef, view: 'evidence' });
    const currentModel = observed.request.evidence.nodes.find((node: any) => node.id === 'configuration');
    const receiptId = `submission-configuration:${requestRef}`;
    const receipt = f.core.database.raw.prepare('SELECT result_json FROM request_receipts WHERE request_id=?').get(receiptId)!;
    const saved = JSON.parse(String(receipt.result_json));
    saved.model = { ...saved.model, id: 'radix-old-chooser', configurationVersion: '5.5 Pro' };
    f.core.database.raw.prepare('UPDATE request_receipts SET result_json=? WHERE request_id=?').run(JSON.stringify(saved), receiptId);
    const row = f.core.database.raw.prepare('SELECT payload_json FROM outbox WHERE outbox_id=?').get(requestRef)!;
    f.core.database.raw.prepare('UPDATE outbox SET payload_json=? WHERE outbox_id=?')
      .run(JSON.stringify({ ...JSON.parse(String(row.payload_json)), model: 'Thinking' }), requestRef);
    const reobserve = t.mock.method(ChatGptConfigurationMenu.prototype, 'reobserveSelection', async (model, effort) => {
      if (model !== '5.5 Pro') throw new SessionPlaneDomainError('provider.configuration-stale',
        'Current version/effort does not match the original continuation');
      assert.equal(effort, 'Extra High');
      return currentModel;
    });
    f.fake.failureCount = 1;
    const result = await f.rpc<any>('decide', { teamId: f.team.teamId, requestRef, requestId: 'configured-version-continue',
      decision: 'continue', continuationApproved: true, userConfirmedInterruption: {
        conversationId: original.conversationId, submittedUserMessageId: original.submittedUserMessageId,
        evidenceRef: 'Exact idle original inspected by user' } });
    assert.equal(result.generation, 2);
    assert.equal(result.promptSubmitted, true);
    assert.equal(result.submittedUserMessageId, 'user-message-2');
    assert.equal(reobserve.mock.callCount(), 1);
    const next = f.core.database.raw.prepare('SELECT result_json FROM request_receipts WHERE request_id=?')
      .get(`submission-configuration:${result.requestRef}`)!;
    assert.equal(JSON.parse(String(next.result_json)).model.configurationVersion, '5.5 Pro');
    assert.equal(f.fake.submitCount, 2);
    assert.deepEqual(f.fake.submissionRequests.filter((r, i, all) => all.findIndex(x => x.generation === r.generation) === i).map(r => r.prompt),
      ['Original operation snapshot', '계속']);
  } finally { await f.close(); }
});

test('managed configuration failure returns the exact prepared successor and normal caller action without a human requirement', async t => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    f.fake.idleToolTurn = true;
    const requestRef = await f.submit(false);
    f.core.database.raw.prepare('UPDATE outbox SET created_at=? WHERE outbox_id=?')
      .run(new Date(Date.now() - 31 * 60_000).toISOString(), requestRef);
    t.mock.method(SessionUiService.prototype, 'prepareFailureContinuation', async () => {
      throw new SessionPlaneDomainError('provider.configuration-stale', 'Current version/effort does not match the original continuation');
    });
    const result = (await f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef],
      waitMs: 60000, continuationApproved: true })).results[0];
    const pending = f.core.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? AND generation=2').get(f.session.sessionId)!;
    assert.equal(result.requestRef, pending.outbox_id);
    assert.equal(result.generation, 2);
    assert.equal(result.submissionState, 'prepared');
    assert.equal(result.promptSubmitted, false);
    assert.equal(result.terminal, false);
    assert.equal(result.recovery.reason, 'provider.configuration-stale');
    assert.equal(result.recovery.originalRequestRef, requestRef);
    assert.equal(result.recovery.nextAction, 'configure_same_request');
    assert.equal(result.recovery.userActionRequired, false);
    assert.equal(result.recovery.decisionRequired, true);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.fake.stopCount, 0);
  } finally { await f.close(); }
});

test('explicitly confirmed idle acknowledged turn with no response continues once without replaying product input', async () => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    f.fake.idleToolTurn = true;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const input = { teamId: f.team.teamId, requestRef, requestId: `managed-continuation:${requestRef}`,
      decision: 'continue', continuationApproved: true, userConfirmedInterruption: {
        conversationId: original.conversationId!, submittedUserMessageId: original.submittedUserMessageId!,
        evidenceRef: 'User explicitly requests continue for the exact idle original with no assistant/tool response' } };
    const body = '<main>' + configuration + '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>';
    await f.fake.page.setContent(body + '<textarea></textarea></main>');
    await assert.rejects(f.rpc('decide', { ...input, userConfirmedInterruption: undefined }), /server evidence/);
    for (const controls of ['<textarea>Other draft</textarea>', '<textarea></textarea><button data-testid="stop-button">Stop</button>']) {
      await f.fake.page.setContent(body + controls + '</main>');
      await assert.rejects(f.rpc('decide', input), /idle|draft/);
      assert.equal(f.fake.submitCount, 1);
    }
    await f.fake.page.setContent(body + '<textarea></textarea></main>');
    f.fake.failureCount = 1;
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="idle-recovered" data-end-turn="true">Recovered work</div>';
    const result = await f.rpc<any>('decide', input);
    assert.equal(result.generation, 2);
    assert.ok(result.submittedUserMessageId);
    assert.equal(f.fake.submitCount, 2);
    await f.rpc('decide', input);
    assert.equal(f.fake.submitCount, 2);
    const payload = f.core.database.raw.prepare('SELECT payload_json FROM outbox WHERE outbox_id=?').get(result.requestRef)!;
    assert.equal(JSON.parse(String(payload.payload_json)).prompt, '계속');
  } finally { await f.close(); }
});

test('user-confirmed exact disconnected turn continues once despite deferred backend and stale Stop, preserving partial and ACK', async () => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    f.fake.idleToolTurn = true;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const confirmation = { conversationId: original.conversationId!, submittedUserMessageId: original.submittedUserMessageId!,
      evidenceRef: 'user directly inspected original disconnected conversation and requested one continue' };
    const input = { teamId: f.team.teamId, requestRef, requestId: `managed-continuation:${requestRef}`,
      decision: 'continue', continuationApproved: true, userConfirmedInterruption: confirmation };
    const partial = '<div data-message-author-role="assistant" data-message-id="original-partial">Retain original partial</div>';
    const body = '<main>' + configuration + '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>';
    const disconnected = '<div role="status">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div>';
    const controls = '<textarea></textarea><button data-testid="stop-button">Stop</button></main>';
    await f.fake.page.setContent(body + partial + disconnected + controls);
    await f.fake.page.setContent(body + partial + controls);
    await assert.rejects(f.rpc('decide', { ...input, userConfirmedInterruption: undefined }), /idle|server evidence|active generation/);
    await f.fake.page.setContent(body + partial + disconnected + controls);
    await assert.rejects(f.rpc('decide', { ...input, userConfirmedInterruption: { ...confirmation, conversationId: 'other-chat' } }), /exact acknowledged/);
    const scope = { conversationId: original.conversationId, pageKey: original.pageKey,
      submittedUserMessageId: original.submittedUserMessageId, submittedUserTurnId: original.submittedUserTurnId };
    const server = { anchorNodeId: original.submittedUserMessageId, currentNodeId: 'server-current', nextUserFound: false,
      assistantCount: 1, messages: [{ messageId: 'server-current', role: 'assistant' as const, channel: 'analysis',
        status: 'in_progress', endTurn: false, hidden: false, textLength: 1 }] };
    await f.core.actorScheduler.updateGeneration(original.sessionId, 1, {}, 'generation.backend-pending', 'backend-assistant-not-final', scope, server);
    await assert.rejects(f.rpc('decide', input), /Fresh server activity/);
    await f.core.actorScheduler.updateGeneration(original.sessionId, 1, {}, 'generation.backend-pending', 'backend-assistant-not-final', scope,
      { ...server, messages: [] });
    for (const unsafe of [body + partial + controls,
      body + partial.replace('data-message-id="original-partial"', 'data-message-id="original-partial" data-message-status="in_progress"') + disconnected + controls,
      body + partial + disconnected + '<div data-testid="thinking">Thinking</div>' + controls,
      body + partial + disconnected + controls.replace('<textarea></textarea>', '<textarea>Separate draft</textarea>'),
      body + partial + disconnected + '<div role="alertdialog">HostSpan permission</div>' + controls,
      body + partial + disconnected + '<div data-message-author-role="user" data-message-id="later-user">Already continued</div>' + controls]) {
      await f.fake.page.setContent(unsafe);
      await assert.rejects(f.rpc('decide', input), /disconnected|draft|idle/);
      assert.equal(f.fake.submitCount, 1);
    }
    await f.fake.page.setContent(body + partial + disconnected + controls);
    f.fake.afterPrepare = () => {
      assert.equal(f.core.teamDirectory.getSession(original.sessionId).generation, 2);
    };
    f.fake.failureCount = 1;
    f.fake.surface = users => users + partial +
      '<div data-message-author-role="assistant" data-message-id="continued-answer" data-end-turn="true">Resumed original work</div>';
    const result = await f.rpc<any>('decide', input);
    assert.equal(result.generation, 2); assert.equal(result.promptSubmitted, true);
    assert.ok(result.submittedUserMessageId); assert.notEqual(result.submittedUserMessageId, original.submittedUserMessageId);
    assert.equal(f.fake.submitCount, 2);
    const old = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(original.sessionId)!;
    assert.equal(old.submitted_user_message_id, original.submittedUserMessageId);
    assert.equal(old.answer_text, null); assert.equal(old.reason, 'approved-continuation-prepared');
    assert.equal(result.reconciliation.evidence.interruptedResponseMessageId, 'original-partial');
    assert.equal(await f.fake.page.locator('[data-message-id="original-partial"]').innerText(), 'Retain original partial');
    const confirmationPath = path.join(f.root, 'user-confirmation.json');
    writeFileSync(confirmationPath, JSON.stringify(confirmation));
    const code = await runCli(['request', 'continue', f.team.teamId, requestRef,
      '--continuation-approved', '--user-confirmed-interruption', confirmationPath,
      '--request-id', input.requestId, '--socket', f.config.socketPath, '--json'], {
      stdin: Readable.from([]), stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    });
    assert.equal(code, 0);
    assert.equal(f.fake.submitCount, 2, 'CLI replay of the same authorization cannot submit twice');
    const collected = await f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef], waitMs: 60000, continuationApproved: true });
    assert.equal(collected.results[0].generation, 2, 'Existing manager adopts the same durable successor');
    assert.equal(f.fake.submitCount, 2);
  } finally { await f.close(); }
});

test('a lost continuation ACK uses proven server absence and the exact retained predecessor without replaying product work', async () => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    const first = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const disconnected = '<div role="status">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div>';
    const body = '<main>' + configuration + '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>';
    const controls = '<textarea></textarea><button data-testid="stop-button">Stop</button></main>';
    await f.fake.page.setContent(body + disconnected + controls);
    const next = await f.rpc<any>('decide', { teamId: f.team.teamId, requestRef: first,
      requestId: 'first-continue', decision: 'continue', continuationApproved: true,
      userConfirmedInterruption: { conversationId: original.conversationId,
        submittedUserMessageId: original.submittedUserMessageId, evidenceRef: 'User confirmed original interruption' } });
    const current = f.core.teamDirectory.getSession(f.session.sessionId);
    await f.fake.page.setContent(body + disconnected + controls);
    const input = { teamId: f.team.teamId, requestRef: next.requestRef, requestId: `managed-continuation:${next.requestRef}`,
      decision: 'continue', continuationApproved: true };
    await assert.rejects(f.rpc('decide', input), /idle original turn/);
    await f.core.actorScheduler.updateGeneration(current.sessionId, 2, {}, 'generation.backend-unverified',
      'backend-user-anchor-absent-from-mapping', { conversationId: current.conversationId, pageKey: 'previous-core-page',
        submittedUserMessageId: current.submittedUserMessageId, submittedUserTurnId: current.submittedUserTurnId });
    await f.fake.page.setContent(body + '<div data-message-author-role="user" data-message-id="later">Already sent</div>' + disconnected + controls);
    await assert.rejects(f.rpc('decide', input), /idle original turn/);
    await f.fake.page.setContent(body + disconnected + controls);
    f.fake.failureCount = 2;
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="recovered" data-end-turn="true">New work recovered</div>';
    const recovered = await f.rpc<any>('decide', input);
    assert.equal(recovered.generation, 3);
    assert.ok(recovered.submittedUserMessageId);
    assert.equal(recovered.reconciliation.evidence.missingContinuationAcknowledgement, current.submittedUserMessageId);
    assert.equal(recovered.reconciliation.evidence.retainedPredecessorAcknowledgement, original.submittedUserMessageId);
    assert.equal(f.fake.submitCount, 3, 'Each approved continuation is dispatched once; product prompt is never replayed');
    const replay = await f.rpc<any>('decide', input);
    assert.equal(replay.requestRef, recovered.requestRef);
    assert.equal(f.fake.submitCount, 3);
  } finally { await f.close(); }
});

test('an explicitly approved followup recovers several lost literal continuations without replaying product work or changing old ACKs', async () => {
  const f = await fixture();
  try {
    f.fake.idleToolTurn = true;
    f.fake.failureCount = 10;
    f.fake.missingTimeoutAnchor = true;
    const disconnected = '<div role="status">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div>';
    f.fake.surface = users => users + disconnected;
    let requestRef = await f.submit(false);
    for (let i = 0; i < 3; i++) {
      const next = await f.rpc<any>('decide', { teamId: f.team.teamId, requestRef,
        requestId: `before-refresh-${i}`, decision: 'continue', continuationApproved: true });
      requestRef = next.requestRef;
    }
    const current = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(current.generation, 4);
    const originalRows = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(current.sessionId);
    const body = `<main>${configuration}<div data-message-author-role="user" data-message-id="user-message-1">Original</div>` +
      '<div data-message-author-role="assistant" data-message-id="old-product-answer" data-end-turn="true">Previous product result</div>' +
      '<div data-message-author-role="user" data-message-id="user-message-2">계속</div>';
    const controls = '<textarea id="prompt-textarea">계속</textarea><button data-testid="send-button">Send</button></main>';
    await f.fake.page.setContent(body + controls);
    const input = { teamId: f.team.teamId, requestRef, requestId: 'explicit-after-refresh',
      decision: 'followup', approvalRef: 'User confirmed refresh complete and explicitly approved continuing the original work' };
    await assert.rejects(f.rpc('decide', input), /UNKNOWN|lost literal/);
    await f.core.actorScheduler.updateGeneration(current.sessionId, 4, {}, 'generation.backend-unverified',
      'backend-user-anchor-absent-from-mapping', { conversationId: current.conversationId, pageKey: current.pageKey,
        submittedUserMessageId: current.submittedUserMessageId, submittedUserTurnId: current.submittedUserTurnId });
    await f.fake.page.locator('textarea').fill('Preserve this unrelated draft');
    await assert.rejects(f.rpc('decide', input), /draft|page/);
    assert.equal(f.fake.submitCount, 4);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserve this unrelated draft');
    await f.fake.page.locator('textarea').fill('계속');
    f.fake.failureCount = 4;
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="new-result" data-end-turn="true">Resumed original work</div>';
    const resumed = await f.rpc<any>('decide', input);
    assert.equal(resumed.generation, 5);
    assert.ok(resumed.submittedUserMessageId);
    assert.equal(f.fake.submitCount, 5);
    assert.equal(f.fake.submissionRequests.at(-1)!.prompt, '계속');
    const preserved = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation<=4 ORDER BY generation').all(current.sessionId);
    assert.deepEqual(preserved.map(row => [row.generation, row.submission_state, row.submitted_user_message_id, row.answer_text]),
      originalRows.map(row => [row.generation, row.submission_state, row.submitted_user_message_id, row.answer_text]));
    const replay = await f.rpc<any>('decide', input);
    assert.equal(replay.requestRef, resumed.requestRef);
    assert.equal(f.fake.submitCount, 5);
    assert.equal(f.fake.stopCount, 0);
  } finally { await f.close(); }
});

test('user review pauses the existing managed collector and observation without stopping execution, then resumes the same request', async t => {
  const f = await fixture();
  try {
    f.fake.idleToolTurn = true;
    f.fake.surface = users => users;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    await f.fake.page.locator('textarea').fill('Preserved user draft');
    const input = { teamId: f.team.teamId, requestRef, decision: 'human_review' };
    const waiting = f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef],
      waitMs: 60000, continuationApproved: true });
    await until(() => f.core.actorScheduler.actorFor(original.sessionId).subscriberCount > 0);
    const pause = await f.rpc<any>('decide', { ...input, requestId: 'user-pause', action: 'pause' });
    assert.equal(pause.observationHeld, true);
    const reads = t.mock.method(f.fake.page, 'evaluate');
    const opened = f.fake.observationOpenCount;
    const get = await f.rpc<any>('team_get', { view: 'summary', teamId: f.team.teamId, requestRef });
    const held = (await waiting).results[0];
    assert.equal(get.request.observationHeld, true);
    assert.equal(held.observationHeld, true);
    assert.equal(held.recovery.automaticContinuation, false);
    const focused = t.mock.method(f.fake.page, 'bringToFront', async () => {});
    const focusInput = { teamId: f.team.teamId, requestRef, requestId: 'held-focus', decision: 'focus' };
    const focus = await f.rpc<any>('decide', focusInput);
    assert.equal(focus.activated, true);
    assert.equal(focus.requestRef, requestRef);
    assert.equal(focus.pageKey, original.pageKey);
    assert.equal(focus.url, f.fake.page.url());
    assert.equal(f.core.submissionService.isObservationHeld(original.conversationId), true);
    assert.equal((await f.rpc<any>('decide', focusInput)).activated, true);
    assert.equal(focused.mock.callCount(), 1, 'Replaying focus does not activate another tab');
    await f.core.recoveryService.ensurePage(original.sessionId, original.generation);
    await f.core.recoveryService.restore({ forceObservers: true });
    f.core.observationService.start(original, { force: true });
    await assert.rejects(f.rpc('decide', { teamId: f.team.teamId, requestRef, requestId: 'held-continue',
      decision: 'continue', continuationApproved: true }), /paused/);
    await assert.rejects(f.rpc('send', { teamId: f.team.teamId, roleRef: `${original.sessionId}:${original.generation}`,
      requestId: 'held-new-review', prompt: 'Read-only review' }), error => {
        assert.ok(error instanceof RpcClientError);
        assert.equal((error.data as { errorCode: string }).errorCode, 'provider.preparation-required');
        assert.match(error.message, /new submissions are paused/);
        return true;
      });
    assert.equal(f.core.database.raw.prepare('SELECT COUNT(*) AS n FROM outbox WHERE request_id=?').get('held-new-review')!.n, 0);
    assert.equal(f.core.teamDirectory.getSession(original.sessionId).generation, original.generation);
    assert.equal(reads.mock.callCount(), 0, 'Stored reads and reattachment must not observe the user-controlled page');
    assert.equal(f.fake.observationOpenCount, opened);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.fake.stopCount, 0);
    assert.equal(f.core.teamDirectory.getSession(original.sessionId).submittedUserMessageId, original.submittedUserMessageId);
    assert.equal(f.core.submissionService.isObservationHeld('unrelated-conversation'), false);
    reads.mock.restore();
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserved user draft');
    const resumed = await f.rpc<any>('decide', { ...input, requestId: 'user-resume', action: 'resume' });
    assert.equal(resumed.observationHeld, false);
    await until(() => f.fake.observationOpenCount > opened);
    const replay = await f.rpc<any>('decide', { ...input, requestId: 'user-pause', action: 'pause' });
    assert.equal(replay.observationHeld, true, 'Receipt replay returns its original result');
    assert.equal(f.core.submissionService.isObservationHeld(original.conversationId), false, 'Replaying an old pause cannot pause resumed work');
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.fake.stopCount, 0);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserved user draft');
  } finally { await f.close(); }
});

for (const newTool of [false, true]) test(`managed recovery reviews a persistent empty disconnection${newTool ? ' while preserving new exact tool progress' : ' without treating old tools or its ACK as progress'}`, async () => {
  const f = await fixture();
  try {
    f.fake.idleToolTurn = true;
    f.fake.missingTimeoutAnchor = true;
    const disconnected = '<div role="status">연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.</div>';
    f.fake.surface = users => users + disconnected;
    const originalRef = await f.submit(false);
    const next = await f.rpc<any>('decide', { teamId: f.team.teamId, requestRef: originalRef,
      requestId: `managed-continuation:${originalRef}`, decision: 'continue', continuationApproved: true });
    assert.equal(next.generation, 2);
    const current = f.core.teamDirectory.getSession(f.session.sessionId);
    const old = new Date(Date.now() - 31 * 60_000).toISOString();
    f.core.database.raw.prepare('UPDATE outbox SET updated_at=? WHERE outbox_id=?').run(old, next.requestRef);
    // A completed tool from the predecessor cannot hide this successor's lack
    // of results. Only an exact post-ACK tool belongs to the current recovery.
    new EventRepository(f.core.database.raw).append({ teamId: f.team.teamId, sessionId: current.sessionId,
      generation: newTool ? 2 : 1, eventType: 'generation.backend-pending', createdAt: new Date().toISOString(),
      payload: { recoveryIdentity: { conversationId: current.conversationId, pageKey: current.pageKey,
        submittedUserMessageId: newTool ? current.submittedUserMessageId : 'user-message-1',
        submittedUserTurnId: newTool ? current.submittedUserTurnId : 'user-message-1' },
        serverObservation: { anchorNodeId: newTool ? current.submittedUserMessageId : 'user-message-1',
          currentNodeId: 'returned-tool', nextUserFound: false, assistantCount: 1,
          messages: [{ messageId: 'returned-tool', role: 'tool', channel: 'commentary',
            status: 'finished_successfully', endTurn: null, hidden: false, textLength: 0 }] } } });
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="final" data-end-turn="true">Recovered work</div>';
    const result = (await f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [originalRef],
      waitMs: 60000, continuationApproved: true })).results[0];
    if (newTool) {
      assert.equal(result.generation, 3);
      assert.equal(result.terminal, true);
      assert.equal(result.recovery?.userActionRequired, undefined);
      assert.equal(f.fake.submitCount, 3);
    } else {
      assert.equal(result.generation, 2);
      assert.equal(result.terminal, false);
      assert.equal(result.recovery?.decisionRequired, true);
      assert.equal(result.recovery?.userActionRequired, true);
      assert.equal(result.recovery?.url, `https://chatgpt.com/c/${current.conversationId}`);
      assert.equal(f.fake.submitCount, 2, 'An ACK alone must not restart another ineffective recovery');
      assert.equal(f.core.teamDirectory.getSession(current.sessionId).terminal, false);
    }
  } finally { await f.close(); }
});

test('managed wait resumes its already prepared continuation without another generation or send', async t => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const identity = { conversationId: original.conversationId, pageKey: original.pageKey,
      submittedUserMessageId: original.submittedUserMessageId, submittedUserTurnId: original.submittedUserTurnId };
    await f.core.actorScheduler.updateGeneration(original.sessionId, 1, {}, 'generation.backend-pending',
      'backend-assistant-not-final', identity, { anchorNodeId: original.submittedUserMessageId,
        currentNodeId: 'tool-done', nextUserFound: false, assistantCount: 1,
        messages: [{ messageId: 'tool-done', role: 'tool', channel: 'commentary',
          status: 'finished_successfully', endTurn: true, hidden: false, textLength: 0 }] });
    await f.fake.page.setContent('<main>' + configuration +
      '<div data-message-author-role="user" data-message-id="user-message-1">Original</div><textarea></textarea><button data-testid="send-button">Send</button></main>');
    const blocked = t.mock.method(SessionUiService.prototype, 'prepareFailureContinuation', async () => {
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Fresh configuration evidence is missing');
    });
    await assert.rejects(f.rpc('decide', { teamId: f.team.teamId, requestRef,
      requestId: `managed-continuation:${requestRef}`, decision: 'continue', continuationApproved: true }), /configuration/);
    blocked.mock.restore();
    assert.equal(f.core.teamDirectory.getSession(original.sessionId).generation, 2);
    assert.equal(f.fake.submitCount, 1);
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="resumed-answer">Resumed answer</div>';
    const result = await f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef], waitMs: 60000, continuationApproved: true });
    assert.equal(result.results[0].generation, 2);
    assert.equal(f.fake.submitCount, 2);
    assert.equal(f.core.teamDirectory.getSession(original.sessionId).generation, 2);
  } finally { await f.close(); }
});

test('managed collection links an existing followup under unsubmitted continuation preserving both generations and draft', async t => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const identity = { conversationId: original.conversationId, pageKey: original.pageKey,
      submittedUserMessageId: original.submittedUserMessageId, submittedUserTurnId: original.submittedUserTurnId };
    await f.core.actorScheduler.updateGeneration(original.sessionId, 1, {}, 'generation.backend-pending',
      'backend-assistant-not-final', identity, { anchorNodeId: original.submittedUserMessageId,
        currentNodeId: 'tool-done', nextUserFound: false, assistantCount: 1,
        messages: [{ messageId: 'tool-done', role: 'tool', channel: 'commentary',
          status: 'finished_successfully', endTurn: true, hidden: false, textLength: 0 }] });
    await f.fake.page.setContent('<main>' + configuration +
      '<div data-message-author-role="user" data-message-id="user-message-1">Original</div><textarea></textarea><button data-testid="send-button">Send</button></main>');
    const blocked = t.mock.method(SessionUiService.prototype, 'prepareFailureContinuation', async () => {
      throw new SessionPlaneDomainError('provider.failure-unverified', 'Fresh configuration evidence is missing');
    });
    await assert.rejects(f.rpc('decide', { teamId: f.team.teamId, requestRef,
      requestId: `managed-continuation:${requestRef}`, decision: 'continue', continuationApproved: true }), /configuration/);
    blocked.mock.restore();
    assert.equal(f.core.teamDirectory.getSession(original.sessionId).generation, 2);
    assert.equal(f.fake.submitCount, 1);
    const generations = () => f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? ORDER BY generation').all(original.sessionId);
    const before = generations();
    // Search groups now contain individually identified assistant renderers.
    await f.fake.page.setContent(`<main>${configuration}
      <div data-chatgpt-search-message-ids="user-message-1"><div data-user-message-bubble>Original</div></div>
      <div data-chatgpt-search-unit-key="fallback-turn-1:2:assistant" data-chatgpt-search-message-ids="partial partial"><div data-dil-message-id="partial"><div data-d-component="text">Original partial</div></div></div>
      <div data-chatgpt-search-message-ids="manual-user"><div data-user-message-bubble>계속</div></div>
      <div data-chatgpt-search-unit-key="fallback-turn-2:2:assistant" data-chatgpt-search-message-ids="checkpoint checkpoint final">
        <div data-dil-message-id="checkpoint"><div data-d-component="text">Checking</div></div>
        <div data-dil-message-id="final"><div data-d-component="text">RESULT: BLOCKED — VM SSH exit255</div></div>
      </div><textarea>Preserved user draft</textarea></main>`);
    const bounded = await f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef], waitMs: 0 });
    assert.equal(bounded.results[0].followup.terminal, false,
      'A bounded/drained read must retain followup state so the client cannot mistake the historical terminal for collection completion');
    const result = await f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef], waitMs: 60000, continuationApproved: true });
    const recovered = result.results[0];
    assert.equal(recovered.followup.userMessageId, 'manual-user', JSON.stringify(recovered));
    assert.equal(recovered.followup.responseMessageId, 'final');
    assert.equal(recovered.followup.answerText, 'RESULT: BLOCKED — VM SSH exit255');
    assert.equal(recovered.reconciliation.disposition, 'historical-followup-linked');
    assert.equal(recovered.reconciliation.evidence.originalUserMessageId, original.submittedUserMessageId);
    assert.equal(recovered.reconciliation.providerMutation, false);
    assert.deepEqual(generations(), before);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserved user draft');
    assert.equal(f.fake.submitCount, 1);
    const again = await f.rpc<any>('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef });
    assert.equal(again.request.followup.answerText, recovered.followup.answerText);
    assert.equal(again.request.responseMessageId, null);
    assert.equal((await f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef], waitMs: 60000 })).results[0].followup.responseMessageId, 'final');
  } finally { await f.close(); }
});

test('confirmed manual follow-up releases only original tracking and permits new work without borrowing its answer', async () => {
  const f = await fixture();
  const { createHash } = await import('node:crypto');
  const answer = 'Review complete: CHANGES_REQUIRED';
  const partial = '<div data-message-author-role="assistant" data-message-id="original-partial">Original checkpoint, work remains.</div>';
  const followup = '<div data-message-author-role="user" data-message-id="manual-user">Repeat the missing answer</div>';
  const final = `<div data-message-author-role="assistant" data-message-id="manual-answer">${answer}</div>`;
  try {
    f.fake.surface = users => users + followup + final;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const input = { teamId: f.team.teamId, requestRef, requestId: 'manual-release', decision: 'reconcile_followup',
      followupUserMessageId: 'manual-user', responseMessageId: 'manual-answer',
      responseSha256: createHash('sha256').update(answer).digest('hex'), followupCompleted: true };
    const body = (middle: string) => `<main>${configuration}<div data-message-author-role="user" data-message-id="user-message-1">Original</div>${middle}<textarea>Preserved draft</textarea></main>`;
    for (const unsafe of [followup + final + '<button data-testid="stop-button">Stop</button>',
      followup + final.replace(answer, 'Different answer'), followup + final + '<div data-message-author-role="user" data-message-id="newer">Newer question</div>',
      '<div data-message-author-role="assistant" data-message-id="original-answer" data-end-turn="true">Original recovered</div>' + followup + final,
      partial.replace('original-partial"', 'original-partial" data-is-streaming="true"') + followup + final,
      '<div data-message-author-role="user" data-message-id="unrelated-user">Different work</div>' + followup + final,
      '<div data-message-author-role="user" data-message-id="user-message-1">Duplicate original</div>' + followup + final,
      followup + followup + final]) {
      await f.fake.page.setContent(body(unsafe));
      await assert.rejects(f.rpc('decide', input), /not verified/);
      assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).terminal, false);
    }
    await f.fake.page.setContent(body(partial + '<div id="other-root"></div>'));
    await f.fake.page.locator('#other-root').evaluate((host, content) => {
      host.attachShadow({ mode: 'open' }).innerHTML = content;
    }, followup + final);
    await assert.rejects(f.rpc('decide', input), /not verified/, 'Separate transcript roots cannot establish ancestry');
    await f.fake.page.setContent(body(partial + followup + final));
    const released = await f.rpc<any>('decide', input);
    assert.equal(released.reconciliation.disposition, 'tracking-cancelled');
    assert.equal(released.reconciliation.providerMutation, false);
    assert.deepEqual(released.reconciliation.evidence.originalPartialResponses, [{ responseMessageId: 'original-partial',
      responseSha256: createHash('sha256').update('Original checkpoint, work remains.').digest('hex') }]);
    const closed = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(closed.sessionState, 'cancelled');
    assert.equal(closed.reason, 'manual-followup-reconciled');
    assert.equal(closed.responseMessageId, null);
    assert.equal(closed.answerText, null);
    assert.equal(closed.submittedUserMessageId, original.submittedUserMessageId);
    assert.equal(closed.conversationId, original.conversationId);
    assert.equal(closed.promptSubmitted, true);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserved draft');
    assert.equal(f.fake.submitCount, 1);
    await f.rpc('decide', input);
    assert.equal(f.core.database.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE event_type='generation.manual-followup-reconciled'").get()!.n, 1);
    await assert.rejects(f.rpc('decide', { ...input, responseMessageId: 'different' }), /different|conflict|reused/);
    await assert.rejects(f.core.submissionService.send({ clientId: `team:${f.team.teamId}`, sessionId: f.session.sessionId,
      expectedGeneration: 1, requestId: 'separately-authorized-next-work', prompt: 'New review', model: '5.5 Pro',
      sessionDeadlineSec: 60 }), /preparation|decision/i);
    const prepared = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(prepared.generation, 2);
    assert.equal(prepared.promptSubmitted, false);
    assert.equal(f.fake.submitCount, 1);
    const retained = f.core.database.raw.prepare('SELECT answer_text,response_message_id,submitted_user_message_id FROM generations WHERE session_id=? AND generation=1').get(f.session.sessionId)!;
    assert.equal(retained.answer_text, null); assert.equal(retained.response_message_id, null);
    assert.equal(retained.submitted_user_message_id, original.submittedUserMessageId);
  } finally { await f.close(); }
});


test('manual follow-up reconciliation cannot release an UNKNOWN submission', async () => {
  const f = await fixture();
  try {
    f.fake.acknowledgementMode = 'missing';
    const requestRef = await f.submit(false);
    const before = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(before.submissionState, 'submission_unknown');
    await assert.rejects(f.rpc('decide', { teamId: f.team.teamId, requestRef, requestId: 'unknown-manual-release',
      decision: 'reconcile_followup', followupUserMessageId: 'manual-user', responseMessageId: 'manual-answer',
      responseSha256: '0'.repeat(64), followupCompleted: true }), /unresolved acknowledged/);
    assert.deepEqual(f.core.teamDirectory.getSession(f.session.sessionId), before);
    assert.equal(f.fake.submitCount, 1);
  } finally { await f.close(); }
});

test('already-submitted continuation collects checkpoints and reconciles without another submit', async () => {
  const f = await fixture();
  try {
    f.fake.surface = users => users + '<div data-message-author-role="user" data-message-id="manual-user">계속</div><button data-testid="stop-button">Stop</button>';
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    let returned = false;
    const waiting = f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef],
      waitMs: 600000, followupUserMessageId: 'manual-user' }).then(result => { returned = true; return result; });
    await delay(250);
    assert.equal(returned, false);
    await f.fake.page.setContent(`<main>${configuration}<div data-message-author-role="user" data-message-id="user-message-1">Original</div>
      <div data-message-author-role="assistant" data-message-id="original-partial">Original unfinished</div>
      <div data-message-author-role="user" data-message-id="manual-user">계속</div>
      <div data-message-author-role="assistant" data-message-id="checkpoint">Implementing</div>
      <div data-message-author-role="assistant" data-message-id="manual-final" data-end-turn="true">Actual final</div><textarea></textarea></main>`);
    const [result] = (await waiting).results;
    assert.equal(result.followup.responseMessageId, 'manual-final');
    assert.equal(result.followup.answerText, 'Actual final');
    assert.equal(result.reconciliation.providerMutation, false);
    const closed = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(closed.submittedUserMessageId, original.submittedUserMessageId);
    assert.equal(closed.responseMessageId, null);
    assert.equal(closed.reason, 'manual-followup-reconciled');
    assert.equal(f.fake.submitCount, 1);
  } finally { await f.close(); }
});

test('explicit message-timeout reconciliation preserves original ACK, rejects live Stop and permits one owner continuation', async () => {
  const f = await fixture();
  try {
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="interrupted">Started the original work; results are still pending.</div><aside role="alert">메시지 전송 시간이 초과되었습니다. 다시 시도하세요. 다시 시도</aside>';
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const input: { teamId: string; requestRef: string; requestId: string; decision: string; continuationPrompt?: '계속' } = { teamId: f.team.teamId, requestRef, requestId: 'timeout-reconcile', decision: 'reconcile_failure' };
    await f.fake.page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<button aria-label="Stop">Stop</button>'));
    await assert.rejects(f.rpc('decide', { ...input, continuationPrompt: '계속' }), /active generation/);
    assert.equal(f.fake.submitCount, 1);
    const active = await f.rpc<any>('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef });
    assert.equal(active.request.submissionVerification.nextAction, 'read_same_request');
    await f.fake.page.locator('button[aria-label="Stop"]').evaluate(node => node.remove());
    let inspected = '';
    const inspectCode = await runCli(['request', 'show', f.team.teamId, requestRef,
      '--view', 'evidence', '--socket', f.config.socketPath, '--json'], {
      stdin: Readable.from([]),
      stdout: new Writable({ write(chunk, _encoding, done) { inspected += chunk; done(); } }),
      stderr: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    });
    assert.equal(inspectCode, 0, inspected);
    const idle = JSON.parse(inspected);
    assert.equal(idle.request.submissionVerification.nextAction, 'reconcile_failure');
    assert.equal(idle.request.submissionVerification.recovery.requiresFreshValidation, true);
    assert.equal(idle.request.evidence.submissionVerification.responseCandidate.responseMessageId, 'interrupted');
    assert.equal(idle.request.evidence.submissionVerification.responseCandidate.answerText, 'Started the original work; results are still pending.');
    assert.equal(idle.request.terminal, false);
    assert.equal(idle.request.answerText, null);
    assert.equal(f.fake.submitCount, 1, 'Passive inspection never continues or terminalizes the request');
    await f.fake.page.locator('textarea').fill('Preserved user draft');
    await assert.rejects(f.rpc('decide', input), /Preserve the current draft/);
    assert.equal(await f.fake.page.locator('textarea').inputValue(), 'Preserved user draft');
    await assert.rejects(f.rpc('decide', { ...input, continuationPrompt: '계속' }), /Preserve the current draft/);
    await f.fake.page.locator('textarea').fill('계속');
    await assert.rejects(f.rpc('decide', input), /Preserve the current draft/);
    input.continuationPrompt = '계속' as const;
    // Automatic recovery cannot classify this as a Thinking failure.
    await assert.rejects(f.core.thinkingFailureRecovery.services.ui.reconcileFailure({ clientId: `team:${f.team.teamId}`, requestId: 'original', sessionId: original.sessionId,
      generation: original.generation, decisionId: 'automatic-timeout' }));
    let stdout = '', stderr = '';
    const code = await runCli(['request', 'reconcile_failure', f.team.teamId, requestRef,
      '--continuation-prompt', '계속', '--request-id', input.requestId, '--socket', f.config.socketPath, '--json'], {
      stdin: Readable.from([]),
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += chunk; done(); } }),
      stderr: new Writable({ write(chunk, _encoding, done) { stderr += chunk; done(); } }),
    });
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.reconciliation.evidence.kind, 'message-timeout');
    assert.equal(result.reconciliation.evidence.continuationPrompt, '계속');
    assert.equal(result.reconciliation.evidence.interruptedResponse.responseMessageId, 'interrupted');
    assert.equal(result.reconciliation.evidence.interruptedResponse.answerText, 'Started the original work; results are still pending.');
    assert.equal(await f.fake.page.locator('textarea').inputValue(), '계속');
    const failed = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(failed.reason, 'message-timeout-reconciled');
    assert.equal(failed.submittedUserMessageId, original.submittedUserMessageId);
    assert.equal(failed.promptSubmitted, true);
    assert.equal(failed.answerText, null);
    await f.rpc('decide', input);
    assert.equal(f.fake.submitCount, 1, 'Reconciliation and receipt replay never submit');
    await assert.rejects(f.rpc('decide', { ...input, continuationPrompt: undefined }), /different|conflict|reused/);
    f.fake.failureCount = 1;
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="final" data-end-turn="true">Normal final</div>';
    await assert.rejects(f.core.submissionService.send({ clientId: `team:${f.team.teamId}`, sessionId: failed.sessionId, expectedGeneration: 1, requestId: 'owner-continuation', prompt: '계속', model: '5.5 Pro', effort: 'Extra High', sessionDeadlineSec: 60 }), error => { assert.match(String(error), /composer|preparation|decision/i); return true; });
    const child = f.core.teamDirectory.getSession(f.session.sessionId);
    assert.equal(child.generation, 2);
    assert.equal(child.submissionState, 'prepared');
    assert.equal(f.fake.submitCount, 1);
    const childRef = f.core.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=? AND generation=2').get(child.sessionId)!.outbox_id;
    for (const purpose of ['model', 'composer', 'submit']) {
      const observed = await f.rpc<any>('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef: childRef });
      const evidence = observed.request.evidence;
      const node = evidence.nodes.find((n: BrowserSnapshot['nodes'][number]) => purpose === 'model' ? n.id === 'configuration' :
        purpose === 'composer' ? n.role === 'textbox' : n.submitControl === true)!;
      await f.rpc('decide', { teamId: f.team.teamId, requestRef: childRef, requestId: 'continuation-' + purpose,
        decision: 'choose', purpose, snapshotId: evidence.snapshotId, ref: node.ref });
    }
    await until(() => f.core.teamDirectory.getSession(child.sessionId).sessionState === 'complete');
    assert.equal(f.fake.submitCount, 2);
    assert.equal(f.fake.submissionRequests.at(-1)!.prompt, '계속');
    const originalRow = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(child.sessionId)!;
    assert.equal(originalRow.submitted_user_message_id, original.submittedUserMessageId);
    assert.equal(originalRow.answer_text, null);
    assert.equal(f.core.teamDirectory.getSession(child.sessionId).answerText, 'Normal final');
  } finally { await f.close(); }
});


test('managed wait recovers an idle conversation timeout with missing ACK and stale failure state exactly once', async () => {
  const f = await fixture();
  try {
    f.fake.missingTimeoutAnchor = true;
    f.fake.surface = () => '<aside role="alert">메시지 전송 시간이 초과되었습니다. 다시 시도하세요. 다시 시도</aside>';
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    new EventRepository(f.core.database.raw).append({ teamId: f.team.teamId, sessionId: original.sessionId,
      generation: original.generation, eventType: 'generation.backend-unverified', createdAt: new Date().toISOString(),
      payload: { recoveryReason: 'backend-user-anchor-absent-from-mapping', recoveryIdentity: {
        conversationId: original.conversationId, pageKey: original.pageKey,
        submittedUserMessageId: original.submittedUserMessageId, submittedUserTurnId: original.submittedUserTurnId } } });
    const inspect = await f.rpc<any>('team_get', { view: 'evidence', teamId: f.team.teamId, requestRef });
    assert.equal(inspect.request.errorCode, null, 'Stored observation has not classified this real UI failure');
    assert.equal(inspect.request.submissionVerification.dom.anchorPresent, false);
    assert.equal(inspect.request.submissionVerification.nextAction, 'reconcile_failure');
    const reconcile = { teamId: f.team.teamId, requestRef, decision: 'reconcile_failure', requestId: 'guard-check' };
    await f.fake.page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<button aria-label="Stop">Stop</button>'));
    await assert.rejects(f.rpc('decide', reconcile), /active generation/);
    await f.fake.page.locator('button[aria-label="Stop"]').evaluate(node => node.remove());
    await f.fake.page.locator('textarea').fill('Separate draft');
    await assert.rejects(f.rpc('decide', reconcile), /draft/);
    await f.fake.page.locator('textarea').fill('');
    await f.fake.page.locator('main').evaluate(node => node.insertAdjacentHTML('afterbegin', '<div data-message-author-role="user" data-message-id="unclaimed">Another user turn</div>'));
    await assert.rejects(f.rpc('decide', reconcile), /No exact idle/);
    await f.fake.page.locator('[data-message-id="unclaimed"]').evaluate(node => node.remove());
    f.fake.failureCount = 1;
    f.fake.surface = users => users + '<div data-message-author-role="assistant" data-message-id="continued-answer">Continued answer</div>';
    const input = { teamId: f.team.teamId, requestRefs: [requestRef], waitMs: 60000, continuationApproved: true };
    const result = await f.rpc<any>('wait', input);
    assert.equal(f.fake.submitCount, 2);
    assert.equal(f.core.teamDirectory.getSession(original.sessionId).generation, 2);
    const stored = f.core.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(original.sessionId)!;
    assert.equal(stored.reason, 'message-timeout-reconciled');
    assert.equal(stored.submitted_user_message_id, original.submittedUserMessageId);
    assert.equal(stored.error_code, 'provider.execution-failed');
    assert.equal(result.results[0].generation, 2);
    await f.rpc('wait', { ...input, waitMs: 0 });
    assert.equal(f.fake.submitCount, 2);
  } finally { await f.close(); }
});


test('managed timeout recovery returns changed transcript evidence for agent judgment without a resend', async () => {
  const f = await fixture();
  try {
    f.fake.surface = () => '<div data-message-author-role="user" data-message-id="unclaimed">A manual turn</div><aside role="alert">Message timed out. Please try again.</aside>';
    const requestRef = await f.submit(false);
    const result = await f.rpc<any>('wait', { teamId: f.team.teamId, requestRefs: [requestRef],
      waitMs: 60000, continuationApproved: true });
    assert.equal(result.results[0].recovery.decisionRequired, true);
    assert.equal(result.results[0].recovery.userActionRequired, true);
    assert.equal(f.fake.submitCount, 1);
    assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).terminal, false);
  } finally { await f.close(); }
});

test('approved managed wait preserves actively generating or separately drafted original turns', async () => {
  const f = await fixture();
  try {
    f.fake.surface = users => users;
    const requestRef = await f.submit(false);
    const original = f.core.teamDirectory.getSession(f.session.sessionId);
    const body = '<main>' + configuration + '<div data-message-author-role="user" data-message-id="user-message-1">Original</div>';
    for (const surface of [
      '<div role="alert">메시지 전송 시간이 초과되었습니다. 다시 시도하세요.</div><textarea></textarea><button data-testid="stop-button">Stop</button>',
      '<div role="alert">메시지 전송 시간이 초과되었습니다. 다시 시도하세요.</div><textarea>Distinct draft</textarea>'
    ]) {
      await f.fake.page.setContent(body + surface + '</main>');
      await f.rpc('wait', { teamId: f.team.teamId, requestRefs: [requestRef], waitMs: 60000, continuationApproved: true });
      assert.equal(f.fake.submitCount, 1);
      assert.equal(f.core.teamDirectory.getSession(original.sessionId).generation, 1);
    }
  } finally { await f.close(); }
});


test('approved managed timeout after an earlier broad review still recovers the aged request', async () => {
  const f = await fixture();
  try {
    const timeout = '<aside role="alert">메시지 전송 시간이 초과되었습니다. 다시 시도하세요.</aside>';
    f.fake.surface = users => users + timeout;
    const requestRef = await f.submit(false);
    const old = new Date(Date.now() - 40 * 60_000).toISOString();
    f.core.database.raw.prepare('UPDATE outbox SET created_at=?,updated_at=? WHERE outbox_id=?').run(old, old, requestRef);
    const input = { teamId: f.team.teamId, requestRefs: [requestRef], waitMs: 60000, continuationApproved: true };
    await f.fake.page.locator('main').evaluate(node => node.insertAdjacentHTML('beforeend', '<button data-testid="stop-button">Stop</button>'));
    await f.rpc('wait', input);
    assert.equal(f.fake.submitCount, 1, 'A broad review must preserve active generation');
    await f.fake.page.locator('[data-testid="stop-button"]').evaluate(node => node.remove());
    f.fake.failureCount = 2;
    f.fake.surface = users => users + timeout;
    const result = await f.rpc<any>('wait', input);
    assert.equal(f.fake.submitCount, 2, 'A prior review cannot send an already-approved idle timeout back to the Coordinator');
    assert.equal(result.results[0].generation, 2);
    assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).generation, 2, 'Carried successor timeout cannot trigger another immediate Continue');
  } finally { await f.close(); }
});
