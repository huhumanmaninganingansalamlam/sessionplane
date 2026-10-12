import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { resolveConfig } from '../../src/config.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { workflowSchemas } from '../../src/rpc/methods/workflow.ts';
import { ThinkingFailureRecovery } from '../../src/core/thinking-failure-recovery.ts';
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
        this.afterPrepare?.(request);
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
      ...(request.generation <= this.failureCount ? { observationTransport: 'unavailable' as const, errorCode: 'provider.actionable-alert',
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
      const observed = await rpc<{ request: { evidence: BrowserSnapshot } }>('team_get', { teamId: team.teamId, requestRef });
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
    const get = await f.rpc<{ request: { thinkingFailureRecovery: { successorRequestRef: string; enabled: boolean; state: string; sender: string } } }>('team_get', { teamId: f.team.teamId, requestRef: rootRef });
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
      const paused = await f.rpc<{ request: { thinkingFailureRecovery: { enabled: boolean; state: string } } }>('team_get', {
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

test('confirmed manual follow-up releases only original tracking and permits new work without borrowing its answer', async () => {
  const f = await fixture();
  const { createHash } = await import('node:crypto');
  const answer = 'Review complete: CHANGES_REQUIRED';
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
      '<div data-message-author-role="assistant" data-message-id="original-answer" data-end-turn="true">Original recovered</div>' + followup + final]) {
      await f.fake.page.setContent(body(unsafe));
      await assert.rejects(f.rpc('decide', input), /not verified/);
      assert.equal(f.core.teamDirectory.getSession(f.session.sessionId).terminal, false);
    }
    await f.fake.page.setContent(body(followup + final));
    const released = await f.rpc<any>('decide', input);
    assert.equal(released.reconciliation.disposition, 'tracking-cancelled');
    assert.equal(released.reconciliation.providerMutation, false);
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
