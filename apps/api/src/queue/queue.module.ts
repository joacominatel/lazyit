import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { buildRedisConnection } from './redis-connection';

/**
 * Async workers foundation (ADR-0053). Registers the shared BullMQ connection used by every queue
 * in the app; feature modules add their queues with `BullModule.registerQueue(...)`. The engine is a
 * self-hosted Valkey (Redis-compatible) reached over `REDIS_URL`; the client is ioredis (the only
 * place ioredis is allowed at the app layer — ADR-0009 carve-out). A sibling devops change provides
 * the Valkey service + `REDIS_URL`; this module only consumes the env.
 *
 * Architectural note: PostgreSQL stays the system of record; BullMQ is transport. A job's external
 * (parse) failure must never roll back unrelated local state.
 *
 * Connection ROBUSTNESS (issue #257) lives in {@link buildRedisConnection} (./redis-connection.ts):
 * the resolved URL is logged redacted at boot, reconnection is bounded (no infinite ECONNREFUSED
 * loop), error logs are throttled (no flood), and `enableOfflineQueue: false` makes producer
 * enqueues fail fast (a 503 on the import POST instead of a hung 202) when Valkey is unreachable.
 */

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
