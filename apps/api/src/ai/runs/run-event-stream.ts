import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { AI_RUN_TERMINAL_STATUSES, type AiRunEvent } from '@lazyit/shared';
import type { Request, Response } from 'express';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import type { RunEventEnvelope } from '../core/ports/run-event-bus.port';
import {
  InProcessRunEventBus,
  formatRunEventId,
  parseLastEventId,
} from '../runtime/run-event-bus';
import { describeError } from '../runtime/runtime.constants';
import { AiRunsService, runStatusOf } from './ai-runs.service';

/** A comment line every 15 s keeps proxies and the browser from timing the stream out (§4.6). */
export const AI_RUN_STREAM_HEARTBEAT_MS = 15_000;
/**
 * A stream is closed after this long even while the run goes on; the client reconnects with
 * `Last-Event-ID` and loses nothing. Bounds how long one request can hold a connection.
 */
export const AI_RUN_STREAM_MAX_LIFETIME_MS = 15 * 60_000;
/** Open streams per principal (a browser allows six per origin on HTTP/1.1; tabs and retries add up). */
export const AI_RUN_STREAM_MAX_PER_PRINCIPAL = 8;

/** DI token for {@link AiRunStreamOptions} (tests shorten the timers). */
export const AI_RUN_STREAM_OPTIONS = Symbol('AI_RUN_STREAM_OPTIONS');

export interface AiRunStreamOptions {
  heartbeatMs?: number;
  maxLifetimeMs?: number;
  maxPerPrincipal?: number;
}

