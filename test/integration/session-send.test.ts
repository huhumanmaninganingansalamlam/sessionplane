import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import { startCore, type CoreService } from '../../src/main.ts';
import { ProviderSubmissionError } from '../../src/providers/provider-adapter.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface SessionSnapshot {
  readonly sessionId: string;
  readonly generation: number;
  readonly submissionState: string | null;
  readonly sessionState: string;
  readonly providerState: string;
  readonly conversationId: string | null;
  readonly submittedUserMessageId: string | null;
  readonly submittedUserTurnId: string | null;
  readonly promptSubmitted: boolean;
  readonly errorCode: string | null;
}

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
      hasRpcError('browser.unavailable', false),
    );
    const stalledSnapshot = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'client-send',
      sessionId: stalled.sessionId,
    });
    assert.equal(stalledSnapshot.submissionState, 'failed_pre_submit');
    assert.equal(stalledSnapshot.promptSubmitted, false);
    assert.equal(fake.submitCount, submissionsBeforeStall);
    assert.equal(service.actorScheduler.actorFor(stalled.sessionId).queueDepth, 0);
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
    assert.equal(service.actorScheduler.actorFor(ambiguousStall.sessionId).queueDepth, 0);
    fake.submitNeverResolves = false;

    await service.close();
    const afterRestart = new FakeProviderAdapter();
    service = await startCore({
      config,
      startBrowser: false,
      providerAdapters: [afterRestart],
      logger: silentLogger(),
    });

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
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
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
