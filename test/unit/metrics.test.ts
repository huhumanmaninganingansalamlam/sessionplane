import assert from 'node:assert/strict';
import test from 'node:test';

import { RUNTIME_COUNTERS, RuntimeMetrics } from '../../src/telemetry/metrics.ts';

test('RuntimeMetrics initializes required safety counters at zero and records durations', async () => {
  const metrics = new RuntimeMetrics({ eventLoopResolutionMs: 1 });
  try {
    const initial = metrics.snapshot({
      sessionActorCount: 0,
      sessionActorQueueDepth: 0,
      waitSubscriberCount: 0,
      observerCount: 0,
    });
    for (const name of RUNTIME_COUNTERS) {
      assert.equal(initial[name], 0, `${name} must start at zero`);
    }

    metrics.increment('backend_probe_total');
    metrics.increment('backend_probe_total', 2);
    metrics.increment('page_binding_conflict_total');
    metrics.observe('final_detection_latency_ms', 125);
    metrics.observe('final_detection_latency_ms', 375);
    metrics.observe('restart_recovery_latency_ms', 42);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const snapshot = metrics.snapshot({
      sessionActorCount: 3,
      sessionActorQueueDepth: 4,
      waitSubscriberCount: 20,
      observerCount: 2,
    });
    assert.equal(snapshot.backend_probe_total, 3);
    assert.equal(snapshot.page_binding_conflict_total, 1);
    assert.equal(snapshot.session_actor_count, 3);
    assert.equal(snapshot.session_actor_queue_depth, 4);
    assert.equal(snapshot.wait_subscriber_count, 20);
    assert.equal(snapshot.observer_count, 2);
    assert.equal(snapshot.final_detection_latency_ms, 375);
    assert.equal(snapshot.restart_recovery_latency_ms, 42);
    assert.equal(typeof snapshot.event_loop_delay_ms, 'number');
    assert.ok(Number.isFinite(snapshot.event_loop_delay_ms));

    const summaries = snapshot.summaries as Record<string, Record<string, number | null>>;
    assert.equal(summaries.final_detection_latency_ms?.count, 2);
    assert.equal(summaries.final_detection_latency_ms?.min, 125);
    assert.equal(summaries.final_detection_latency_ms?.max, 375);
    assert.equal(summaries.final_detection_latency_ms?.mean, 250);
    assert.equal(summaries.restart_recovery_latency_ms?.count, 1);
  } finally {
    metrics.close();
    metrics.close();
  }
});

test('RuntimeMetrics rejects negative or nonfinite observations', () => {
  const metrics = new RuntimeMetrics();
  try {
    assert.throws(() => metrics.increment('wrong_session_total', -1), /nonnegative/);
    assert.throws(() => metrics.increment('wrong_session_total', Number.NaN), /finite/);
    assert.throws(() => metrics.observe('final_detection_latency_ms', -1), /nonnegative/);
    assert.throws(
      () => metrics.observe('restart_recovery_latency_ms', Number.POSITIVE_INFINITY),
      /finite/,
    );
  } finally {
    metrics.close();
  }
});
