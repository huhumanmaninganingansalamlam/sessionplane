import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';
import { EventRepository } from '../../src/storage/event-repository.ts';
import { ProbeBudgetRepository } from '../../src/storage/probe-budget-repository.ts';
import { recoverExactServerAcknowledgement } from '../../src/providers/chatgpt/backend-recovery.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface SessionSnapshot {
  readonly sessionId: string;
  readonly generation: number;
  readonly submissionState: string | null;
  readonly sessionState: string;
  readonly terminal: boolean;
  readonly waitExpired: boolean;
  readonly providerState: string;
  readonly conversationId: string | null;
  readonly submittedUserMessageId: string | null;
  readonly submittedUserTurnId: string | null;
  readonly promptSubmitted: boolean;
  readonly errorCode: string | null;
}

test('restart retains request-bound dispatch proof and recovers late duplicate ACK without another submit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-durable-dispatch-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  fake.autoFinalText = 'Old answer';
  let service = await startCore({ config, startBrowser: false, providerAdapters: [fake], logger: silentLogger() });
  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'client-send', requestId: 'proof-team', name: 'Late ACK', primaryRoleKey: 'main' });
    const session = await createSession(config.socketPath, team.teamId, 'main', 'proof-session');
    const input = { clientId: 'client-send', sessionId: session.sessionId, prompt: 'Question', sessionDeadlineSec: 600 };
    const old = await rpc<SessionSnapshot>(config.socketPath, 'session.send', { ...input, requestId: 'old-question' });
    const oldFinal = await rpc<SessionSnapshot>(config.socketPath, 'session.wait', {
      clientId: input.clientId, sessionId: session.sessionId, generation: 1, waitMs: 1000 });
    assert.equal(oldFinal.terminal, true);
    fake.autoFinalText = null;
    fake.acknowledgementMode = 'missing';
    const attempt = { conversationId: old.conversationId!, messageId: 'user-message-2', parentMessageId: 'chatgpt-auto-final-1',
      textHash: createHash('sha256').update(input.prompt).digest('hex'), observedAt: '2026-10-07T18:37:54.258Z' };
    const open = fake.openSubmission.bind(fake);
    fake.openSubmission = async request => {
      const submission = await open(request), submit = submission.submitOnce.bind(submission);
      submission.submitOnce = async () => { await submit(); request.onSubmissionAttempt?.(attempt); };
      return submission;
    };
    await assert.rejects(rpc(config.socketPath, 'session.send', { ...input, requestId: 'new-question' }),
      hasRpcError('session.submission-unknown', true));
    assert.equal(fake.submitCount, 2);
    assert.equal(service.teamDirectory.getSession(session.sessionId).submittedUserMessageId, null);
    const preserved = service.database.raw.prepare('SELECT payload_json FROM outbox WHERE session_id=? ORDER BY generation')
      .all(session.sessionId);
    const events = new EventRepository(service.database.raw);
    const proof = events.submissionAttempts(session.sessionId, 2)[0]!;
    // Same prompt/conversation do not transfer proof across a request or generation.
    for (const generation of [1, 2]) events.append({ teamId: team.teamId, sessionId: session.sessionId,
      generation, eventType: 'generation.submission-attempt-evidence', createdAt: attempt.observedAt,
      payload: { ...proof, ...(generation === 2 ? { requestRef: 'foreign-request' } : {}),
        attempt: { ...attempt, messageId: `foreign-user-${generation}` } } });
    await service.close();
    const restarted = new FakeProviderAdapter();
    restarted.autoFinalText = 'Exact new answer';
    restarted.recoverAcknowledgement = async request => {
      assert.deepEqual(request.attempts, [attempt]);
      return recoverExactServerAcknowledgement({ id: old.conversationId, current_node: 'new-final', mapping: {
        'old-user': { parent: null, message: { id: 'user-message-1', author: { role: 'user' }, content: { parts: ['Question'] } } },
        'old-final': { parent: 'old-user', message: { id: 'chatgpt-auto-final-1', author: { role: 'assistant' }, content: { parts: ['Old answer'] } } },
        'new-user': { parent: 'old-final', message: { id: 'user-message-2', author: { role: 'user' }, content: { parts: ['Question'] } } },
        'new-final': { parent: 'new-user', message: { id: 'chatgpt-auto-final-2', author: { role: 'assistant' },
          status: 'finished_successfully', end_turn: true, content: { parts: ['Exact new answer'] } } },
      } }, old.conversationId!, request.prompt, request.attempts);
    };
    service = await startCore({ config, startBrowser: false, providerAdapters: [restarted], logger: silentLogger() });
    const recovered = await service.submissionService.recoverAcknowledgement(service.teamDirectory.getSession(session.sessionId));
    assert.equal(recovered.generation, 2);
    assert.equal(recovered.submittedUserMessageId, 'user-message-2');
    assert.equal(recovered.submissionState, 'submitted');
    const final = await rpc<SessionSnapshot & { responseMessageId: string; answerText: string }>(config.socketPath, 'session.wait', {
      clientId: input.clientId, sessionId: session.sessionId, generation: 2, waitMs: 1000 });
    assert.equal(final.terminal, true);
    assert.equal(final.responseMessageId, 'chatgpt-auto-final-2');
    assert.equal(final.answerText, 'Exact new answer');
    assert.equal(restarted.submitCount, 0);
    assert.deepEqual(service.database.raw.prepare('SELECT payload_json FROM outbox WHERE session_id=? ORDER BY generation')
      .all(session.sessionId), preserved);
    const oldAnchor = service.database.raw.prepare('SELECT submitted_user_message_id AS id FROM generations WHERE session_id=? AND generation=1')
      .get(session.sessionId) as { id: string };
    assert.equal(oldAnchor.id, old.submittedUserMessageId);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

