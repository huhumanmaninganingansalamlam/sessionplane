import assert from 'node:assert/strict';
import { RecoveryService } from '../../src/core/recovery-service.ts';
import type { BrowserOwner } from '../../src/browser/browser-owner.ts';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { SessionRepository } from '../../src/storage/session-repository.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../../src/config.ts';
import { startCore } from '../../src/main.ts';
import { SessionUiService } from '../../src/core/session-ui-service.ts';
import { SessionPlaneDomainError } from '../../src/domain/errors.ts';
import { EventRepository } from '../../src/storage/event-repository.ts';
import { ProbeBudgetRepository } from '../../src/storage/probe-budget-repository.ts';
import { callRpc as rpcCall } from '../../src/cli/client.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

const callRpc = (socketPath: string, method: string, params: unknown) => rpcCall({ socketPath, method, params });

test('approved resend reserves once across restart, preserves uncertainty, and stops a late answer before dispatch', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-approved-resend-'));
  const config = resolveConfig({ cwd: root, env: { SESSIONPLANE_PROBE_SUCCESS_INTERVAL_MS: '1' }, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  let canonicalReads = 0;
  t.mock.method(fake, 'recover', async () => { canonicalReads += 1; return { kind: 'unverified', observationTransport: 'fresh',
    responseMessageId: null, answerText: null, reason: 'backend-user-anchor-absent-from-mapping', retryAfterMs: null, nextCheckAt: null }; });
  let lateAnswer = false;
  let transientPreSubmitFailure = false;
  t.mock.method(SessionUiService.prototype, 'reserveResendPage', () => {});
  t.mock.method(SessionUiService.prototype, 'verifyAuthorizedResend', async (_current, _original, _prompt, afterPrepare) => {
    if (lateAnswer && afterPrepare) throw new SessionPlaneDomainError('provider.preparation-required', 'Original answer appeared; do not dispatch', { responseMessageId: 'original-late-final' });
    if (transientPreSubmitFailure && afterPrepare) throw new SessionPlaneDomainError('browser.unavailable', 'Provider browser operation timed out');
  });
  let service = await startCore({ config, startBrowser: false, providerAdapters: [fake] });
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'fixture-owner' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: team.primaryRoleKey, provider: 'chatgpt' });
    const clientId = `team:${team.teamId}`;
    const source = await service.submissionService.send({ clientId, requestId: 'original', sessionId: session.sessionId,
      prompt: 'The exact original compiler follow-up', sessionDeadlineSec: 600 });
    const original = service.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? AND generation=1').get(session.sessionId)! as { outbox_id: string };
    // Isolated provider fixture supplies the evidence normally written by the paced observer.
    new EventRepository(service.database.raw).append({ teamId: team.teamId, roleId: source.roleId,
      sessionId: source.sessionId, generation: source.generation, eventType: 'generation.backend-unverified',
      payload: { recoveryReason: 'backend-user-anchor-absent-from-mapping', recoveryIdentity: {
        conversationId: source.conversationId, submittedUserMessageId: source.submittedUserMessageId,
        submittedUserTurnId: source.submittedUserTurnId } }, createdAt: new Date().toISOString() });
    const generationRow = () => service.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=1').get(source.sessionId);
    const preserved = generationRow();
    await assert.rejects(service.submissionService.send({ clientId, requestId: 'ordinary-busy', sessionId: source.sessionId,
      prompt: 'The exact original compiler follow-up', sessionDeadlineSec: 600 }), /active generation/);
    const approval = { teamId: team.teamId, requestRef: original.outbox_id, requestId: 'approved-once',
      decision: 'prepare_resend', approvalRef: 'user-explicit-duplicate-risk-approval', duplicateRiskAccepted: true };
    await assert.rejects(callRpc(config.socketPath, 'workflow.decide', { ...approval, duplicateRiskAccepted: false }));
    const budgets = new ProbeBudgetRepository(service.database.raw);
    budgets.save({ scope: `chatgpt:conversation-detail:${source.conversationId}`, nextAllowedAt: new Date(Date.now() + 120_000).toISOString(),
      blockedUntil: new Date(Date.now() + 120_000).toISOString(), backoffLevel: 1, consecutiveFailures: 0, updatedAt: new Date().toISOString() });
    assert.equal(service.submissionService.accountCooldown(source), null,
      'A recovery GET backoff is not an account-wide preparation restriction');
    const reservation = await callRpc(config.socketPath, 'workflow.decide', approval) as { requestRef: string; generation: number };
    assert.equal(reservation.generation, 2);
    assert.equal(canonicalReads, 0, 'Local reservation reuses exact stored proof without competing with the original observer');
    assert.equal(fake.submitCount, 1, 'Preparing approval never sends');
    assert.deepEqual(generationRow(), preserved);
    assert.deepEqual(service.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(original.outbox_id), original);
    const preparedOwner = { clientId, requestId: 'approved-once', sessionId: source.sessionId, generation: 2 };
    budgets.save({ scope: `chatgpt:conversation-detail:${source.conversationId}`, nextAllowedAt: new Date(Date.now() + 120_000).toISOString(),
      blockedUntil: new Date(Date.now() + 120_000).toISOString(), backoffLevel: 1, consecutiveFailures: 1, updatedAt: new Date().toISOString() });
    assert.deepEqual(await service.submissionService.withPendingPreparation(preparedOwner, async () => ({ inspected: true })), { inspected: true });
    assert.deepEqual(await service.submissionService.decidePreparation({ ...preparedOwner, decisionId: 'settings-during-read-backoff',
      decision: 'discover', purpose: 'model' }, async () => ({ choice: null, result: { discovered: true } })), { discovered: true });
    await service.close();
    service = await startCore({ config, startBrowser: false, providerAdapters: [fake] });
    assert.deepEqual(await callRpc(config.socketPath, 'workflow.decide', approval), reservation);
    await assert.rejects(callRpc(config.socketPath, 'workflow.decide', { ...approval, requestId: 'second-approval' }), /one authorized resend/);
    lateAnswer = true;
    const successorOwner = { clientId, requestId: 'approved-once', sessionId: source.sessionId, generation: 2 };
    await service.submissionService.withPendingPreparation(successorOwner, async () => ({ inspected: true }));
    await assert.rejects(service.submissionService.resumePreparation(successorOwner), /Original answer appeared/);
    assert.equal(fake.submitCount, 1);
    assert.equal(service.teamDirectory.getSession(source.sessionId).submissionState, 'prepared');
    lateAnswer = false;
    await assert.rejects(service.submissionService.resumePreparation(successorOwner), /was stopped/);
    assert.equal(fake.submitCount, 1, 'Unmounting a discovered answer cannot re-enable dispatch');
    assert.deepEqual(generationRow(), preserved);

    service.teamDirectory.createRole({ teamId: team.teamId, roleKey: 'second', roleType: 'custom' });
    const second = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: 'second', provider: 'chatgpt' });
    const secondSource = await service.submissionService.send({ clientId, requestId: 'second-original', sessionId: second.sessionId,
      prompt: 'Second exact follow-up', sessionDeadlineSec: 600 });
    const secondOutbox = service.database.raw.prepare('SELECT outbox_id FROM outbox WHERE session_id=? AND generation=1').get(second.sessionId)! as { outbox_id: string };
    // GET 429 says nothing about acceptance of the original submission. The user
    // accepts that uncertainty; no absent-mapping proof or new GET is required.
    const readDeadline = new Date(Date.now() + 120_000).toISOString();
    const currentBudgets = new ProbeBudgetRepository(service.database.raw);
    currentBudgets.save({ scope: `chatgpt:conversation-detail:${secondSource.conversationId}`, nextAllowedAt: readDeadline,
      blockedUntil: readDeadline, backoffLevel: 1, consecutiveFailures: 1, updatedAt: new Date().toISOString() });
    const secondApproval = { ...approval, requestRef: secondOutbox.outbox_id, requestId: 'second-approved-once' };
    const secondReservation = await callRpc(config.socketPath, 'workflow.decide', secondApproval);
    const secondOwner = { clientId, requestId: 'second-approved-once', sessionId: second.sessionId, generation: 2 };
    currentBudgets.save({ scope: 'chatgpt:default', nextAllowedAt: readDeadline, blockedUntil: readDeadline,
      backoffLevel: 0, consecutiveFailures: 0, updatedAt: new Date().toISOString() });
    await assert.rejects(service.submissionService.resumePreparation(secondOwner), /account cooldown/);
    assert.equal(fake.submitCount, 2, 'An explicit broad service hold still prevents submission');
    currentBudgets.save({ scope: 'chatgpt:default', nextAllowedAt: null, blockedUntil: null,
      backoffLevel: 0, consecutiveFailures: 0, updatedAt: new Date().toISOString() });
    transientPreSubmitFailure = true;
    await assert.rejects(service.submissionService.resumePreparation(secondOwner), /browser operation timed out/);
    assert.equal(service.teamDirectory.getSession(second.sessionId).submissionState, 'failed_pre_submit');
    assert.equal(fake.submitCount, 2, 'A pre-submit timeout did not dispatch or consume the one-shot send');
    await assert.rejects(callRpc(config.socketPath, 'workflow.decide', { ...secondApproval, approvalRef: 'different-approval' }), /one authorized resend/);
    assert.deepEqual(await callRpc(config.socketPath, 'workflow.decide', secondApproval), secondReservation);
    assert.equal(service.teamDirectory.getSession(second.sessionId).generation, 2, 'Reopening retains the same successor');
    await service.submissionService.withPendingPreparation(secondOwner, async () => ({ inspected: true }));
    transientPreSubmitFailure = false;
    const submitted = await service.submissionService.resumePreparation(secondOwner);
    assert.equal(submitted.generation, 2);
    assert.equal(submitted.conversationId, secondSource.conversationId);
    assert.notEqual(submitted.submittedUserMessageId, secondSource.submittedUserMessageId);
    assert.equal(fake.submitCount, 3, 'Two source submits plus exactly one successor dispatch');
    assert.equal(canonicalReads, 0, 'Approved UI dispatch neither calls nor bypasses the restricted GET');
    assert.equal(currentBudgets.get(`chatgpt:conversation-detail:${secondSource.conversationId}`)?.blockedUntil, readDeadline);
    assert.deepEqual(await service.submissionService.resumePreparation(secondOwner), submitted);
    assert.deepEqual(await callRpc(config.socketPath, 'workflow.decide', secondApproval), secondReservation);
    assert.equal(fake.submitCount, 3);

  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});