/** After these the stream closes: the run is waiting for the user, or it is over. */
function closes(status: string): boolean {
  return (
    status === 'AWAITING_APPROVAL' ||
    (AI_RUN_TERMINAL_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * A live event that ends the stream: `run.finished` (it follows the terminal `run.status` and carries the
 * usage and the error, so the stream waits for it), or `run.status AWAITING_APPROVAL`.
 */
function closesOn(event: AiRunEvent): boolean {
  if (event.type === 'run.finished') return true;
  return event.type === 'run.status' && event.status === 'AWAITING_APPROVAL';
}

/**
 * THE RUN EVENT STREAM (`GET /ai/runs/:id/events`; synthesis §4.6; provider-and-runtime.md §9.3; ADR-0097
 * decision 6). A `text/event-stream` read with `fetch` + `Authorization: Bearer` (never `EventSource`,
 * never a token in the URL) — so it is authenticated and authorized by the global guards like any route.
 *
 * Order of operations, each step before the next:
 *   1. OWNERSHIP — the run is loaded through the runtime's `ownedRun`: anyone but its owner gets 404 and
 *      the bus is never touched (a run id is not a capability; the bus does no authorization).
 *   2. The per-principal stream cap (429 `RATE_LIMITED`), then the headers: `Content-Type:
 *      text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` — Caddy leaves
 *      this path unencoded and `reverse_proxy` flushes it (infra/caddy/Caddyfile, #1328) — and `: connected`.
 *   3. SUBSCRIBE FIRST, buffering, so nothing published while the replay or the snapshot is being built
 *      is lost.
 *   4. `Last-Event-ID: <runId>:<seq>` the buffer still covers → the events after it. Otherwise (no header,
 *      another run's id, a stale or foreign position) → a `run.snapshot` from Postgres whose `seq` was read
 *      before the load. Sequence numbers are increasing, not consecutive: they are compared, never counted.
 *   5. The buffered and then live events after the last one sent, each as `id: <runId>:<seq>`,
 *      `event: <type>`, `data: <json>`.
 *   6. CLOSE after `run.finished` or `run.status AWAITING_APPROVAL` (the client re-subscribes after
 *      deciding); after a snapshot, or a replay, when the run is already terminal or waiting; after the
 *      maximum lifetime; or when the client goes away — every path unsubscribes and clears the timers
 *      exactly once. A disconnect never affects the run: it continues and persists.
 */
@Injectable()
export class AiRunEventStream {
  private readonly logger = new Logger(AiRunEventStream.name);
  private readonly open = new Map<string, number>();
  private readonly heartbeatMs: number;
  private readonly maxLifetimeMs: number;
  private readonly maxPerPrincipal: number;

  constructor(
    private readonly bus: InProcessRunEventBus,
    private readonly runs: AiRunsService,
    @Optional()
    @Inject(AI_RUN_STREAM_OPTIONS)
    options: AiRunStreamOptions | null = null,
  ) {
    options ??= {};
    this.heartbeatMs = options.heartbeatMs ?? AI_RUN_STREAM_HEARTBEAT_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? AI_RUN_STREAM_MAX_LIFETIME_MS;
    this.maxPerPrincipal =
      options.maxPerPrincipal ?? AI_RUN_STREAM_MAX_PER_PRINCIPAL;
  }

  /** Streams currently open for a principal (tests and diagnostics). */
  openFor(identity: DelegatedIdentity): number {
    return this.open.get(keyOf(identity)) ?? 0;
  }

  async stream(input: {
    runId: string;
    identity: DelegatedIdentity;
    lastEventId: string | undefined;
    req: Request;
    res: Response;
  }): Promise<void> {
    const { runId, identity, req, res } = input;
    // 1. Ownership before anything touches the bus (404 for everyone else).
    const run = await this.runs.owned(runId, identity);

    // 2. The cap, then the stream.
    const key = keyOf(identity);
    const count = this.open.get(key) ?? 0;
    if (count >= this.maxPerPrincipal) {
      throw new HttpException(
        {
          code: 'RATE_LIMITED',
          message: 'Too many open event streams; close one and retry',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.open.set(key, count + 1);

    let closed = false;
    let ready = false;
    let lastSent = -1;
    const pending: RunEventEnvelope[] = [];
    const timers: NodeJS.Timeout[] = [];
    let unsubscribe: () => void = () => undefined;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const timer of timers) clearTimeout(timer);
      const left = (this.open.get(key) ?? 1) - 1;
      if (left <= 0) this.open.delete(key);
      else this.open.set(key, left);
    };
    const end = () => {
      cleanup();
      if (!res.writableEnded) res.end();
    };
    const write = (chunk: string) => {
      if (closed || res.writableEnded) return;
      res.write(chunk);
    };
    const send = (envelope: RunEventEnvelope, mayClose = true) => {
      if (closed || envelope.seq <= lastSent) return;
      lastSent = envelope.seq;
      write(frame(formatRunEventId(envelope), envelope.event));
      if (mayClose && closesOn(envelope.event)) end();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    write(': connected\n\n');

    timers.push(setInterval(() => write(': heartbeat\n\n'), this.heartbeatMs));
    timers.push(setTimeout(end, this.maxLifetimeMs));

    // 3. Subscribe first; hold what arrives until the replay or the snapshot is out.
    unsubscribe = this.bus.subscribe(runId, (envelope) => {
      if (closed) return;
      if (ready) send(envelope);
      else pending.push(envelope);
    });
    if (closed) {
      // The client left while we were setting up.
      unsubscribe();
      return;
    }

    try {
      // 4. Replay, or the snapshot.
      const after = parseLastEventId(runId, input.lastEventId);
      const replayed = after === null ? null : this.bus.replay(runId, after);
      let settledStatus: string | null = null;
      if (after !== null && replayed !== null) {
        lastSent = after;
        // A replay may cross a pause that is already over (AWAITING_APPROVAL, then the resume): send it
        // all, and let the run's CURRENT status decide whether the stream stays open.
        for (const envelope of replayed) {
          send(envelope, envelope.event.type === 'run.finished');
        }
        if (!closed) {
          const now = await this.runs.owned(runId, identity).catch(() => run);
          settledStatus = now.status;
        }
      } else {
        const seq = this.bus.lastSeq(runId);
        const snapshot = await this.runs.snapshot(run, seq);
        if (!closed) {
          lastSent = seq;
          write(frame(`${runId}:${seq}`, snapshot));
          settledStatus = snapshot.status;
        }
      }

      // 5. What arrived meanwhile, then live.
      ready = true;
      for (const envelope of pending.splice(0)) send(envelope);
      if (
        !closed &&
        settledStatus !== null &&
        closes(runStatusOf(settledStatus))
      ) {
        end();
      }
    } catch (err) {
      this.logger.warn(
        `AI run ${runId}: the event stream failed: ${describeError(err)}`,
      );
      end();
    }
  }
}

function keyOf(identity: DelegatedIdentity): string {
  return identity.kind === 'human'
    ? `u:${identity.userId}`
    : `sa:${identity.serviceAccountId}`;
}

/** One SSE frame. `JSON.stringify` never emits a raw line break, so `data` is a single line. */
function frame(id: string, event: AiRunEvent): string {
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
