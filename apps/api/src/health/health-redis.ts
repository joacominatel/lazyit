import { Logger } from '@nestjs/common';
import IORedis, { type RedisOptions } from 'ioredis';
import {
  buildRetryStrategy,
  redactRedisUrl,
  resolveRedisUrl,
} from '../queue/redis-connection';

/**
 * Dedicated, low-priority Valkey/Redis probe connection for the readiness endpoint (OPS-6, ADR-0053).
 *
 * This is intentionally SEPARATE from the BullMQ producer connection ({@link buildRedisConnection}):
 * a `/health/ready` ping must never share — and so never perturb — the queue's blocking subscriber
 * connection. The probe is NON-GATING: Postgres is the system of record and the only readiness gate;
 * Valkey is transport, so a broker outage surfaces as `status: 'degraded'` (HTTP 200) on
 * `/health/ready`, never `ready: false`. The point is purely OBSERVABILITY — a broker outage that
 * silently broke async imports used to be invisible.
 */

/** DI token for the probe client so {@link HealthService} stays unit-testable with a plain stub. */
export const HEALTH_REDIS = Symbol('HEALTH_REDIS');

/** A `ping` that connects but stalls must still fail within this window (ms) — a wedged broker reads as down. */
export const HEALTH_PING_TIMEOUT_MS = 1_000;

/** Minimum gap between throttled probe-error logs (ms). Longer than the queue's: the probe is informational. */
export const HEALTH_REDIS_ERROR_LOG_THROTTLE_MS = 30_000;

/** The narrow surface {@link HealthService} needs — so tests inject a plain `{ ping }` stub, no socket. */
export interface HealthRedisClient {
  ping(): Promise<string>;
}

/** Factory for the ioredis client; overridable in tests so no real socket is opened. */
export type HealthRedisClientFactory = (
  url: string,
  options: RedisOptions,
) => IORedis;

/**
 * ioredis options for the probe connection. FAIL FAST (`enableOfflineQueue: false`) so a ping rejects
 * immediately when the broker is unreachable instead of buffering; `commandTimeout` bounds a connected
 * but wedged broker; a BOUNDED `retryStrategy` (shared with the queue client) means reconnection is
 * finite — never an infinite ECONNREFUSED loop.
 */
export function healthRedisOptions(): RedisOptions {
  return {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: HEALTH_PING_TIMEOUT_MS,
    retryStrategy: buildRetryStrategy(),
    connectionName: 'lazyit-health-probe',
  };
}

/**
 * Build the probe ioredis client: resolves `REDIS_URL` (same logic as the queue), installs a throttled
 * error logger (ioredis is an EventEmitter — an `error` with NO listener would crash the process), and
 * returns the live client. `createClient` is injectable so unit tests never open a real socket.
 */
export function buildHealthRedisClient(
  env: NodeJS.ProcessEnv = process.env,
  logger: Pick<Logger, 'log' | 'error'> = new Logger('HealthValkeyProbe'),
  createClient: HealthRedisClientFactory = (url, options) =>
    new IORedis(url, options),
): IORedis {
  const { url } = resolveRedisUrl(env);
  const redacted = redactRedisUrl(url);
  const client = createClient(url, healthRedisOptions());

  let lastLoggedAt = 0;
  client.on('error', (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt >= HEALTH_REDIS_ERROR_LOG_THROTTLE_MS) {
      lastLoggedAt = now;
      logger.error(
        `Valkey health probe cannot reach ${redacted}: ${err.message}. /health/ready will report the ` +
          `queue as DEGRADED (non-gating — readiness still tracks Postgres only). (OPS-6, ADR-0053)`,
      );
    }
  });
  logger.log(`Valkey health probe target: ${redacted}`);
  return client;
}