test('failed approved preparation reattaches the persisted target after restart without reopening or dispatching', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-failed-preparation-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const start = () => startCore({ config, startBrowser: false, providerAdapters: [fake] });
  let service = await start();
  t.mock.method(SessionUiService.prototype, 'reserveResendPage', (original, successor) => {
    service.pageRegistry.reservePage(original.pageKey!, { sessionId: successor.sessionId,
      generation: successor.generation, conversationId: successor.conversationId });
  });
  let fail = false;
  t.mock.method(SessionUiService.prototype, 'verifyAuthorizedResend', async (current, _original, _prompt, afterPrepare) => {
    try { service.pageRegistry.requireSessionPage(current.pageKey!, { sessionId: current.sessionId,
      generation: current.generation, conversationId: current.conversationId }); }
    catch (error) { throw new SessionPlaneDomainError((error as { errorCode: string }).errorCode, (error as Error).message); }
    if (fail && afterPrepare) throw new SessionPlaneDomainError('browser.unavailable', 'Fixture pre-submit timeout');
  });
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'failed-owner' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: team.primaryRoleKey, provider: 'chatgpt' });
    const conversationId = `conversation-${session.sessionId}`;
    const page = Object.assign(new EventEmitter(), { url: () => `https://chatgpt.com/c/${conversationId}`,
      isClosed: () => false }) as unknown as Page;
    const binding = service.pageRegistry.identifyPage(page, 'exact-retained-target');
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => ({ ...await open(request), pageKey: binding.pageKey,
      bindAcknowledgement() { service.pageRegistry.bindPage(binding.pageKey,
        { sessionId: session.sessionId, generation: 1, conversationId }); } }));
    const clientId = `team:${team.teamId}`;
    await service.submissionService.send({ clientId, requestId: 'original', sessionId: session.sessionId,
      prompt: 'Exact retained draft', sessionDeadlineSec: 600 });
    const original = service.database.raw.prepare('SELECT * FROM outbox WHERE session_id=? AND generation=1').get(session.sessionId)!;
    const approval = { teamId: team.teamId, requestRef: original.outbox_id, requestId: 'approved-once',
      decision: 'prepare_resend', approvalRef: 'one-user-approval', duplicateRiskAccepted: true };
    const rpc = () => callRpc(config.socketPath, 'workflow.decide', approval);
    const reserved = await rpc() as { requestRef: string };
    await service.submissionService.withPendingPreparation({ clientId, requestId: 'approved-once', sessionId: session.sessionId,
      generation: 2 }, async () => ({}));
    fail = true;
    await assert.rejects(service.submissionService.resumePreparation({ clientId, requestId: 'approved-once',
      sessionId: session.sessionId, generation: 2 }), /Fixture pre-submit timeout/);
    const failed = service.teamDirectory.getSession(session.sessionId);
    const outbox = service.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(reserved.requestRef);
    const generation = service.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=2').get(session.sessionId);
    await service.close();
    service = await start();
    const adopted = service.pageRegistry.identifyPage(page, binding.targetId!);
    assert.notEqual(adopted.pageKey, failed.pageKey);
    assert.ok(new SessionRepository(service.database.raw).listRecoverableSnapshots().some(s => s.sessionId === session.sessionId));
    await assert.rejects(rpc(), /Unknown pageKey/, 'Reproduces the actual native failure before reconciliation');
    service.pageRegistry.bindPage(adopted.pageKey, { sessionId: 'foreign-owner', generation: 1, conversationId });
    await assert.rejects(service.recoveryService.ensurePage(session.sessionId, 2, { openMissing: false }), /could not be recovered/);
    service.pageRegistry.unbindPage(adopted.pageKey);
    const recovery = new RecoveryService({ database: service.database,
      browserOwner: { createPage: () => { throw new Error('Must not open a replacement page'); } } as unknown as BrowserOwner,
      pageRegistry: service.pageRegistry, scheduler: service.actorScheduler, observations: service.observationService,
      adapters: service.providerAdapters, submissions: service.submissionService,
      chatgptUrl: config.chatgptUrl, geminiUrl: config.geminiUrl, grokUrl: config.grokUrl });
    const report = await recovery.restore();
    assert.equal(report.rebound, 1);
    assert.equal(report.opened, 0);
    assert.equal(report.observersStarted, 0);
    await recovery.close();
    const restored = service.teamDirectory.getSession(session.sessionId);
    assert.equal(restored.pageKey, adopted.pageKey);
    assert.equal(restored.submissionState, 'failed_pre_submit');
    assert.equal(restored.reason, failed.reason);
    assert.deepEqual(service.database.raw.prepare('SELECT * FROM generations WHERE session_id=? AND generation=2').get(session.sessionId), generation);
    assert.deepEqual(service.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(reserved.requestRef), outbox);
    assert.deepEqual(await rpc(), reserved);
    assert.equal(service.teamDirectory.getSession(session.sessionId).submissionState, 'prepared');
    assert.equal(fake.submitCount, 1, 'Rebind/reprepare never dispatches or creates a generation');
    assert.equal(service.teamDirectory.getSession(session.sessionId).generation, 2);
    assert.deepEqual(service.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(original.outbox_id), original);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});


