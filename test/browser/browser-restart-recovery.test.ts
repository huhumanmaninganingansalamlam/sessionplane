import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Page } from 'playwright-core';

import { callRpc, RpcClientError } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

test('browser restart rebinds the exact conversation without resending and quarantines duplicates', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-browser-restart-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    observationActiveSweepMs: 20,
    observationQuietSweepMs: 40,
    observationQuietWindowMs: 20,
    backendRecoveryAfterMs: 10_000,
  });
  const fake = new FakeProviderAdapter();
  const service = await startCore({
    config,
    browserHeadless: true,
    providerAdapters: [fake],
    recoveryNavigatePage: navigateFixture,
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'browser-restart-client',
      requestId: 'browser-restart-team',
      primaryRoleKey: 'main',
    });
    const createdSession = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'browser-restart-client',
      requestId: 'browser-restart-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const submitted = await rpc<SessionSnapshot>(config.socketPath, 'session.send', {
      clientId: 'browser-restart-client',
      requestId: 'browser-restart-send',
      sessionId: createdSession.sessionId,
      prompt: 'Keep this exact browser-backed generation recoverable.',
      sessionDeadlineSec: 600,
    });
    assert.notEqual(submitted.conversationId, null);
    const conversationId = submitted.conversationId as string;

    const browserOwner = service.browserOwner;
    assert.notEqual(browserOwner, null);
    if (browserOwner === null) {
      assert.fail('Expected a browser owner');
    }
    const exactPage = await browserOwner.createPage();
    await navigateFixture(
      exactPage.page,
      `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
    );
    service.pageRegistry.bindPage(exactPage.binding.pageKey, {
      sessionId: submitted.sessionId,
      generation: submitted.generation,
      conversationId,
    });
    const browserBacked = await service.actorScheduler.updateGeneration(
      submitted.sessionId,
      submitted.generation,
      {
        pageKey: exactPage.binding.pageKey,
        observationTransport: 'fresh',
        reason: 'browser-restart-test-bound',
        errorCode: null,
      },
      'generation.browser-restart-test-bound',
    );
    assert.equal(browserBacked.pageKey, exactPage.binding.pageKey);
    const submitCountBeforeRestart = fake.submitCount;

    const restart = await service.restartBrowser();
    const recovery = restart.recovery as Record<string, number>;
    assert.equal(recovery.scanned, 1);
    assert.equal(recovery.conflicts, 0);
    assert.equal(recovery.unavailable, 0);
    assert.ok(recovery.rebound + recovery.opened >= 1);
    assert.equal(fake.submitCount, submitCountBeforeRestart);

    const rebound = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'browser-restart-client',
      sessionId: submitted.sessionId,
    });
    assert.equal(rebound.sessionId, submitted.sessionId);
    assert.equal(rebound.generation, submitted.generation);
    assert.equal(rebound.conversationId, conversationId);
    assert.notEqual(rebound.pageKey, null);
    assert.equal(rebound.observationTransport, 'fresh');
    const binding = service.pageRegistry.getBinding(rebound.pageKey as string);
    assert.equal(binding.state, 'owned');
    assert.equal(binding.sessionId, submitted.sessionId);
    assert.equal(binding.generation, submitted.generation);
    assert.equal(binding.conversationId, conversationId);

    const stored = service.pageBindings.get(rebound.pageKey as string);
    assert.equal(stored?.sessionId, submitted.sessionId);
    assert.equal(stored?.generation, submitted.generation);
    assert.equal(stored?.conversationId, conversationId);
    assert.equal(stored?.bindingState, 'owned');

    const firstDuplicate = await browserOwner.createPage();
    const secondDuplicate = await browserOwner.createPage();
    await Promise.all([
      navigateFixture(
        firstDuplicate.page,
        `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
      ),
      navigateFixture(
        secondDuplicate.page,
        `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`,
      ),
    ]);
    service.pageRegistry.refreshPage(firstDuplicate.binding.pageKey);
    service.pageRegistry.refreshPage(secondDuplicate.binding.pageKey);
    assert.ok(
      service.pageRegistry
        .findByConversation(conversationId)
        .every((candidate) => candidate.state === 'conflict'),
    );

    const conflictReport = await service.recoveryService.restore({ forceObservers: true });
    assert.equal(conflictReport.conflicts, 1);
    assert.equal(fake.submitCount, submitCountBeforeRestart);
    const conflicted = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'browser-restart-client',
      sessionId: submitted.sessionId,
    });
    assert.equal(conflicted.pageKey, null);
    assert.equal(conflicted.observationTransport, 'stale');
    assert.equal(conflicted.errorCode, 'session.page-identity-unverified');
    assert.equal(conflicted.reason, 'duplicate-conversation-pages');

    const outboxCount = service.database.raw
      .prepare('SELECT COUNT(*) AS count FROM outbox WHERE session_id = ?')
      .get(submitted.sessionId) as { count: number };
    assert.equal(Number(outboxCount.count), 1);
    assert.ok(service.metrics.counter('page_binding_conflict_total') >= 1);
    assert.equal(service.metrics.counter('duplicate_submit_total'), 0);
    assert.equal(service.metrics.counter('focus_switch_total'), 0);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('service restart preserves submission-unknown diagnostics while reopening the exact conversation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-core-restart-ambiguous-browser-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    backendRecoveryAfterMs: 10_000,
  });
  const beforeRestart = new FakeProviderAdapter();
  let service = await startCore({
    config,
    browserHeadless: true,
    providerAdapters: [beforeRestart],
    recoveryNavigatePage: navigateFixture,
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'ambiguous-browser-restart-client',
      requestId: 'ambiguous-browser-restart-team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'ambiguous-browser-restart-client',
      requestId: 'ambiguous-browser-restart-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const submitted = await rpc<SessionSnapshot>(config.socketPath, 'session.send', {
      clientId: 'ambiguous-browser-restart-client',
      requestId: 'ambiguous-browser-restart-send',
      sessionId: session.sessionId,
      prompt: 'Keep the ambiguous diagnostic through an exact core restart.',
      sessionDeadlineSec: 600,
    });
    assert.notEqual(submitted.conversationId, null);
    const conversationId = submitted.conversationId as string;
    const ambiguous = await service.actorScheduler.updateGeneration(
      submitted.sessionId,
      submitted.generation,
      {
        submissionState: 'submission_unknown',
        pageKey: null,
        submittedUserMessageId: null,
        submittedUserTurnId: null,
        reason: 'submit-unacknowledged',
        errorCode: 'session.submission-unknown',
        promptSubmitted: true,
      },
      'generation.core-restart-test-submission-unknown',
    );
    assert.equal(ambiguous.errorCode, 'session.submission-unknown');
    assert.equal(ambiguous.reason, 'submit-unacknowledged');
    assert.equal(ambiguous.pageKey, null);
    const generationBefore = submitted.generation;
    const submitCountBefore = beforeRestart.submitCount;
    service.database.raw
      .prepare(
        "UPDATE outbox SET submission_state = 'submission_unknown', result_json = NULL, error_code = 'session.submission-unknown', prompt_submitted = 1 WHERE session_id = ? AND generation = ?",
      )
      .run(submitted.sessionId, generationBefore);

    await service.close();

    const afterRestart = new FakeProviderAdapter();
    service = await startCore({
      config,
      browserHeadless: true,
      providerAdapters: [afterRestart],
      recoveryNavigatePage: navigateFixture,
      logger: silentLogger(),
    });

    const restored = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'ambiguous-browser-restart-client',
      sessionId: submitted.sessionId,
    });
    assert.equal(restored.generation, generationBefore);
    assert.equal(restored.conversationId, conversationId);
    assert.notEqual(restored.pageKey, null);
    assert.equal(restored.observationTransport, 'fresh');
    assert.equal(restored.errorCode, 'session.submission-unknown');
    assert.equal(restored.reason, 'submit-unacknowledged');
    assert.equal(restored.promptSubmitted, true);
    assert.equal(afterRestart.openCount, 0);
    assert.equal(afterRestart.submitCount, 0);
    assert.equal(afterRestart.observationOpenCount, 0);
    assert.equal(beforeRestart.submitCount, submitCountBefore);

    const generation = service.database.raw
      .prepare(`
        SELECT submission_state AS submissionState, reason, error_code AS errorCode, prompt_submitted AS promptSubmitted
        FROM generations
        WHERE session_id = ? AND generation = ?
      `)
      .get(submitted.sessionId, generationBefore) as {
        submissionState: string;
        reason: string | null;
        errorCode: string | null;
        promptSubmitted: number;
      };
    assert.equal(generation.submissionState, 'submission_unknown');
    assert.equal(generation.reason, 'submit-unacknowledged');
    assert.equal(generation.errorCode, 'session.submission-unknown');
    assert.equal(generation.promptSubmitted, 1);
    assert.ok(afterRestart.acknowledgementRecoveryCount >= 1);

    afterRestart.acknowledgementRecoveryMode = 'success';
    const rerecovery = await service.recoveryService.restore({ forceObservers: true });
    assert.equal(rerecovery.acknowledgementsRecovered, 1);
    const recovered = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'ambiguous-browser-restart-client',
      sessionId: submitted.sessionId,
    });
    assert.equal(recovered.submissionState, 'submitted');
    assert.ok(['submitted', 'observing'].includes(recovered.sessionState));
    assert.equal(recovered.errorCode, null);
    assert.equal(recovered.submittedUserMessageId, 'recovered-user-message-' + String(generationBefore));
    assert.equal(recovered.submittedUserTurnId, 'recovered-user-turn-' + String(generationBefore));
    assert.equal(afterRestart.submitCount, 0);
    assert.ok(afterRestart.observationOpenCount >= 1);

    const recoveredOutbox = service.database.raw
      .prepare('SELECT submission_state AS submissionState, prompt_submitted AS promptSubmitted FROM outbox WHERE session_id = ? AND generation = ?')
      .get(submitted.sessionId, generationBefore) as {
        submissionState: string;
        promptSubmitted: number;
      };
    assert.equal(recoveredOutbox.submissionState, 'submitted');
    assert.equal(recoveredOutbox.promptSubmitted, 1);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('restart recovers a unique ambiguous follow-up acknowledgement without resending', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-core-restart-followup-ambiguous-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    backendRecoveryAfterMs: 10_000,
  });
  const beforeRestart = new FakeProviderAdapter();
  let service = await startCore({
    config,
    browserHeadless: true,
    providerAdapters: [beforeRestart],
    recoveryNavigatePage: navigateFixture,
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'followup-ambiguous-client',
      requestId: 'followup-ambiguous-team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'followup-ambiguous-client',
      requestId: 'followup-ambiguous-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const firstPrompt = 'Establish an older exact generation before the ambiguous follow-up.';
    const secondPrompt = 'Recover this unique ambiguous follow-up without resending it.';
    const first = await rpc<SessionSnapshot>(config.socketPath, 'session.send', {
      clientId: 'followup-ambiguous-client',
      requestId: 'followup-ambiguous-first',
      sessionId: session.sessionId,
      prompt: firstPrompt,
      sessionDeadlineSec: 600,
    });
    await service.actorScheduler.updateGeneration(
      first.sessionId,
      first.generation,
      {
        sessionState: 'complete',
        providerState: 'complete',
        observationTransport: 'fresh',
        responseMessageId: 'followup-first-response',
        answerText: 'done',
        completedAt: new Date().toISOString(),
        reason: 'test-complete',
        errorCode: null,
      },
      'generation.followup-recovery-first-complete',
    );

    beforeRestart.acknowledgementMode = 'missing';
    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        clientId: 'followup-ambiguous-client',
        requestId: 'followup-ambiguous-second',
        sessionId: session.sessionId,
        prompt: secondPrompt,
        sessionDeadlineSec: 600,
      }),
      (error: unknown) => {
        if (!(error instanceof RpcClientError)) return false;
        const data = error.data as Record<string, unknown>;
        return data.errorCode === 'session.submission-unknown';
      },
    );
    const ambiguous = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'followup-ambiguous-client',
      sessionId: session.sessionId,
    });
    assert.equal(ambiguous.generation, 2);
    assert.equal(ambiguous.submissionState, 'submission_unknown');
    assert.equal(ambiguous.promptSubmitted, true);
    assert.notEqual(ambiguous.conversationId, null);

    await service.close();
    const afterRestart = new FakeProviderAdapter();
    afterRestart.acknowledgementRecoveryMode = 'success';
    service = await startCore({
      config,
      browserHeadless: true,
      providerAdapters: [afterRestart],
      recoveryNavigatePage: navigateFixture,
      logger: silentLogger(),
    });

    const restored = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'followup-ambiguous-client',
      sessionId: session.sessionId,
    });
    assert.equal(restored.generation, 2);
    assert.equal(restored.submissionState, 'submitted');
    assert.equal(restored.errorCode, null);
    assert.equal(restored.submittedUserMessageId, 'recovered-user-message-2');
    assert.equal(restored.submittedUserTurnId, 'recovered-user-turn-2');
    assert.equal(afterRestart.acknowledgementRecoveryCount, 1);
    assert.equal(afterRestart.submitCount, 0);
    assert.ok(afterRestart.observationOpenCount >= 1);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('service restart preserves a pre-submit failure instead of treating an old conversation as current work', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-core-restart-presubmit-browser-'));
  const config = resolveConfig({
    cwd: root,
    env: {},
    stateDir: '.state',
    backendRecoveryAfterMs: 10_000,
  });
  const beforeRestart = new FakeProviderAdapter();
  let service = await startCore({
    config,
    browserHeadless: true,
    providerAdapters: [beforeRestart],
    recoveryNavigatePage: navigateFixture,
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'presubmit-browser-restart-client',
      requestId: 'presubmit-browser-restart-team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'presubmit-browser-restart-client',
      requestId: 'presubmit-browser-restart-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const first = await rpc<SessionSnapshot>(config.socketPath, 'session.send', {
      clientId: 'presubmit-browser-restart-client',
      requestId: 'presubmit-browser-restart-first',
      sessionId: session.sessionId,
      prompt: 'Establish one durable conversation before the pre-submit failure.',
      sessionDeadlineSec: 600,
    });
    await service.actorScheduler.updateGeneration(
      first.sessionId,
      first.generation,
      {
        sessionState: 'complete',
        providerState: 'complete',
        observationTransport: 'fresh',
        responseMessageId: 'presubmit-first-response',
        answerText: 'done',
        completedAt: new Date().toISOString(),
        reason: 'test-complete',
        errorCode: null,
      },
      'generation.presubmit-restart-test-complete',
    );

    beforeRestart.disabledModels.add('disabled-model');
    await assert.rejects(
      rpc(config.socketPath, 'session.send', {
        clientId: 'presubmit-browser-restart-client',
        requestId: 'presubmit-browser-restart-second',
        sessionId: session.sessionId,
        prompt: 'This prompt must never be submitted.',
        model: 'disabled-model',
        sessionDeadlineSec: 600,
      }),
      (error: unknown) => {
        if (!(error instanceof RpcClientError)) return false;
        const data = error.data as Record<string, unknown>;
        return data.errorCode === 'provider.model-unavailable';
      },
    );
    const before = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'presubmit-browser-restart-client',
      sessionId: session.sessionId,
    });
    assert.equal(before.generation, 2);
    assert.equal(before.submissionState, 'failed_pre_submit');
    assert.equal(before.promptSubmitted, false);
    assert.equal(before.errorCode, 'provider.model-unavailable');
    assert.equal(before.reason, 'pre-submit-failure');
    const conversationId = before.conversationId;
    assert.notEqual(conversationId, null);

    service.database.raw
      .prepare(`
        UPDATE generations
        SET reason = 'restart-page-opened', error_code = NULL
        WHERE session_id = ? AND generation = 2
      `)
      .run(session.sessionId);
    service.database.raw
      .prepare(`
        UPDATE sessions
        SET observation_transport = 'fresh'
        WHERE session_id = ?
      `)
      .run(session.sessionId);

    await service.close();
    const afterRestart = new FakeProviderAdapter();
    service = await startCore({
      config,
      browserHeadless: true,
      providerAdapters: [afterRestart],
      recoveryNavigatePage: navigateFixture,
      logger: silentLogger(),
    });

    const restored = await rpc<SessionSnapshot>(config.socketPath, 'session.get', {
      clientId: 'presubmit-browser-restart-client',
      sessionId: session.sessionId,
    });
    assert.equal(restored.generation, 2);
    assert.equal(restored.submissionState, 'failed_pre_submit');
    assert.equal(restored.promptSubmitted, false);
    assert.equal(restored.errorCode, 'provider.model-unavailable');
    assert.equal(restored.reason, 'pre-submit-failure');
    assert.equal(restored.observationTransport, 'unavailable');
    assert.equal(restored.conversationId, conversationId);
    assert.equal(afterRestart.openCount, 0);
    assert.equal(afterRestart.submitCount, 0);
    assert.equal(afterRestart.acknowledgementRecoveryCount, 0);
    assert.equal(afterRestart.observationOpenCount, 0);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function navigateFixture(page: Page, url: string): Promise<void> {
  await page.route('https://chatgpt.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><main>restart fixture</main></body></html>',
    });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
