import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { DashboardSummary } from '@lazyit/shared';
import { DashboardService } from './dashboard.service';

const DEFAULT_EXPIRING_WITHIN_DAYS = 30;
const MIN_EXPIRING_WITHIN_DAYS = 1;
const MAX_EXPIRING_WITHIN_DAYS = 365;

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary:
      'Read-only aggregation across the three pillars: assets by status + assigned count, active/expiring/critical grants, consumable low-stock, articles published vs draft, and a recent AssetHistory slice.',
  })
  @ApiQuery({
    name: 'expiringWithinDays',
    required: false,
    type: Number,
    description: `Look-ahead window for "grants expiring soon" (${MIN_EXPIRING_WITHIN_DAYS}-${MAX_EXPIRING_WITHIN_DAYS}). Default ${DEFAULT_EXPIRING_WITHIN_DAYS}.`,
  })
  async summary(
    @Query('expiringWithinDays') expiringWithinDays?: string,
  ): Promise<DashboardSummary> {
    return this.dashboard.getSummary(parseExpiringWithinDays(expiringWithinDays));
  }
}

/**
 * Clamp `expiringWithinDays` to {@link MIN_EXPIRING_WITHIN_DAYS}..{@link MAX_EXPIRING_WITHIN_DAYS};
 * non-numeric/absent -> {@link DEFAULT_EXPIRING_WITHIN_DAYS}.
 */
function parseExpiringWithinDays(raw?: string): number {
  if (raw === undefined) return DEFAULT_EXPIRING_WITHIN_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_EXPIRING_WITHIN_DAYS;
  return Math.min(
    MAX_EXPIRING_WITHIN_DAYS,
    Math.max(MIN_EXPIRING_WITHIN_DAYS, Math.trunc(parsed)),
  );
}
