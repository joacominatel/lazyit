import { Injectable, Logger } from '@nestjs/common';
import type { AiRunEvent } from '@lazyit/shared';
import type {
  RunEventBus,
  RunEventEnvelope,
} from '../core/ports/run-event-bus.port';
import { describeError } from './runtime.constants';

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
  /**
   * Replay covers positions `>= floor`: the process-wide sequence value when the buffer was created, then
   * the seq of the newest event evicted from it. A position below it answers `null` (→ snapshot).
   */
  floor: number;
  /** The last sequence number issued to this run (`floor` before its first event here). */
  lastSeq: number;
  events: RunEventEnvelope[];
  /** When `run.finished` was published; the buffer is dropped `retainMs` later when nobody listens. */
  finishedAt: number | null;
  touchedAt: number;
}

type Listener = (envelope: RunEventEnvelope) => void;

/**
 * The per-process start of the sequence counter: seconds since the epoch, modulo a million, times a
 * thousand — at most ~10⁹, leaving ~1.1 × 10⁹ events per process below the int4 bound of
 * `run.snapshot.seq`, and different after every restart. A client whose `Last-Event-ID` came from a
 * previous process names a position this process's buffers do not cover, so `replay` answers `null` and
 * the caller sends a `run.snapshot` instead of a wrong suffix.
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
 * record — a position the buffer does not cover (evicted events, a dropped buffer, or an id issued by
 * another process) replays as `null`, and the SSE endpoint answers with a `run.snapshot` from the database.
 *
 * Sequence numbers come from ONE process-wide counter that starts at {@link runEventSequenceBase}: they
 * increase strictly within a run (not contiguously), and a buffer re-created after it was dropped starts
 * above every number issued before, so a stale `Last-Event-ID` can never replay a wrong suffix.
 *
 * AUTHORIZATION IS THE CALLER'S. The bus has no notion of ownership: the SSE endpoint (W3-1) must load
 * the run and check that the caller owns it BEFORE `subscribe`, `replay` or `lastSeq` — a run id is not a
 * capability. Subscribing to a run creates no buffer; listener failures are contained.
 */
@Injectable()
export class InProcessRunEventBus implements RunEventBus {
  private readonly logger = new Logger(InProcessRunEventBus.name);
  private readonly runs = new Map<string, RunBuffer>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly capacity: number;
  private readonly retainMs: number;
  private readonly maxRuns: number;
  private readonly now: () => number;
  /** The last sequence number issued in this process, across all runs. */
  private cursor: number;

  constructor(options: InProcessRunEventBusOptions = {}) {
    this.capacity = options.capacity ?? RUN_EVENT_BUFFER_CAPACITY;
    this.retainMs = options.retainMs ?? RUN_EVENT_RETAIN_MS;
    this.maxRuns = options.maxRuns ?? RUN_EVENT_MAX_RUNS;
    this.now = options.now ?? Date.now;
    this.cursor = options.base ?? runEventSequenceBase(this.now());
  }

  publish(runId: string, event: AiRunEvent): RunEventEnvelope {
    let buffer = this.runs.get(runId);
    if (!buffer) {
      buffer = {
        floor: this.cursor,
        lastSeq: this.cursor,
        events: [],
        finishedAt: null,
        touchedAt: this.now(),
      };
      this.runs.set(runId, buffer);
    }
    this.cursor += 1;
    buffer.lastSeq = this.cursor;
    const envelope: RunEventEnvelope = { runId, seq: this.cursor, event };
    buffer.events.push(envelope);
    if (buffer.events.length > this.capacity) {
      const evicted = buffer.events.splice(
        0,
        buffer.events.length - this.capacity,
      );
      buffer.floor = evicted[evicted.length - 1].seq;
    }
    buffer.touchedAt = this.now();
    if (event.type === 'run.finished') {
      buffer.finishedAt = buffer.touchedAt;
    }
    for (const listener of [...(this.listeners.get(runId) ?? [])]) {
      try {
        listener(envelope);
      } catch (err) {
        this.logger.warn(
          `run event listener failed for run ${runId}: ${describeError(err)}`,
        );
      }
    }
    this.prune();
    return envelope;
  }

  replay(runId: string, afterSeq: number): RunEventEnvelope[] | null {
    const buffer = this.runs.get(runId);
    if (!buffer || !Number.isInteger(afterSeq)) return null;
    // Not a position this buffer issued or still covers: evicted, dropped and re-created, or another
    // process's id.
    if (afterSeq > buffer.lastSeq || afterSeq < buffer.floor) return null;
    return buffer.events.filter((envelope) => envelope.seq > afterSeq);
  }

  subscribe(runId: string, listener: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(runId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(runId);
    };
  }

  /**
   * The sequence a `run.snapshot` covers: the run's last event here, or — for a run with no buffer — the
   * process-wide cursor, so every later event of the run is numbered above it. (Not on the port:
   * `RunEventBus` is frozen in `core/ports/`; the SSE endpoint may inject this class.)
   */
  lastSeq(runId: string): number {
    return this.runs.get(runId)?.lastSeq ?? this.cursor;
  }

  private hasListeners(runId: string): boolean {
    return (this.listeners.get(runId)?.size ?? 0) > 0;
  }

  /** Drop finished, idle buffers past retention; past `maxRuns`, drop the stalest idle buffers. */
  private prune(): void {
    const now = this.now();
    for (const [runId, buffer] of this.runs) {
      if (
        buffer.finishedAt !== null &&
        !this.hasListeners(runId) &&
        now - buffer.finishedAt > this.retainMs
      ) {
        this.runs.delete(runId);
      }
    }
    if (this.runs.size <= this.maxRuns) return;
    const idle = [...this.runs.entries()]
      .filter(([runId]) => !this.hasListeners(runId))
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
