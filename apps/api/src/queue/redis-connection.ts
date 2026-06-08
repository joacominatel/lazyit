import { Logger } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import IORedis, { type RedisOptions } from 'ioredis';

/**
 * Robust ioredis connection builder for the BullMQ/Valkey substrate (ADR-0053, issue #257).
 *
 * The naive `new IORedis(url, { maxRetriesPerRequest: null })` had three failure modes when
 * `REDIS_URL` was unset/wrong (the prod incident: a container falling back to localhost where no
 * Valkey runs):
 *   1. ioredis reconnected FOREVER (no `retryStrategy` cap) → an unstoppable `ECONNREFUSED` loop.
 *   2. Every reconnect logged an error (no throttle) → the log FLOOD.
 *   3. `queue.add` buffered the job in the offline queue and never errored → the import POST hung as
 *      a 202 that never resolved.
 *
 * This module fixes all three while staying compatible with BullMQ's connection requirements:
 *   - `maxRetriesPerRequest: null` is KEPT — BullMQ mandates it on the connection it duplicates for
 *     the Worker's BLOCKING commands (brpoplpush). Producer fail-fast is achieved orthogonally via
 *     `enableOfflineQueue: false` (a never-ready connection rejects writes IMMEDIATELY instead of
 *     buffering them). Verified against the BullMQ + ioredis docs.
 *   - A BOUNDED `retryStrategy` caps both the backoff and the number of attempts, then gives up
 *     (returns null) so reconnection is finite — no infinite loop.
 *   - The `error` event is THROTTLED: first error logged loudly, then at most one per interval, so a
 *     permanent outage can never flood the logs.
 *   - The resolved URL is logged at boot with any password REDACTED, so a misconfig is visible.
 */

/**
 * Default connection when `REDIS_URL` is unset (local dev without an explicit URL). 127.0.0.1 (not
 * `localhost`) so we never first try IPv6 `::1` (the `ECONNREFUSED ::1:6379` half of issue #257).
 */
export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';

/** Max reconnection attempts before ioredis gives up (bounded — never retry forever). */
export const REDIS_MAX_RECONNECT_ATTEMPTS = 20;
/** Cap on the per-attempt reconnect backoff (ms). */
export const REDIS_MAX_BACKOFF_MS = 3000;
/** Linear backoff step (ms) per attempt, capped by {@link REDIS_MAX_BACKOFF_MS}. */
export const REDIS_BACKOFF_STEP_MS = 200;
/** Minimum gap between throttled "still failing" error logs (ms) — the anti-flood window. */
export const REDIS_ERROR_LOG_THROTTLE_MS = 10_000;

/** The subset of NestJS `Logger` this module needs — narrowed so tests can pass a plain spy. */
export interface ConnectionLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Factory for the ioredis client; overridable in tests so no real socket is opened. */
export type RedisClientFactory = (
  url: string,
  options: RedisOptions,
) => IORedis;

export interface ResolvedRedisUrl {
  url: string;
  /** True when `REDIS_URL` was unset/blank and we fell back to {@link DEFAULT_REDIS_URL}. */
  usedDefault: boolean;
}

/** Resolve the effective Redis URL from the environment, reporting whether the default was used. */
export function resolveRedisUrl(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRedisUrl {
  const raw = env.REDIS_URL?.trim();
  if (raw) {
    return { url: raw, usedDefault: false };
  }
  return { url: DEFAULT_REDIS_URL, usedDefault: true };
}

/**
 * Redact any password (and ACL-style credentials) from a Redis URL before it is logged. NEVER log a
 * raw URL — it may carry a secret (`redis://user:password@host`). Falls back to a regex strip of the
 * userinfo segment when the URL is unparseable, so a malformed value still can't leak a secret.
 */
export function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    // Unparseable — defensively redact the whole `user:pass@` userinfo segment.
    return url.replace(/\/\/[^@/]*@/, '//***@');
  }
}

export interface RetryStrategyDeps {
  maxAttempts?: number;
  maxBackoffMs?: number;
  stepMs?: number;
  /** Called once, with the attempt count, when the strategy permanently gives up. */
  onGiveUp?: (attempts: number) => void;
}

/**
 * Build a BOUNDED ioredis `retryStrategy`: capped linear backoff, then a permanent give-up (returns
 * `null`) once {@link RetryStrategyDeps.maxAttempts} is exceeded. Returning `null` tells ioredis to
 * stop scheduling reconnections — the key to ending the infinite `ECONNREFUSED` loop. `onGiveUp`
 * fires exactly once so the operator gets a single CRITICAL line, not a stream.
 */
export function buildRetryStrategy(
  deps: RetryStrategyDeps = {},
): (times: number) => number | null {
  const maxAttempts = deps.maxAttempts ?? REDIS_MAX_RECONNECT_ATTEMPTS;
  const maxBackoffMs = deps.maxBackoffMs ?? REDIS_MAX_BACKOFF_MS;
  const stepMs = deps.stepMs ?? REDIS_BACKOFF_STEP_MS;
  let gaveUp = false;
  return (times: number): number | null => {
    if (times > maxAttempts) {
      if (!gaveUp) {
        gaveUp = true;
        deps.onGiveUp?.(times - 1);
      }
      return null;
    }
    return Math.min(times * stepMs, maxBackoffMs);
  };
}

