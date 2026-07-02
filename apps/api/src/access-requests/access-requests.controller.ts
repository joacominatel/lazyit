import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { AccessRequestStatusSchema } from '@lazyit/shared';
import { AccessRequestsService } from './access-requests.service';
import {
  AccessRequestDto,
  AccessRequestListPageDto,
  CreateAccessRequestDto,
  DenyAccessRequestDto,
} from './access-request.dto';
import { parseUuidQuery } from '../common/parse-uuid-query';
import { parseCuidQuery } from '../common/parse-cuid-query';
import { parsePageQuery } from '../common/parse-page-query';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { ServicePrincipalForbiddenGuard } from '../auth/service-principal-forbidden.guard';
import { isHumanPrincipal, type Principal } from '../auth/principal';

/**
 * AccessRequest endpoints — the self-service request → approve/deny → grant flow (ADR-0085), closing the
 * ADR-0023 deferral. Four surfaces:
 *   - `POST /access-requests`        — raise a request (`accessRequest:create`, human-only). Requester =
 *     the authenticated caller (never the body).
 *   - `GET  /access-requests`        — the estate-wide list (`accessRequest:read`; paged, ADR-0030).
 *   - `GET  /access-requests/mine`   — the caller's OWN requests (any authenticated human; self-scope
 *     carve-out — no `accessRequest:read` needed).
 *   - `POST /access-requests/:id/approve` + `/deny` — decide a request (`accessGrant:grant`, human-only;
 *     deny requires a reason). Approval creates the grant through the existing grant path.
 *
 * Human-only routes carry {@link ServicePrincipalForbiddenGuard}: a request is raised BY and decided BY a
 * human (`requesterId` / `decidedById` are User FKs — no service-account column), the KB-authorship /
 * import precedent (ADR-0069 §2). The list is a read surface gated by the permission, not human-scoped.
 */
@ApiTags('access-requests')
@Controller('access-requests')
export class AccessRequestsController {
  constructor(private readonly requests: AccessRequestsService) {}

  @Post()
  @RequirePermission('accessRequest:create')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary:
      'Raise a request for access to an application (any role incl VIEWER; human-only). 409 if you already have a pending request for it.',
  })
  @ApiCreatedResponse({ type: AccessRequestDto })
  @ApiConflictResponse({
    description: 'A pending request for this application already exists',
  })
  create(
    @Body() dto: CreateAccessRequestDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.requests.create(this.requireHumanId(principal), dto);
  }

  @Get()
  @RequirePermission('accessRequest:read')
  @ApiOperation({
    summary:
      'List access requests (paginated; newest first); filter by status / applicationId / requesterId.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: AccessRequestStatusSchema.options,
    description: 'Filter by lifecycle status (PENDING / APPROVED / DENIED).',
  })
  @ApiQuery({ name: 'applicationId', required: false })
  @ApiQuery({ name: 'requesterId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: AccessRequestListPageDto })
  findAll(
    @Query('status') status?: string,
    @Query('applicationId') applicationId?: string,
    @Query('requesterId') requesterId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.requests.findPage(
      {
        status: this.parseStatus(status),
        applicationId: parseCuidQuery(applicationId, 'applicationId'),
        requesterId: parseUuidQuery(requesterId, 'requesterId'),
      },
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get('mine')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary:
      "The caller's OWN access requests (any authenticated human; no accessRequest:read needed) — paginated, newest first.",
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: AccessRequestListPageDto })
  findMine(
    @CurrentPrincipal() principal?: Principal,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.requests.findMine(
      this.requireHumanId(principal),
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Post(':id/approve')
  @RequirePermission('accessGrant:grant')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary:
      'Approve a pending request — creates the access grant + marks it APPROVED in one transaction (accessGrant:grant, human-only). 409 if already decided.',
  })
  @ApiCreatedResponse({ type: AccessRequestDto })
  @ApiConflictResponse({ description: 'The request has already been decided' })
  approve(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.requests.approve(id, principal);
  }

  @Post(':id/deny')
  @RequirePermission('accessGrant:grant')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary:
      'Deny a pending request with a required reason (accessGrant:grant, human-only). 409 if already decided.',
  })
  @ApiCreatedResponse({ type: AccessRequestDto })
  @ApiConflictResponse({ description: 'The request has already been decided' })
  deny(
    @Param('id') id: string,
    @Body() dto: DenyAccessRequestDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.requests.deny(id, dto, principal);
  }

  /**
   * The authenticated HUMAN's `User.id`. The ServicePrincipalForbiddenGuard already 403s any service
   * account before we get here, so a present principal is a human; this is defence-in-depth (a
   * missing/non-human principal → 403 rather than a null requester). Requests are human-only (ADR-0085).
   */
  private requireHumanId(principal?: Principal): string {
    if (!isHumanPrincipal(principal)) {
      throw new ForbiddenException(
        'An authenticated human user is required to raise or list your access requests.',
      );
    }
    return principal.user.id;
  }

  /** Validate the optional `status` filter against the closed enum (→ 400 on an unknown value). */
  private parseStatus(
    status?: string,
  ): 'PENDING' | 'APPROVED' | 'DENIED' | undefined {
    if (status === undefined || status === '') return undefined;
    const result = AccessRequestStatusSchema.safeParse(status);
    if (!result.success) {
      throw new BadRequestException(
        `Invalid status. Expected one of: ${AccessRequestStatusSchema.options.join(', ')}`,
      );
    }
    return result.data;
  }
}
