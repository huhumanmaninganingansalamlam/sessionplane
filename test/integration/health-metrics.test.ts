import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callRpc } from '../../src/cli/client.ts';
import { resolveConfig } from '../../src/config.ts';
import type { SessionSnapshot } from '../../src/domain/session.ts';
import { startCore } from '../../src/main.ts';
import { RUNTIME_COUNTERS } from '../../src/telemetry/metrics.ts';
import { FakeProviderAdapter } from '../fakes/fake-provider-adapter.ts';

interface TeamSnapshot {
  readonly teamId: string;
}

interface WaitSnapshot extends SessionSnapshot {
  readonly latestEventSequence: number;
}

interface HealthSnapshot {
  readonly requestOk: true;
  readonly metrics: Readonly<Record<string, unknown>>;
}

test('system.health exposes required safety counters and live actor/wait gauges', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sessionplane-health-metrics-'));
  const config = resolveConfig({ cwd: root, env: {}, stateDir: '.state' });
  const service = await startCore({
    config,
    startBrowser: false,
    providerAdapters: [new FakeProviderAdapter()],
    logger: silentLogger(),
  });

  try {
    const team = await rpc<TeamSnapshot>(config.socketPath, 'team.create', {
      clientId: 'metrics-client',
      requestId: 'metrics-team',
      primaryRoleKey: 'main',
    });
    const session = await rpc<SessionSnapshot>(config.socketPath, 'session.create', {
      clientId: 'metrics-client',
      requestId: 'metrics-session',
      teamId: team.teamId,
      roleKey: 'main',
      provider: 'chatgpt',
    });
    const cursor = await rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
      clientId: 'metrics-client',
      sessionId: session.sessionId,
      waitMs: 0,
    });

    const waits = Array.from({ length: 20 }, () =>
      rpc<WaitSnapshot>(config.socketPath, 'session.wait', {
        clientId: 'metrics-client',
        sessionId: session.sessionId,
        afterEventSequence: cursor.latestEventSequence,
        waitMs: 1_000,
      }),
    );

    const active = await waitForHealth(
      config.socketPath,
      (health) => Number(health.metrics.wait_subscriber_count) === 20,
    );
    for (const name of RUNTIME_COUNTERS) {
      assert.equal(active.metrics[name], 0, `${name} must remain zero in the normal scenario`);
    }
    assert.equal(active.metrics.session_actor_count, 1);
    assert.equal(active.metrics.wait_subscriber_count, 20);
    assert.equal(active.metrics.observer_count, 0);
    assert.equal(typeof active.metrics.event_loop_delay_ms, 'number');
    assert.ok(Number.isFinite(active.metrics.event_loop_delay_ms));

    const resolved = await Promise.all(waits);
    assert.ok(resolved.every((snapshot) => snapshot.waitExpired));

    const settled = await waitForHealth(
      config.socketPath,
      (health) => Number(health.metrics.wait_subscriber_count) === 0,
    );
    assert.equal(settled.metrics.wait_subscriber_count, 0);
    assert.equal(settled.metrics.session_actor_queue_depth, 0);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForHealth(
  socketPath: string,
  predicate: (health: HealthSnapshot) => boolean,
): Promise<HealthSnapshot> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const health = await rpc<HealthSnapshot>(socketPath, 'system.health', {});
    if (predicate(health)) {
      return health;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the expected health metrics');
}

async function rpc<Result>(socketPath: string, method: string, params: unknown): Promise<Result> {
  return await callRpc<Result>({
    socketPath,
    method,
    params,
    timeoutMs: 5_000,
  });
}

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
