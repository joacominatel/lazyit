import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Health/ops probes module (hand-rolled — no @nestjs/terminus dependency). PrismaService is provided
 * globally (PrismaModule is @Global), so HealthService injects it without importing PrismaModule.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
