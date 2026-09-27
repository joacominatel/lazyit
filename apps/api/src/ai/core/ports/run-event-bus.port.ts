import type { AiRunEvent } from '@lazyit/shared';

/**
 * THE RUN EVENT BUS PORT (provider-and-runtime.md Fork B; synthesis §4.6). The runtime worker publishes a
 * run's events; the SSE endpoint (`GET /ai/runs/:id/events`) replays and follows them. v1 implements it
 * in-process with a ring buffer (the worker is co-located in the API container, ADR-0053); Postgres stays
 * the system of record, so a gap the buffer no longer covers is answered with a `run.snapshot`.
 */

/** One event with its per-run sequence number (the SSE `id: <runId>:<seq>`). */
export interface RunEventEnvelope {
  runId: string;
  seq: number;
  event: AiRunEvent;
}

export interface RunEventBus {
  /** Publish an event for a run; returns its envelope with the assigned sequence number. */
  publish(runId: string, event: AiRunEvent): RunEventEnvelope;
  /**
   * The buffered events after `afterSeq`, oldest first, or `null` when the buffer no longer reaches back
   * that far (the caller then sends a `run.snapshot` from Postgres).
   */
  replay(runId: string, afterSeq: number): RunEventEnvelope[] | null;
  /** Follow a run's new events. Returns the unsubscribe function. */
  subscribe(
    runId: string,
    listener: (envelope: RunEventEnvelope) => void,
  ): () => void;
}

/** DI token for the {@link RunEventBus} implementation. */
export const RUN_EVENT_BUS = Symbol('RUN_EVENT_BUS');