test('failed preparation with no conversation cannot steal the same session target from another generation', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-failed-generation-conflict-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.prepareError = new ProviderSubmissionError('browser.unavailable', 'Fixture pre-submit failure');
  const start = () => startCore({ config, startBrowser: false, providerAdapters: [fake] });
  let service = await start();
  const page = Object.assign(new EventEmitter(), { url: () => 'https://chatgpt.com/', isClosed: () => false }) as unknown as Page;
  try {
    const team = service.teamDirectory.createTeam({ clientId: 'generation-owner' });
    const session = service.teamDirectory.createSession({ teamId: team.teamId, roleKey: team.primaryRoleKey, provider: 'chatgpt' });
    const stored = service.pageRegistry.identifyPage(page, 'retained-new-conversation-target');
    service.pageRegistry.reservePage(stored.pageKey, { sessionId: session.sessionId, generation: 1 });
    const open = fake.openSubmission.bind(fake);
    t.mock.method(fake, 'openSubmission', async request => ({ ...await open(request), pageKey: stored.pageKey }));
    await assert.rejects(service.submissionService.send({ clientId: 'generation-owner', requestId: 'failed-original',
      sessionId: session.sessionId, prompt: 'Retained unsubmitted draft', sessionDeadlineSec: 600 }), /Fixture pre-submit failure/);
    const before = service.teamDirectory.getSession(session.sessionId);
    assert.equal(before.submissionState, 'failed_pre_submit');
    assert.equal(before.conversationId, null);
    const outbox = service.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(session.sessionId);
    await service.close();
    service = await start();
    const live = service.pageRegistry.identifyPage(page, stored.targetId!);
    service.pageRegistry.reservePage(live.pageKey, { sessionId: session.sessionId, generation: 2 });
    await assert.rejects(service.recoveryService.ensurePage(session.sessionId, 1, { openMissing: false }), /could not be recovered/);
    assert.equal(service.pageRegistry.getBinding(live.pageKey).generation, 2);
    assert.equal(service.teamDirectory.getSession(session.sessionId).pageKey, before.pageKey);
    assert.deepEqual(service.database.raw.prepare('SELECT * FROM outbox WHERE session_id=?').get(session.sessionId), outbox);
    service.pageRegistry.unbindPage(live.pageKey);
    await service.recoveryService.ensurePage(session.sessionId, 1, { openMissing: false });
    assert.equal(service.teamDirectory.getSession(session.sessionId).pageKey, live.pageKey);
    assert.equal(service.pageRegistry.getBinding(live.pageKey).generation, 1);
    assert.equal(service.teamDirectory.getSession(session.sessionId).submissionState, 'failed_pre_submit');
    assert.equal(fake.submitCount, 0);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
