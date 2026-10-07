import assert from 'node:assert/strict';
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
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

const callRpc = (socketPath: string, method: string, params: unknown) => rpcCall({ socketPath, method, params });

test('approved resend reserves once across restart, preserves uncertainty, and stops a late answer before dispatch', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-approved-resend-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  let lateAnswer = false;
  t.mock.method(SessionUiService.prototype, 'reserveResendPage', () => {});
  t.mock.method(SessionUiService.prototype, 'verifyAuthorizedResend', async (_current, _original, _prompt, afterPrepare) => {
    if (lateAnswer && afterPrepare) throw new SessionPlaneDomainError('provider.preparation-required', 'Original answer appeared; do not dispatch', { responseMessageId: 'original-late-final' });
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
    await assert.rejects(callRpc(config.socketPath, 'workflow.decide', approval), /cooldown/);
    budgets.save({ scope: `chatgpt:conversation-detail:${source.conversationId}`, nextAllowedAt: new Date(0).toISOString(),
      blockedUntil: null, backoffLevel: 0, consecutiveFailures: 0, updatedAt: new Date().toISOString() });
    const reservation = await callRpc(config.socketPath, 'workflow.decide', approval) as { requestRef: string; generation: number };
    assert.equal(reservation.generation, 2);
    assert.equal(fake.submitCount, 1, 'Preparing approval never sends');
    assert.deepEqual(generationRow(), preserved);
    assert.deepEqual(service.database.raw.prepare('SELECT * FROM outbox WHERE outbox_id=?').get(original.outbox_id), original);
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
    new EventRepository(service.database.raw).append({ teamId: team.teamId, roleId: secondSource.roleId,
      sessionId: second.sessionId, generation: 1, eventType: 'generation.backend-unverified',
      payload: { recoveryReason: 'backend-user-anchor-absent-from-mapping', recoveryIdentity: {
        conversationId: secondSource.conversationId, submittedUserMessageId: secondSource.submittedUserMessageId,
        submittedUserTurnId: secondSource.submittedUserTurnId } }, createdAt: new Date().toISOString() });
    await callRpc(config.socketPath, 'workflow.decide', { ...approval, requestRef: secondOutbox.outbox_id, requestId: 'second-approved-once' });
    const secondOwner = { clientId, requestId: 'second-approved-once', sessionId: second.sessionId, generation: 2 };
    const submitted = await service.submissionService.resumePreparation(secondOwner);
    assert.equal(submitted.generation, 2);
    assert.equal(submitted.conversationId, secondSource.conversationId);
    assert.notEqual(submitted.submittedUserMessageId, secondSource.submittedUserMessageId);
    assert.equal(fake.submitCount, 3, 'Two source submits plus exactly one successor dispatch');
    assert.deepEqual(await service.submissionService.resumePreparation(secondOwner), submitted);
    assert.equal(fake.submitCount, 3);

  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});
