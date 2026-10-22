import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AccessRequestStatusSchema } from '@lazyit/shared';
import {
  AccessRequestsService,
  type FindAccessRequestsFilters,
} from './access-requests.service';
import { accessRequestExportColumns } from './access-request-export';
import {
  AccessRequestDto,
  AccessRequestListPageDto,
  MyAccessRequestListPageDto,
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
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { ExportService } from '../common/export';

/**
 * AccessRequest endpoints — the self-service request → approve/deny → grant flow (ADR-0085), closing the
 * ADR-0023 deferral. Four surfaces:
 *   - `POST /access-requests`        — raise a request (`accessRequest:create`, human-only). Requester =
 *     the caller, or `requesterId` when an `accessGrant:grant` holder files on that person's behalf (#1645).
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
  constructor(
    private readonly requests: AccessRequestsService,
    private readonly exports: ExportService,
    private readonly permissions: PermissionResolverService,
  ) {}

  @Post()
  @RequirePermission('accessRequest:create')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary:
      'Raise a request for access to an application (any role incl VIEWER; human-only). 409 if a pending request for it already exists. `requesterId` files it on behalf of another active person and needs accessGrant:grant (403 ACCESS_REQUEST_ON_BEHALF_FORBIDDEN); the caller is recorded as filedById.',
  })
  @ApiCreatedResponse({ type: AccessRequestDto })
  @ApiConflictResponse({
    description: 'A pending request for this application already exists',
  })
  async create(
    @Body() dto: CreateAccessRequestDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    const callerId = this.requireHumanId(principal);
    const onBehalf =
      dto.requesterId !== undefined && dto.requesterId !== callerId;
    if (
      onBehalf &&
      !(await this.permissions.principalHas(principal, 'accessGrant:grant'))
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ACCESS_REQUEST_ON_BEHALF_FORBIDDEN',
        message:
          'Only someone who can approve access requests can file one on behalf of another person.',
      });
    }
    return this.requests.create(callerId, dto);
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
      this.parseFilters(status, applicationId, requesterId),
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get('export')
  @RequirePermission('accessRequest:read')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      'CSV export of every access request matching the list filters (ADR-0103): same permission, filters and rows as GET /access-requests, newest first. Names need user:read / application:read, otherwise the id. Refused above 100,000 rows (422); one running export and five a minute per caller (429). Every export is audited.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: AccessRequestStatusSchema.options,
  })
  @ApiQuery({ name: 'applicationId', required: false })
  @ApiQuery({ name: 'requesterId', required: false })
  @ApiOkResponse({
    description: 'The filtered access requests as CSV (text/csv).',
  })
  async export(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
    @Query('status') status?: string,
    @Query('applicationId') applicationId?: string,
    @Query('requesterId') requesterId?: string,
  ): Promise<StreamableFile> {
    const filters = this.parseFilters(status, applicationId, requesterId);
    const [users, applications] = await Promise.all([
      this.permissions.principalHas(principal, 'user:read'),
      this.permissions.principalHas(principal, 'application:read'),
    ]);
    return this.exports.exportCsv({
      resource: 'ACCESS_REQUESTS',
      principal,
      response: res,
      filters: { ...filters },
      columns: accessRequestExportColumns({ users, applications }),
      filename: 'access-requests',
      ...this.requests.exportSource(filters),
    });
  }

  @Get('mine')
  @UseGuards(ServicePrincipalForbiddenGuard)
  @ApiOperation({
    summary:
      "The caller's OWN access requests (any authenticated human; no accessRequest:read needed) — paginated, newest first. An approved request carries the coarse `provisioning` status of its grant (NONE, IN_PROGRESS, DONE, WAITING_ON_IT); null otherwise.",
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: MyAccessRequestListPageDto })
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

  private parseFilters(
    status?: string,
    applicationId?: string,
    requesterId?: string,
  ): FindAccessRequestsFilters {
    return {
      status: this.parseStatus(status),
      applicationId: parseCuidQuery(applicationId, 'applicationId'),
      requesterId: parseUuidQuery(requesterId, 'requesterId'),
    };
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