test('session.send submits once, persists exact acknowledgement, and never resends ambiguity', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-send-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  let service: CoreService = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [fake],
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'client-send',
      requestId: 'create-team',
      name: 'Submission Team',
      primaryRoleKey: 'main',
    });
    const main = await createSession(config.socketPath, team.teamId, 'main', 'main-session');

    const openSubmission = fake.openSubmission.bind(fake);
    fake.openSubmission = async (request) => {
      const submission = await openSubmission(request);
      const capture = submission.captureAcknowledgement.bind(submission);
      submission.captureAcknowledgement = async () => {
        const attempt = service.database.raw.prepare('SELECT submission_state AS state, submitted_user_message_id AS anchor FROM generations WHERE session_id=? AND generation=?')
          .get(request.session.sessionId, request.generation) as { state: string; anchor: string | null };
        assert.equal(attempt.state, 'submit_attempted');
        assert.equal(attempt.anchor, null, 'a click/outgoing ID is not a confirmed anchor');
        return await capture();
      };
      return submission;
    };

    const successfulRequest = {
      clientId: 'client-send',
      requestId: 'send-success',
      teamId: team.teamId,
      roleKey: 'main',
      prompt: 'Return the exact provider acknowledgement.',
      model: 'enabled-model',
      sessionDeadlineSec: 600,
    };
    const submitted = await rpc<SessionSnapshot>(
      config.socketPath,
      'session.send',
      successfulRequest,
    );
    assert.equal(submitted.generation, 1);
    assert.equal(submitted.sessionId, main.sessionId);
    assert.equal(submitted.sessionState, 'submitted');
    assert.equal(submitted.providerState, 'generating');
    assert.equal(submitted.promptSubmitted, true);
    assert.ok(submitted.conversationId?.startsWith('conversation-'));
    assert.equal(submitted.submittedUserMessageId, 'user-message-1');
    assert.equal(submitted.submittedUserTurnId, 'user-turn-1');
    assert.equal(fake.submitCount, 1);
    assert.equal(fake.bindCount, 1);
    const ackEvent = service.database.raw.prepare("SELECT payload_json AS payload FROM events WHERE session_id=? AND event_type='generation.submitted'")
      .get(main.sessionId) as { payload: string };
    assert.deepEqual(JSON.parse(ackEvent.payload), {
      hasConversationId: true, hasSubmittedUserMessageId: true, hasSubmittedUserTurnId: true,
      acknowledgementEvidence: 'provider-adapter', conversationId: submitted.conversationId,
      submittedUserMessageId: 'user-message-1', submittedUserTurnId: 'user-turn-1',
    });


    const replayed = await rpc<SessionSnapshot>(
      config.socketPath,
      'session.send',
      successfulRequest,
    );
    assert.deepEqual(replayed, submitted);
    assert.equal(fake.submitCount, 1);

    const replacement = await createSession(
      config.socketPath,
      team.teamId,
      'main',
      'main-session-replacement',
    );
    assert.notEqual(replacement.sessionId, submitted.sessionId);
    const replayedAfterReplacement = await rpc<SessionSnapshot>(
      config.socketPath,
      'session.send',
      successfulRequest,
    );
    assert.deepEqual(replayedAfterReplacement, submitted);
    assert.equal(fake.submitCount, 1);

    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        ...successfulRequest,
        prompt: 'Different payload under the same request id.',
      }),
      hasRpcError('input.idempotency-conflict'),
    );
    assert.equal(fake.submitCount, 1);

    await createRole(config.socketPath, team.teamId, 'expert.concurrent', 'concurrent-role');
    const concurrent = await createSession(
      config.socketPath,
      team.teamId,
      'expert.concurrent',
      'concurrent-session',
    );
    const concurrentRequest = {
      clientId: 'client-send',
      requestId: 'send-concurrent',
      sessionId: concurrent.sessionId,
      prompt: 'Only one provider submit is allowed.',
      sessionDeadlineSec: 600,
    };
    const beforeConcurrent = fake.submitCount;
    const [concurrentA, concurrentB] = await Promise.all([
      rpc<SessionSnapshot>(config.socketPath, 'session.send', concurrentRequest),
      rpc<SessionSnapshot>(config.socketPath, 'session.send', concurrentRequest),
    ]);
    assert.deepEqual(concurrentA, concurrentB);
    assert.equal(fake.submitCount, beforeConcurrent + 1);

    await createRole(config.socketPath, team.teamId, 'expert.disabled', 'disabled-role');
    const disabled = await createSession(
      config.socketPath,
      team.teamId,
      'expert.disabled',
      'disabled-session',
    );
    fake.disabledModels.add('disabled-model');
    const beforeDisabled = fake.submitCount;
    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        clientId: 'client-send',
        requestId: 'send-disabled-model',
        sessionId: disabled.sessionId,
        prompt: 'This must not be submitted.',
        model: 'disabled-model',
        sessionDeadlineSec: 600,
      }),
      hasRpcError('provider.model-unavailable', false),
    );
    assert.equal(fake.submitCount, beforeDisabled);
    const disabledSnapshot = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-send',
      sessionId: disabled.sessionId,
    });
    assert.equal(disabledSnapshot.sessionState, 'ready');
    assert.equal(disabledSnapshot.submissionState, 'failed_pre_submit');
    assert.equal(disabledSnapshot.promptSubmitted, false);
    assert.equal(disabledSnapshot.errorCode, 'provider.model-unavailable');
    assert.equal(disabledSnapshot.terminal, true);
    const disabledWait = await rpc<SessionSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'client-send',
      sessionId: disabled.sessionId,
      generation: disabledSnapshot.generation,
      waitMs: 0,
    });
    assert.equal(disabledWait.waitExpired, false);
    assert.equal(disabledWait.terminal, true);
    const disabledTeamWait = await rpc<{
      readonly waitExpired: boolean;
      readonly sessions: readonly SessionSnapshot[];
    }>(config.socketPath, 'team.wait', {
      clientId: 'client-send',
      teamId: team.teamId,
      roleKeys: ['expert.disabled'],
      until: 'all_selected_terminal',
      waitMs: 0,
    });
    assert.equal(disabledTeamWait.waitExpired, false);
    assert.equal(disabledTeamWait.sessions[0]?.terminal, true);

    await createRole(config.socketPath, team.teamId, 'expert.human', 'human-role');
    const human = await createSession(
      config.socketPath,
      team.teamId,
      'expert.human',
      'human-session',
    );
    fake.prepareError = new ProviderSubmissionError(
      'provider.human-action-required',
      'Visible browser verification requires human completion before retry',
      {
        details: {
          provider: 'chatgpt',
          requiresHumanAction: true,
          retryWithNewRequestId: true,
        },
      },
    );
    const beforeHuman = fake.submitCount;
    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        clientId: 'client-send',
        requestId: 'send-human-verification',
        sessionId: human.sessionId,
        prompt: 'This must stay out of the composer.',
        sessionDeadlineSec: 600,
      }),
      (error: unknown) => {
        if (!(error instanceof RpcClientError)) return false;
        const data = error.data as Record<string, unknown>;
        const details = data.details as Record<string, unknown> | undefined;
        return (
          data.errorCode === 'provider.human-action-required' &&
          details?.promptSubmitted === false &&
          details.requiresHumanAction === true &&
          details.retryWithNewRequestId === true
        );
      },
    );
    assert.equal(fake.submitCount, beforeHuman);
    fake.prepareError = null;

    await createRole(config.socketPath, team.teamId, 'expert.composer-failure', 'composer-failure-role');
    const composerFailure = await createSession(
      config.socketPath,
      team.teamId,
      'expert.composer-failure',
      'composer-failure-session',
    );
    fake.prepareError = new ProviderSubmissionError(
      'provider.composer-unavailable',
      'The exact composer could not retain the requested prompt.',
      { details: { preparationDecision: false } },
    );
    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        clientId: 'client-send',
        requestId: 'send-composer-failure',
        sessionId: composerFailure.sessionId,
        prompt: 'This must not turn into another preparation decision.',
        sessionDeadlineSec: 600,
      }),
      hasRpcError('provider.composer-unavailable', false),
    );
    const composerFailureSnapshot = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-send',
      sessionId: composerFailure.sessionId,
    });
    assert.equal(composerFailureSnapshot.submissionState, 'failed_pre_submit');
    assert.equal(composerFailureSnapshot.terminal, true);
    assert.equal(composerFailureSnapshot.promptSubmitted, false);
    const failedRequest = service.database.raw.prepare('SELECT outbox_id AS id FROM outbox WHERE session_id = ? AND generation = ?')
      .get(composerFailure.sessionId, composerFailureSnapshot.generation) as { id: string };
    const failureInspection = await rpc<{ request: { message: string } }>(config.socketPath, 'workflow.team_get', {
      teamId: team.teamId, requestRef: failedRequest.id,
    });
    assert.equal(failureInspection.request.message, 'The exact composer could not retain the requested prompt.');
    fake.prepareError = null;

    await createRole(config.socketPath, team.teamId, 'expert.interrupted', 'interrupted-role');
    const interrupted = await createSession(
      config.socketPath,
      team.teamId,
      'expert.interrupted',
      'interrupted-session',
    );
    fake.disabledModels.add('interrupted-model');
    const interruptedRequest = {
      clientId: 'client-send',
      requestId: 'send-interrupted',
      sessionId: interrupted.sessionId,
      prompt: 'This row will simulate a crash after submit_attempted was committed.',
      model: 'interrupted-model',
      sessionDeadlineSec: 600,
    };
    await assert.rejects(
      rpc(config.socketPath, 'session.send', interruptedRequest),
      hasRpcError('provider.model-unavailable', false),
    );
    const interruptedAt = new Date().toISOString();
    service.database.transaction(() => {
      service.database.raw
        .prepare(`
          UPDATE outbox
          SET submission_state = 'submit_attempted', result_json = NULL,
              error_code = NULL, prompt_submitted = 1, updated_at = ?
          WHERE client_id = ? AND request_id = ?
        `)
        .run(interruptedAt, 'client-send', 'send-interrupted');
      service.database.raw
        .prepare(`
          UPDATE generations
          SET submission_state = 'submit_attempted', reason = NULL,
              error_code = NULL, prompt_submitted = 1
          WHERE session_id = ? AND generation = 1
        `)
        .run(interrupted.sessionId);
      service.database.raw
        .prepare(`
          UPDATE sessions
          SET session_state = 'submitting', provider_state = 'pending',
              observation_transport = 'fresh', updated_at = ?
          WHERE session_id = ? AND current_generation = 1
        `)
        .run(interruptedAt, interrupted.sessionId);
    });

    await createRole(config.socketPath, team.teamId, 'expert.pre-submit-crash', 'pre-submit-crash-role');
    const preSubmitCrash = await createSession(
      config.socketPath,
      team.teamId,
      'expert.pre-submit-crash',
      'pre-submit-crash-session',
    );
    fake.disabledModels.add('pre-submit-crash-model');
    const preSubmitCrashRequest = {
      clientId: 'client-send',
      requestId: 'send-pre-submit-crash',
      sessionId: preSubmitCrash.sessionId,
      prompt: 'This row will simulate a crash before submit_attempted.',
      model: 'pre-submit-crash-model',
      sessionDeadlineSec: 600,
    };
    await assert.rejects(
      rpc(config.socketPath, 'session.send', preSubmitCrashRequest),
      hasRpcError('provider.model-unavailable', false),
    );
    const preSubmitCrashAt = new Date().toISOString();
    service.database.transaction(() => {
      service.database.raw
        .prepare(`
          UPDATE outbox
          SET submission_state = 'prepared', result_json = NULL,
              error_code = NULL, prompt_submitted = 0, updated_at = ?
          WHERE client_id = ? AND request_id = ?
        `)
        .run(preSubmitCrashAt, 'client-send', 'send-pre-submit-crash');
      service.database.raw
        .prepare(`
          UPDATE generations
          SET submission_state = 'prepared', reason = NULL,
              error_code = NULL, prompt_submitted = 0
          WHERE session_id = ? AND generation = 1
        `)
        .run(preSubmitCrash.sessionId);
      service.database.raw
        .prepare(`
          UPDATE sessions
          SET session_state = 'submitting', provider_state = 'pending',
              observation_transport = 'fresh', updated_at = ?
          WHERE session_id = ? AND current_generation = 1
        `)
        .run(preSubmitCrashAt, preSubmitCrash.sessionId);
    });

    await createRole(config.socketPath, team.teamId, 'expert.unknown', 'unknown-role');
    const unknown = await createSession(
      config.socketPath,
      team.teamId,
      'expert.unknown',
      'unknown-session',
    );
    fake.acknowledgementMode = 'missing';
    const unknownRequest = {
      clientId: 'client-send',
      requestId: 'send-unknown',
      sessionId: unknown.sessionId,
      prompt: 'The acknowledgement will be hidden.',
      sessionDeadlineSec: 600,
    };
    const beforeUnknown = fake.submitCount;
    await assert.rejects(
      rpc(config.socketPath, 'session.send', unknownRequest),
      hasRpcError('session.submission-unknown', true),
    );
    assert.equal(fake.submitCount, beforeUnknown + 1);

    const outbox = service.database.raw
      .prepare(`
        SELECT submission_state AS submissionState, prompt_submitted AS promptSubmitted
        FROM outbox
        WHERE client_id = ? AND request_id = ?
      `)
      .get('client-send', 'send-unknown') as {
        submissionState: string;
        promptSubmitted: number;
      };
    assert.equal(outbox.submissionState, 'submission_unknown');
    assert.equal(Number(outbox.promptSubmitted), 1);

    await createRole(config.socketPath, team.teamId, 'expert.stalled', 'stalled-role');
    const stalled = await createSession(config.socketPath, team.teamId, 'expert.stalled', 'stalled-session');
    fake.prepareNeverResolves = true;
    const submissionsBeforeStall = fake.submitCount;
    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        clientId: 'client-send',
        requestId: 'send-stalled-preparation',
        sessionId: stalled.sessionId,
        prompt: 'Preparation must release the actor if the browser does not respond.',
        sessionDeadlineSec: 1,
      }),
      (error: unknown) => {
        assert.ok(hasRpcError('browser.unavailable', false)(error));
        assert.ok(error instanceof RpcClientError);
        const data = error.data as { details: { preparationStage: string } };
        assert.equal(data.details.preparationStage, 'prepare');
        return true;
      },
    );
    const failure = service.database.raw.prepare(
      "SELECT payload_json AS payload FROM events WHERE session_id=? AND event_type='generation.pre-submit-failed'",
    ).get(stalled.sessionId) as { payload: string };
    assert.equal(JSON.parse(failure.payload).preparationStage, 'prepare');
    const stalledSnapshot = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-send',
      sessionId: stalled.sessionId,
    });
    assert.equal(stalledSnapshot.submissionState, 'failed_pre_submit');
    assert.equal(stalledSnapshot.promptSubmitted, false);
    assert.equal(fake.submitCount, submissionsBeforeStall);
    fake.prepareNeverResolves = false;

    await createRole(config.socketPath, team.teamId, 'expert.ambiguous-stall', 'ambiguous-stall-role');
    const ambiguousStall = await createSession(
      config.socketPath,
      team.teamId,
      'expert.ambiguous-stall',
      'ambiguous-stall-session',
    );
    fake.submitNeverResolves = true;
    const beforeAmbiguousStall = fake.submitCount;
    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        clientId: 'client-send',
        requestId: 'send-ambiguous-stall',
        sessionId: ambiguousStall.sessionId,
        prompt: 'Do not resend an unacknowledged submission.',
        sessionDeadlineSec: 1,
      }),
      hasRpcError('session.submission-unknown', true),
    );
    const ambiguousSnapshot = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-send',
      sessionId: ambiguousStall.sessionId,
    });
    assert.equal(ambiguousSnapshot.submissionState, 'submission_unknown');
    assert.equal(ambiguousSnapshot.promptSubmitted, true);
    assert.equal(fake.submitCount, beforeAmbiguousStall + 1);
    fake.submitNeverResolves = false;

    service.database.raw
      .prepare("UPDATE sessions SET session_state = 'superseded' WHERE session_id = ?")
      .run(disabled.sessionId);

    await service.close();
    const afterRestart = new FakeProviderAdapter();
    service = await startCore({
      config,
      startBrowser: false,
      providerAdapters: [afterRestart],
      logger: silentLogger(),
    });

    const superseded = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-send',
      sessionId: disabled.sessionId,
    });
    assert.equal(superseded.sessionState, 'superseded');
    assert.equal(superseded.errorCode, 'provider.model-unavailable');

    const recoveredPreSubmitOutbox = service.database.raw
      .prepare(`
        SELECT submission_state AS submissionState, error_code AS errorCode,
               prompt_submitted AS promptSubmitted
        FROM outbox
        WHERE client_id = ? AND request_id = ?
      `)
      .get('client-send', 'send-pre-submit-crash') as {
        submissionState: string;
        errorCode: string | null;
        promptSubmitted: number;
      };
    assert.equal(recoveredPreSubmitOutbox.submissionState, 'failed_pre_submit');
    assert.equal(recoveredPreSubmitOutbox.errorCode, 'browser.unavailable');
    assert.equal(Number(recoveredPreSubmitOutbox.promptSubmitted), 0);
    const recoveredPreSubmitSnapshot = await rpc<SessionSnapshot>(
      config.socketPath,
      'session.get',
      {
        clientId: 'client-send',
        sessionId: preSubmitCrash.sessionId,
      },
    );
    assert.equal(recoveredPreSubmitSnapshot.sessionState, 'ready');
    assert.equal(recoveredPreSubmitSnapshot.providerState, 'error');
    assert.equal(recoveredPreSubmitSnapshot.submissionState, 'failed_pre_submit');
    assert.equal(recoveredPreSubmitSnapshot.promptSubmitted, false);
    assert.equal(recoveredPreSubmitSnapshot.reason, 'restart-pre-submit-interrupted');
    assert.equal(recoveredPreSubmitSnapshot.errorCode, 'browser.unavailable');
    await assert.rejects(
      rpc(config.socketPath, 'session.send', preSubmitCrashRequest),
      hasRpcError('browser.unavailable', false),
    );

    const recoveredOutbox = service.database.raw
      .prepare(`
        SELECT submission_state AS submissionState, prompt_submitted AS promptSubmitted
        FROM outbox
        WHERE client_id = ? AND request_id = ?
      `)
      .get('client-send', 'send-interrupted') as {
        submissionState: string;
        promptSubmitted: number;
      };
    assert.equal(recoveredOutbox.submissionState, 'submission_unknown');
    assert.equal(Number(recoveredOutbox.promptSubmitted), 1);
    const recoveredSnapshot = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-send',
      sessionId: interrupted.sessionId,
    });
    assert.equal(recoveredSnapshot.sessionState, 'observing');
    assert.equal(recoveredSnapshot.promptSubmitted, true);
    assert.equal(recoveredSnapshot.errorCode, 'session.submission-unknown');
    await assert.rejects(
      rpc(config.socketPath, 'session.send', interruptedRequest),
      hasRpcError('session.submission-unknown', true),
    );
    await assert.rejects(
      rpc(config.socketPath, 'session.send', unknownRequest),
      hasRpcError('session.submission-unknown', true),
    );
    assert.equal(afterRestart.openCount, 0);
    assert.equal(afterRestart.submitCount, 0);

    // Restart recovery retains the provider conversation while acknowledgement is missing.
    service.database.raw.prepare('UPDATE sessions SET conversation_id = ? WHERE session_id = ?')
      .run('conversation-' + unknown.sessionId, unknown.sessionId);
    const pending = service.database.raw.prepare('SELECT outbox_id AS id FROM outbox WHERE session_id = ? AND generation = 1')
      .get(unknown.sessionId) as { id: string };
    afterRestart.acknowledgementRecoveryMode = 'success';
    service.database.raw.prepare("INSERT INTO generations(session_id,generation,team_brief_version,prompt_hash,submission_state,submitted_user_message_id,submitted_user_turn_id,prompt_submitted) VALUES (?,0,1,'history','submitted','historical-user','historical-turn',1)")
      .run(unknown.sessionId);
    const recovery = afterRestart.recoverAcknowledgement.bind(afterRestart);
    afterRestart.recoverAcknowledgement = async () => ({ conversationId: 'conversation-' + unknown.sessionId,
      submittedUserMessageId: 'historical-user', submittedUserTurnId: 'historical-turn' });
    const stillUnknown = await service.submissionService.recoverAcknowledgement(service.teamDirectory.getSession(unknown.sessionId));
    assert.equal(stillUnknown.submissionState, 'submission_unknown', 'a prior generation anchor cannot confirm this request');
    assert.equal(stillUnknown.submittedUserMessageId, null);
    afterRestart.recoverAcknowledgement = recovery;

    const decision = { teamId: team.teamId, requestRef: pending.id, requestId: 'confirm-existing-message',
      decision: 'acknowledge', messageId: 'recovered-user-message-1', evidenceHash: 'a'.repeat(64) };
    await assert.rejects(rpc(config.socketPath, 'workflow.decide', { ...decision, messageId: 'wrong-message' }),
      hasRpcError('browser.snapshot-stale'));
    const confirmed = await rpc<SessionSnapshot>(config.socketPath, 'workflow.decide', decision);
    assert.equal(confirmed.submittedUserMessageId, decision.messageId);
    assert.equal(confirmed.generation, 1);
    assert.equal(confirmed.submissionState, 'submitted');
    const repeated = await rpc<SessionSnapshot>(config.socketPath, 'workflow.decide', decision);
    assert.equal(repeated.submittedUserMessageId, decision.messageId);
    await assert.rejects(rpc(config.socketPath, 'workflow.decide', { ...decision, evidenceHash: 'b'.repeat(64) }),
      hasRpcError('input.idempotency-conflict'));
    assert.equal(afterRestart.submitCount, 0);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('account cooldown parks the same request, blocks preparation, and rechecks before submit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-send-cooldown-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const fake = new FakeProviderAdapter();
  const service = await startCore({ config, startBrowser: false, providerAdapters: [fake], logger: silentLogger() });
  const budgets = new ProbeBudgetRepository(service.database.raw);
  const expire = () => budgets.save({ scope: 'chatgpt:default', nextAllowedAt: null, blockedUntil: null,
    backoffLevel: 0, consecutiveFailures: 0, updatedAt: new Date().toISOString() });
  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'client-send', requestId: 'cooldown-team', primaryRoleKey: 'main',
    });
    const session = await createSession(config.socketPath, team.teamId, 'main', 'cooldown-session');
    const send = { clientId: 'client-send', requestId: 'cooldown-send', sessionId: session.sessionId,
      prompt: 'Retain this exact draft.', sessionDeadlineSec: 600 };
    const until = new Date(Date.now() + 900_000).toISOString();
    const coordination = { requestId: 'cooldown-proof', observedAt: new Date().toISOString(), until,
      evidenceRef: 'isolated-429-fixture', scope: 'chatgpt:default' };
    await rpc(config.socketPath, 'system.defer_account_cooldown', { ...coordination, requestId: 'list-only-proof', scope: undefined });
    assert.equal(budgets.get('chatgpt:conversation-list')!.blockedUntil, until);
    assert.equal(budgets.get('chatgpt:default'), null);
    assert.equal(service.submissionService.accountCooldown(service.teamDirectory.getSession(session.sessionId)), null,
      'list-only cooldown must not block normal preparation or submission');
    budgets.save({ scope: 'chatgpt:conversation-detail:read-only-conversation', nextAllowedAt: until,
      blockedUntil: until, backoffLevel: 5, consecutiveFailures: 5, updatedAt: new Date().toISOString() });
    assert.equal(service.submissionService.accountCooldown({ ...service.teamDirectory.getSession(session.sessionId),
      conversationId: 'read-only-conversation' }), null,
      'The same conversation recovery GET backoff must not become a settings/submission hold');
    await rpc(config.socketPath, 'system.defer_account_cooldown', coordination);
    await rpc(config.socketPath, 'system.defer_account_cooldown', coordination);
    await rpc(config.socketPath, 'system.defer_account_cooldown', { ...coordination, requestId: 'earlier-proof',
      until: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(budgets.get('chatgpt:default')!.blockedUntil, until, 'coordination cannot shorten an existing limit');
    await assert.rejects(rpc(config.socketPath, 'session.send', send), hasRpcError('provider.preparation-required', false));
    const pending = service.database.raw.prepare('SELECT outbox_id AS id, generation FROM outbox WHERE request_id=?').get(send.requestId)!;
    const owner = { clientId: send.clientId, requestId: send.requestId, sessionId: session.sessionId, generation: Number(pending.generation) };
    await assert.rejects(service.submissionService.resumePreparation(owner), /account|same request/i);
    let decisions = 0;
    await assert.rejects(service.submissionService.decidePreparation({ ...owner, decisionId: 'cooldown-choice',
      decision: 'discover', purpose: 'model' }, async () => { decisions++; return { choice: null, result: {} }; }), /cooldown/);
    const observed = await rpc<any>(config.socketPath, 'workflow.team_get', { teamId: team.teamId, requestRef: pending.id });
    assert.equal(observed.request.nextCheckAt, until);
    assert.equal(observed.request.reason, 'account-cooldown');
    assert.equal(observed.request.generation, pending.generation);
    assert.equal(fake.openCount, 0);
    assert.equal(decisions, 0);
    assert.equal(service.database.raw.prepare('SELECT count(*) AS n FROM request_receipts WHERE request_id=?').get('cooldown-choice')!.n, 0);
    expire();
    const submitted = await service.submissionService.resumePreparation(owner);
    assert.equal(submitted.submissionState, 'submitted');
    service.probeCoordinator.defer('chatgpt:default', until);
    await rpc(config.socketPath, 'session.send', send); // Reading an already submitted receipt remains safe.
    assert.equal(fake.submitCount, 1);
    assert.equal(service.database.raw.prepare('SELECT count(*) AS n FROM outbox').get()!.n, 1);

    await createRole(config.socketPath, team.teamId, 'expert.race', 'race-role');
    const race = await createSession(config.socketPath, team.teamId, 'expert.race', 'race-session');
    expire();
    const originalOpen = fake.openSubmission.bind(fake);
    fake.openSubmission = async request => {
      const submission = await originalOpen(request), prepare = submission.prepare.bind(submission);
      submission.prepare = async choices => { await prepare(choices); service.probeCoordinator.defer('chatgpt:default', until); };
      return submission;
    };
    await assert.rejects(rpc(config.socketPath, 'session.send', { ...send, requestId: 'race-send', sessionId: race.sessionId }),
      hasRpcError('provider.preparation-required', false));
    assert.equal(fake.submitCount, 1, '429 arriving during preparation must prevent the irreversible submit');
    assert.equal(service.teamDirectory.getSession(race.sessionId).submissionState, 'prepared');
    assert.equal(service.teamDirectory.getSession(race.sessionId).promptSubmitted, false);
  } finally { await service.close(); rmSync(root, { recursive: true, force: true }); }
});

