import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { DashboardSummary, RecentActivityQuery } from '@lazyit/shared';
import {
  ACTIVITY_ACTOR_ME,
  RECENT_ACTIVITY_ACTIONS,
  RecentActivityQuerySchema,
} from '@lazyit/shared';
import { DashboardService } from './dashboard.service';
import {
  DashboardSummaryDto,
  RecentActivityFilterOptionsDto,
  RecentActivityPageDto,
} from './dashboard.dto';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { isHumanPrincipal, type Principal } from '../auth/principal';

const RECENT_ACTIVITY_ACTIONS_LIST = RECENT_ACTIVITY_ACTIONS.join(', ');

const DEFAULT_EXPIRING_WITHIN_DAYS = 30;
const MIN_EXPIRING_WITHIN_DAYS = 1;
const MAX_EXPIRING_WITHIN_DAYS = 365;

@ApiTags('dashboard')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @RequirePermission('dashboard:read')
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

  @Get('activity/filters')
  @RequirePermission('logs:read')
  @ApiOperation({
    summary:
      'Distinct filter menus for the Reports actor/action selects (issue #718): the actors (id + name) and actions actually present in the recent_activity feed, so the UI offers only what happened — not the whole user directory or the full action allowlist. Gated on logs:read like the feed.',
  })
  @ApiOkResponse({ type: RecentActivityFilterOptionsDto })
  async activityFilters() {
    return this.dashboard.getActivityFilterOptions();
  }

  @Get('activity')
  @RequirePermission('logs:read')
  @ApiOperation({
    summary:
      'Unified recent-activity feed (newest first, paginated), gated on logs:read (issue #181): one chronological stream merging AssetHistory, AssetAssignment (assigned/released), AccessGrant (granted/revoked) and ConsumableMovement (stock in/out/adjustment), backed by the recent_activity DB view. Actor display name resolved where available. All filters are optional and additive — with none the feed is identical to before.',
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
  @ApiQuery({
    name: 'entityType',
    required: false,
    enum: ['asset', 'application', 'consumable'],
    description: 'Restrict to one pillar.',
  })
  @ApiQuery({
    name: 'entityId',
    required: false,
    type: String,
    description: "Restrict to one affected entity's id (exact match).",
  })
  @ApiQuery({
    name: 'actorId',
    required: false,
    type: String,
    description:
      'A user uuid, or the literal "me" (resolved to the authenticated caller server-side).',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    enum: RECENT_ACTIVITY_ACTIONS,
    description: `One known activity verb. Unknown verb → 400. Allowed: ${RECENT_ACTIVITY_ACTIONS_LIST}.`,
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description:
      'Inclusive lower bound (ISO-8601) of the occurredAt window. Closed-open [from, to).',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description:
      'Exclusive upper bound (ISO-8601) of the occurredAt window. Closed-open [from, to).',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    type: String,
    description:
      'Free text (max 200) matched case-insensitively against the summary and the actor name.',
  })
  @ApiOkResponse({ type: RecentActivityPageDto })
  async activity(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    const query = this.parseActivityQuery(
      { limit, offset, page, entityType, entityId, actorId, action, from, to, q },
      principal,
    );
    return this.dashboard.getActivity(query);
  }

  /**
   * Parse + validate the recent-activity query (issue #181). Mirrors {@link parsePageQuery}: the
   * global ZodValidationPipe only validates `@Body()`, so the raw `@Query` strings are otherwise
   * unchecked. A malformed value (bad limit/offset, unknown `action`, non-ISO `from`/`to`, a non-uuid
   * / non-"me" `actorId`, an over-long `q`) is a clean **400**.
   *
   * `actorId="me"` is resolved SERVER-SIDE to the caller's own user id BEFORE validation — the client
   * never supplies the actor for "my activity". Only a human principal has an actor identity in this
   * feed (the view's `actorId` is a `users.id`); a service-account / anonymous caller asking for "me"
   * has no such identity, so it is a 400 rather than a silent empty page.
   */
  private parseActivityQuery(
    raw: {
      limit?: string;
      offset?: string;
      page?: string;
      entityType?: string;
      entityId?: string;
      actorId?: string;
      action?: string;
      from?: string;
      to?: string;
      q?: string;
    },
    principal?: Principal,
  ): RecentActivityQuery {
    // Resolve the `"me"` self-reference to the caller's uuid up front, so the schema only ever sees a
    // concrete uuid (or a real client-supplied uuid). Never trust a client-supplied actor for "me".
    let resolvedActorId = raw.actorId;
    if (raw.actorId === ACTIVITY_ACTOR_ME) {
      if (!isHumanPrincipal(principal)) {
        throw new BadRequestException(
          'actorId="me" requires an authenticated human caller.',
        );
      }
      resolvedActorId = principal.user.id;
    }

    const result = RecentActivityQuerySchema.safeParse({
      ...raw,
      actorId: resolvedActorId,
    });
    if (!result.success) {
      throw new BadRequestException(
        `Invalid activity query: limit (1-200), offset (>=0), page (>=1) must be integers; entityType must be asset|application|consumable; actorId must be a uuid or "me"; action must be one of ${RECENT_ACTIVITY_ACTIONS_LIST}; from/to must be ISO-8601 datetimes; q max 200 chars`,
      );
    }
    return result.data;
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