/**
 * Build a throttled `error`-event handler: the FIRST error is logged loudly, then subsequent errors
 * are suppressed except at most one per `throttleMs` window (with a running count). This is what
 * stops the per-reconnect `ECONNREFUSED` log flood. `now` is injectable for deterministic tests.
 */
export function createErrorLogThrottler(
  logger: Pick<ConnectionLogger, 'error'>,
  throttleMs: number = REDIS_ERROR_LOG_THROTTLE_MS,
  now: () => number = Date.now,
): (err: Error) => void {
  let seen = 0;
  let lastLoggedAt = 0;
  return (err: Error): void => {
    seen += 1;
    const at = now();
    if (seen === 1) {
      lastLoggedAt = at;
      logger.error(
        `Redis/Valkey connection error: ${err.message}. The async queue (BullMQ) is unavailable; ` +
          `article imports will fail fast (503) until it recovers. (ADR-0053, issue #257)`,
      );
      return;
    }
    if (at - lastLoggedAt >= throttleMs) {
      lastLoggedAt = at;
      logger.error(
        `Redis/Valkey connection still failing (${seen} errors so far): ${err.message}`,
      );
    }
    // Otherwise: suppressed (throttled) — prevents the log flood.
  };
}

/**
 * The ioredis options for the shared BullMQ connection. Pure (no side effects) so the contract —
 * `maxRetriesPerRequest: null` (BullMQ blocking requirement) + `enableOfflineQueue: false` (producer
 * fail-fast) + a bounded `retryStrategy` — is unit-testable without opening a socket.
 */
export function redisConnectionOptions(
  retry: RetryStrategyDeps = {},
): RedisOptions {
  return {
    // KEEP null: BullMQ duplicates this connection for the Worker's BLOCKING commands and requires
    // null there (a finite value would make blocking reads throw). Producer fail-fast does NOT rely
    // on this — it relies on enableOfflineQueue:false below.
    maxRetriesPerRequest: null,
    // FAIL FAST on the producer: when the connection is not 'ready' (the #257 misconfig — wrong host,
    // ECONNREFUSED), queue.add() rejects IMMEDIATELY rather than buffering the job offline forever
    // (which made the import POST hang as a 202 that never resolved).
    enableOfflineQueue: false,
    // BOUNDED reconnection — capped backoff, finite attempts, then give up (no infinite loop).
    retryStrategy: buildRetryStrategy(retry),
  };
}

/** Wire the connection's lifecycle events to the logger (throttled errors; one-line ready/end). */
export function attachConnectionLogging(
  client: Pick<IORedis, 'on'>,
  logger: ConnectionLogger,
  redactedUrl: string,
): void {
  const logError = createErrorLogThrottler(logger);
  client.on('error', (err: Error) => logError(err));
  client.on('ready', () =>
    logger.log(
      `Connected to Redis/Valkey at ${redactedUrl}; async queue ready.`,
    ),
  );
  client.on('end', () =>
    logger.warn(`Redis/Valkey connection ended (${redactedUrl}).`),
  );
}

/**
 * Build the shared ioredis connection for BullMQ. Logs the resolved (redacted) URL at boot, installs
 * the bounded retry + throttled error logging, and returns the live client (cast to BullMQ's
 * `ConnectionOptions` — BullMQ reuses the instance and duplicates it for its subscriber/blocking
 * clients, the documented "reuse an ioredis connection" pattern).
 *
 * `createClient` is injectable so unit tests exercise the logging/wiring with a fake emitter and
 * never open a real socket.
 */
export function buildRedisConnection(
  env: NodeJS.ProcessEnv = process.env,
  logger: ConnectionLogger = new Logger('QueueModule'),
  createClient: RedisClientFactory = (url, options) =>
    new IORedis(url, options),
): ConnectionOptions {
  const { url, usedDefault } = resolveRedisUrl(env);
  const redactedUrl = redactRedisUrl(url);

  if (usedDefault) {
    logger.warn(
      `REDIS_URL is not set — falling back to ${redactedUrl}. Inside a container this points at the ` +
        `API container itself (no Valkey there) and will fail with ECONNREFUSED; set ` +
        `REDIS_URL=redis://valkey:6379. (ADR-0053, issue #257)`,
    );
  } else {
    logger.log(`BullMQ/Valkey connection target: ${redactedUrl}`);
  }

  const onGiveUp = (attempts: number): void => {
    logger.error(
      `Giving up reconnecting to Redis/Valkey at ${redactedUrl} after ${attempts} attempts. The ` +
        `async queue is DEGRADED: article imports return 503 until the broker is reachable and the ` +
        `API is restarted. Check REDIS_URL and that the 'valkey' service is up. (issue #257)`,
    );
  };

  const client = createClient(url, redisConnectionOptions({ onGiveUp }));
  attachConnectionLogging(client, logger, redactedUrl);

  return client as unknown as ConnectionOptions;
}

/**
 * True when an error from `queue.add` (or any producer command) means the broker is unreachable —
 * the signal to surface a clean 503 instead of a 500. Covers ioredis's offline-queue-disabled
 * rejection, a closed/ended connection, the MaxRetriesPerRequest error, and raw connect errnos.
 */
export function isQueueUnavailableError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err.name === 'MaxRetriesPerRequestError') {
    return true;
  }
  const code = (err as { code?: string }).code ?? '';
  if (
    [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ECONNRESET',
    ].includes(code)
  ) {
    return true;
  }
  return /enableOfflineQueue|Stream isn't writeable|Connection is closed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|getaddrinfo/i.test(
    err.message ?? '',
  );
}
