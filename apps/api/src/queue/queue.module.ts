import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import type { ConnectionOptions } from 'bullmq';
import IORedis from 'ioredis';

/**
 * Async workers foundation (ADR-0053). Registers the shared BullMQ connection used by every queue
 * in the app; feature modules add their queues with `BullModule.registerQueue(...)`. The engine is a
 * self-hosted Valkey (Redis-compatible) reached over `REDIS_URL`; the client is ioredis (the only
 * place ioredis is allowed at the app layer — ADR-0009 carve-out). A sibling devops change provides
 * the Valkey service + `REDIS_URL`; this module only consumes the env.
 *
 * Architectural note: PostgreSQL stays the system of record; BullMQ is transport. A job's external
 * (parse) failure must never roll back unrelated local state.
 */

/** Default connection when `REDIS_URL` is unset (local dev without an explicit URL). */
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/**
 * Build the ioredis connection from `REDIS_URL`. BullMQ requires `maxRetriesPerRequest: null` on the
 * connection it uses for blocking commands, so we set it here. A single instance is shared with the
 * queues/workers; BullMQ duplicates it as needed for its blocking connections.
 */
export function buildRedisConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
  // BullMQ bundles its own ioredis copy, so the instance type differs from this app's direct ioredis
  // dependency only at the type level — the runtime client is fully compatible. Bridge that
  // duplicate-package type skew with a single cast here (not a behavior change).
  return new IORedis(url, {
    maxRetriesPerRequest: null,
  }) as unknown as ConnectionOptions;
}

@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => ({ connection: buildRedisConnection() }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
