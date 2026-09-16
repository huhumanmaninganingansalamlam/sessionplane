import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ProviderRecoveryResult } from '../../src/providers/provider-adapter.ts';
import { ProbeCoordinator } from '../../src/scheduler/probe-coordinator.ts';
import { SessionPlaneDatabase } from '../../src/storage/database.ts';
import { ProbeBudgetRepository } from '../../src/storage/probe-budget-repository.ts';

test('ProbeCoordinator enforces account single-flight and durable success pacing', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-probe-'));
  const database = SessionPlaneDatabase.open(path.join(root, 'sessionplane.sqlite'));
  let nowMs = Date.parse('2026-09-17T00:00:00.000Z');
  const coordinator = createCoordinator(database, () => new Date(nowMs));
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = async (): Promise<ProviderRecoveryResult> => {
    calls += 1;
    await gate;
    return pending();
  };

  try {
    const first = coordinator.run('chatgpt:default', operation);
    const second = coordinator.run('chatgpt:default', operation);
    assert.strictEqual(first, second);
    assert.equal(calls, 1);
    release();
    assert.equal((await first).kind, 'pending');
    assert.equal((await second).kind, 'pending');

    const paced = await coordinator.run('chatgpt:default', async () => {
      calls += 1;
      return pending();
    });
    assert.equal(paced.kind, 'deferred');
    assert.equal(paced.reason, 'probe-paced');
    assert.equal(calls, 1);

    const persisted = new ProbeBudgetRepository(database.raw).get('chatgpt:default');
    assert.equal(persisted?.nextAllowedAt, '2026-09-17T00:00:30.000Z');

    const afterRestart = createCoordinator(database, () => new Date(nowMs));
    const stillPaced = await afterRestart.run('chatgpt:default', async () => pending());
    assert.equal(stillPaced.kind, 'deferred');
    assert.equal(stillPaced.nextCheckAt, '2026-09-17T00:00:30.000Z');
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('ProbeCoordinator honors Retry-After, applies exponential 429 backoff, and never reports blocked', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-probe-429-'));
  const database = SessionPlaneDatabase.open(path.join(root, 'sessionplane.sqlite'));
  let nowMs = Date.parse('2026-09-17T00:00:00.000Z');
  const coordinator = createCoordinator(database, () => new Date(nowMs));
  let calls = 0;

  try {
    const limited = await coordinator.run('chatgpt:default', async () => {
      calls += 1;
      return {
        kind: 'deferred',
        observationTransport: 'deferred',
        responseMessageId: null,
        answerText: null,
        reason: 'backend-http-429',
        retryAfterMs: 120_000,
        nextCheckAt: null,
      };
    });
    assert.equal(limited.kind, 'deferred');
    assert.equal(limited.reason, 'backend-http-429');
    assert.equal(limited.retryAfterMs, 120_000);
    assert.equal(limited.nextCheckAt, '2026-09-17T00:02:00.000Z');

    const paced = await coordinator.run('chatgpt:default', async () => {
      calls += 1;
      return pending();
    });
    assert.equal(paced.kind, 'deferred');
    assert.equal(paced.reason, 'probe-paced');
    assert.equal(calls, 1);

    nowMs += 120_000;
    const secondLimited = await coordinator.run('chatgpt:default', async () => {
      calls += 1;
      return {
        kind: 'deferred',
        observationTransport: 'deferred',
        responseMessageId: null,
        answerText: null,
        reason: 'backend-http-429',
        retryAfterMs: null,
        nextCheckAt: null,
      };
    });
    assert.equal(secondLimited.retryAfterMs, 120_000);
    assert.equal(secondLimited.nextCheckAt, '2026-09-17T00:04:00.000Z');

    const budget = new ProbeBudgetRepository(database.raw).get('chatgpt:default');
    assert.equal(budget?.backoffLevel, 2);
    assert.equal(budget?.consecutiveFailures, 2);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function createCoordinator(
  database: SessionPlaneDatabase,
  now: () => Date,
): ProbeCoordinator {
  return new ProbeCoordinator({
    database,
    successIntervalMs: 30_000,
    min429BackoffMs: 60_000,
    max429BackoffMs: 15 * 60_000,
    jitterRatio: 0,
    now,
  });
}

function pending(): ProviderRecoveryResult {
  return {
    kind: 'pending',
    observationTransport: 'fresh',
    responseMessageId: null,
    answerText: null,
    reason: 'backend-pending',
    retryAfterMs: null,
    nextCheckAt: null,
  };
}
