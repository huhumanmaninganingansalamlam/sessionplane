import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

export const RUNTIME_COUNTERS = [
  'wrong_session_total',
  'wrong_generation_total',
  'duplicate_submit_total',
  'focus_switch_total',
  'page_binding_conflict_total',
  'backend_probe_total',
  'backend_probe_429_total',
  'backend_probe_deferred_total',
] as const;

export type RuntimeCounterName = (typeof RUNTIME_COUNTERS)[number];
export type RuntimeDurationName =
  | 'final_detection_latency_ms'
  | 'restart_recovery_latency_ms';

interface DurationSummary {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  last: number;
}

export interface RuntimeMetricGauges {
  readonly sessionActorCount: number;
  readonly sessionActorQueueDepth: number;
  readonly waitSubscriberCount: number;
  readonly observerCount: number;
}

export class RuntimeMetrics {
  readonly #counters = new Map<RuntimeCounterName, number>();
  readonly #durations = new Map<RuntimeDurationName, DurationSummary>();
  readonly #eventLoopDelay: IntervalHistogram;
  #closed = false;

  constructor(options: { readonly eventLoopResolutionMs?: number } = {}) {
    for (const name of RUNTIME_COUNTERS) {
      this.#counters.set(name, 0);
    }
    for (const name of [
      'final_detection_latency_ms',
      'restart_recovery_latency_ms',
    ] as const) {
      this.#durations.set(name, {
        count: 0,
        sum: 0,
        min: null,
        max: null,
        last: 0,
      });
    }
    this.#eventLoopDelay = monitorEventLoopDelay({
      resolution: options.eventLoopResolutionMs ?? 20,
    });
    this.#eventLoopDelay.enable();
  }

  increment(name: RuntimeCounterName, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('Metric counter increments must be finite and nonnegative');
    }
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + amount);
  }

  observe(name: RuntimeDurationName, valueMs: number): void {
    if (!Number.isFinite(valueMs) || valueMs < 0) {
      throw new Error('Metric durations must be finite and nonnegative');
    }
    const summary = this.#durations.get(name);
    if (summary === undefined) {
      throw new Error(`Unknown duration metric: ${name}`);
    }
    summary.count += 1;
    summary.sum += valueMs;
    summary.min = summary.min === null ? valueMs : Math.min(summary.min, valueMs);
    summary.max = summary.max === null ? valueMs : Math.max(summary.max, valueMs);
    summary.last = valueMs;
  }

  counter(name: RuntimeCounterName): number {
    return this.#counters.get(name) ?? 0;
  }

  snapshot(gauges: RuntimeMetricGauges): Readonly<Record<string, unknown>> {
    const finalLatency = this.#durationSnapshot('final_detection_latency_ms');
    const restartLatency = this.#durationSnapshot('restart_recovery_latency_ms');
    const eventLoop = this.#eventLoopSnapshot();
    return {
      ...Object.fromEntries(
        RUNTIME_COUNTERS.map((name) => [name, this.#counters.get(name) ?? 0]),
      ),
      session_actor_count: gauges.sessionActorCount,
      session_actor_queue_depth: gauges.sessionActorQueueDepth,
      wait_subscriber_count: gauges.waitSubscriberCount,
      observer_count: gauges.observerCount,
      final_detection_latency_ms: finalLatency.last,
      restart_recovery_latency_ms: restartLatency.last,
      event_loop_delay_ms: eventLoop.mean,
      summaries: {
        final_detection_latency_ms: finalLatency,
        restart_recovery_latency_ms: restartLatency,
        event_loop_delay_ms: eventLoop,
      },
    };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#eventLoopDelay.disable();
  }

  #durationSnapshot(name: RuntimeDurationName): Readonly<Record<string, number | null>> {
    const summary = this.#durations.get(name);
    if (summary === undefined) {
      throw new Error(`Unknown duration metric: ${name}`);
    }
    return {
      count: summary.count,
      last: summary.last,
      min: summary.min,
      max: summary.max,
      mean: summary.count === 0 ? 0 : summary.sum / summary.count,
    };
  }

  #eventLoopSnapshot(): Readonly<Record<string, number>> {
    const toMs = (nanoseconds: number): number =>
      Number.isFinite(nanoseconds) ? nanoseconds / 1_000_000 : 0;
    return {
      mean: toMs(this.#eventLoopDelay.mean),
      max: toMs(this.#eventLoopDelay.max),
      p99: toMs(this.#eventLoopDelay.percentile(99)),
    };
  }
}