async function createRole(
  socketPath: string,
  teamId: string,
  roleKey: string,
  requestId: string,
): Promise<void> {
  await rpc(socketPath, 'team.role.create', {
    clientId: 'client-send',
    requestId,
    teamId,
    roleKey,
    roleType: 'expert',
    reportsToRoleKey: 'main',
  });
}

async function createSession(
  socketPath: string,
  teamId: string,
  roleKey: string,
  requestId: string,
): Promise<SessionSnapshot> {
  return await rpc<SessionSnapshot>(socketPath, 'session.create', {
    clientId: 'client-send',
    requestId,
    teamId,
    roleKey,
    provider: 'chatgpt',
  });
}

function hasRpcError(errorCode: string, promptSubmitted?: boolean) {
  return (error: unknown): boolean => {
    if (!(error instanceof RpcClientError)) {
      return false;
    }
    const data = error.data as Record<string, unknown>;
    if (data.errorCode !== errorCode) {
      return false;
    }
    if (promptSubmitted === undefined) {
      return true;
    }
    const details = data.details as Record<string, unknown> | undefined;
    return details?.promptSubmitted === promptSubmitted;
  };
}

async function rpc<Result = Readonly<Record<string, unknown>>>(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<Result> {
  return await callRpc<Result>({ socketPath, method, params, timeoutMs: 10_000 });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
