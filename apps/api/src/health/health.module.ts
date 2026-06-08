import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { HEALTH_REDIS, buildHealthRedisClient } from './health-redis';

/**
 * Health/ops probes module (hand-rolled — no @nestjs/terminus dependency). PrismaService is provided
 * globally (PrismaModule is @Global), so HealthService injects it without importing PrismaModule. The
 * HEALTH_REDIS provider is a DEDICATED, low-priority Valkey probe connection (OPS-6/ADR-0053) — kept
 * separate from the BullMQ producer connection so a readiness ping never perturbs the queue; it backs
 * the NON-GATING `valkey` field on `/health/ready`.
 */
@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    { provide: HEALTH_REDIS, useFactory: () => buildHealthRedisClient() },
  ],
})
export class HealthModule {}
