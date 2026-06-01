import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { DashboardSummary } from '@lazyit/shared';
import { DashboardService } from './dashboard.service';
import { parsePageQuery } from '../common/parse-page-query';
import { DashboardSummaryDto, RecentActivityPageDto } from './dashboard.dto';

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
  @ApiOkResponse({ type: DashboardSummaryDto })
  async summary(
    @Query('expiringWithinDays') expiringWithinDays?: string,
  ): Promise<DashboardSummary> {
    return this.dashboard.getSummary(parseExpiringWithinDays(expiringWithinDays));
  }

  @Get('activity')
  @ApiOperation({
    summary:
      'Unified recent-activity feed (newest first, paginated): one chronological stream merging AssetHistory, AssetAssignment (assigned/released), AccessGrant (granted/revoked) and ConsumableMovement (stock in/out/adjustment), backed by the recent_activity DB view. Actor display name resolved where available.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description:
      'Page size. Default 50, max 200 (ADR-0030). The web requests ~20.',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Zero-based offset. Mutually redundant with page.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based page number (alternative to offset).',
  })
  @ApiOkResponse({ type: RecentActivityPageDto })
  async activity(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.dashboard.getActivity(parsePageQuery({ limit, offset, page }));
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
