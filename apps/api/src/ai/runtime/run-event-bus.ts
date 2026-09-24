import { Injectable, Logger } from '@nestjs/common';
import type { AiRunEvent } from '@lazyit/shared';
import type {
  RunEventBus,
  RunEventEnvelope,
} from '../core/ports/run-event-bus.port';

/** Events kept per run. Deltas are small; past this, a late replay is answered with a snapshot. */
export const RUN_EVENT_BUFFER_CAPACITY = 2_000;
/** How long a finished run's buffer stays for a reconnecting client. */
export const RUN_EVENT_RETAIN_MS = 5 * 60 * 1000;
/** Runs tracked at once; the oldest finished (then idle) buffers are dropped first. */
export const RUN_EVENT_MAX_RUNS = 500;

export interface InProcessRunEventBusOptions {
  capacity?: number;
  retainMs?: number;
  maxRuns?: number;
  /** The sequence base of this process (tests pin it). */
  base?: number;
  now?: () => number;
}

interface RunBuffer {
  /** The last sequence number issued (the base before the first event). */
  lastSeq: number;
  events: RunEventEnvelope[];
  listeners: Set<(envelope: RunEventEnvelope) => void>;
  /** When `run.finished` was published; the buffer is dropped `retainMs` later when nobody listens. */
  finishedAt: number | null;
  touchedAt: number;
}

/**
 * The per-process base every run's sequence starts from: seconds since the epoch, modulo a million, times
 * a thousand — below the int4 bound of `run.snapshot.seq` and different after every restart. A client
 * whose `Last-Event-ID` came from a previous process names a position this buffer never issued, so
 * `replay` answers `null` and the caller sends a `run.snapshot` instead of a wrong suffix.
 */
export function runEventSequenceBase(now: number = Date.now()): number {
  return (Math.floor(now / 1000) % 1_000_000) * 1000;
}

/** The SSE `id:` of an envelope (synthesis §4.6): `<runId>:<seq>`. */
export function formatRunEventId(envelope: RunEventEnvelope): string {
  return `${envelope.runId}:${envelope.seq}`;
}

/**
 * The sequence number in a `Last-Event-ID` header, when it names `runId`; `null` otherwise (another run,
 * a malformed value, or no header), in which case the caller starts from a snapshot.
 */
export function parseLastEventId(
  runId: string,
  header: string | null | undefined,
): number | null {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  const separator = value.lastIndexOf(':');
  if (separator <= 0 || value.slice(0, separator) !== runId) return null;
  const digits = value.slice(separator + 1);
  if (!/^\d{1,10}$/.test(digits)) return null;
  const seq = Number(digits);
  return Number.isSafeInteger(seq) && seq <= 2_147_483_647 ? seq : null;
}

/**
 * THE IN-PROCESS `RunEventBus` (provider-and-runtime.md Fork B, §9.3; synthesis §4.6). The `ai-run` worker
 * runs in the API container (ADR-0053), so the worker and the SSE endpoint share this process: a ring
 * buffer per run replays by `Last-Event-ID`, and listeners follow new events. Postgres stays the system of
 * record — a position the buffer no longer covers (evicted, or issued by another process) replays as
 * `null`, and the SSE endpoint answers with a `run.snapshot` built from the database.
 *
 * Sequence numbers are per run, strictly increasing and contiguous within one process, starting after
 * {@link runEventSequenceBase}. Listener failures are contained: a broken subscriber never fails the run.
 */
@Injectable()
export class InProcessRunEventBus implements RunEventBus {
  private readonly logger = new Logger(InProcessRunEventBus.name);
  private readonly runs = new Map<string, RunBuffer>();
  private readonly capacity: number;
  private readonly retainMs: number;
  private readonly maxRuns: number;
  private readonly base: number;
  private readonly now: () => number;

  constructor(options: InProcessRunEventBusOptions = {}) {
    this.capacity = options.capacity ?? RUN_EVENT_BUFFER_CAPACITY;
    this.retainMs = options.retainMs ?? RUN_EVENT_RETAIN_MS;
    this.maxRuns = options.maxRuns ?? RUN_EVENT_MAX_RUNS;
    this.now = options.now ?? Date.now;
    this.base = options.base ?? runEventSequenceBase(this.now());
  }

  publish(runId: string, event: AiRunEvent): RunEventEnvelope {
    const buffer = this.buffer(runId);
    buffer.lastSeq += 1;
    const envelope: RunEventEnvelope = { runId, seq: buffer.lastSeq, event };
    buffer.events.push(envelope);
    if (buffer.events.length > this.capacity) {
      buffer.events.splice(0, buffer.events.length - this.capacity);
    }
    buffer.touchedAt = this.now();
    if (event.type === 'run.finished') {
      buffer.finishedAt = buffer.touchedAt;
    }
    for (const listener of [...buffer.listeners]) {
      try {
        listener(envelope);
      } catch (err) {
        this.logger.warn(
          `run event listener failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.prune();
    return envelope;
  }

  replay(runId: string, afterSeq: number): RunEventEnvelope[] | null {
    const buffer = this.runs.get(runId);
    if (!buffer || !Number.isInteger(afterSeq)) return null;
    if (afterSeq > buffer.lastSeq) return null; // a position this process never issued
    const oldest = buffer.events[0]?.seq ?? buffer.lastSeq + 1;
    if (afterSeq < oldest - 1) return null; // evicted, or before this process's base
    return buffer.events.filter((envelope) => envelope.seq > afterSeq);
  }

  subscribe(
    runId: string,
    listener: (envelope: RunEventEnvelope) => void,
  ): () => void {
    const buffer = this.buffer(runId);
    buffer.listeners.add(listener);
    return () => {
      buffer.listeners.delete(listener);
    };
  }

  /**
   * The last sequence number issued for a run — the `seq` a `run.snapshot` covers, so a replay after it
   * continues without a gap. The process base when the run has published nothing here yet.
   * (Not on the port: `RunEventBus` is frozen in `core/ports/`; the SSE endpoint may inject this class.)
   */
  lastSeq(runId: string): number {
    return this.runs.get(runId)?.lastSeq ?? this.base;
  }

  private buffer(runId: string): RunBuffer {
    let buffer = this.runs.get(runId);
    if (!buffer) {
      buffer = {
        lastSeq: this.base,
        events: [],
        listeners: new Set(),
        finishedAt: null,
        touchedAt: this.now(),
      };
      this.runs.set(runId, buffer);
    }
    return buffer;
  }

  /** Drop finished, idle buffers past retention; past `maxRuns`, drop the stalest idle buffers. */
  private prune(): void {
    const now = this.now();
    for (const [runId, buffer] of this.runs) {
      if (
        buffer.finishedAt !== null &&
        buffer.listeners.size === 0 &&
        now - buffer.finishedAt > this.retainMs
      ) {
        this.runs.delete(runId);
      }
    }
    if (this.runs.size <= this.maxRuns) return;
    const idle = [...this.runs.entries()]
      .filter(([, buffer]) => buffer.listeners.size === 0)
      .sort(
        ([, a], [, b]) =>
          (a.finishedAt === null ? 1 : 0) - (b.finishedAt === null ? 1 : 0) ||
          a.touchedAt - b.touchedAt,
      );
    for (const [runId] of idle) {
      if (this.runs.size <= this.maxRuns) break;
      this.runs.delete(runId);
    }
  }
}
