import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Read-only dashboard aggregation (CTO Round 1). Hosts `GET /dashboard/summary`, a single typed
 * snapshot composing cheap counts/groupBys across the three pillars. No persisted state, no schema
 * change — PrismaService comes from the global PrismaModule.
 */
@Module({
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
