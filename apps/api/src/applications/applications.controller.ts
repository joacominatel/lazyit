import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AccessGrantListPageSchema,
  ApplicationGrantStatusSchema,
  ApplicationGrantSummarySchema,
  ApplicationListPageSchema,
  ApplicationSchema,
  ArticleListPageSchema,
  ArticleStatusSchema,
  CreateApplicationSchema,
  UpdateApplicationSchema,
} from '@lazyit/shared';
import {
  ApplicationsService,
  APPLICATION_SORT_ALLOWLIST,
  type ApplicationFilters,
} from './applications.service';
import { ArticlesService } from '../articles/articles.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { AccessGrantsExportService } from '../access-grants/access-grants-export.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parseCuidArrayQuery } from '../common/parse-cuid-array-query';
import { parseCuidQuery } from '../common/parse-cuid-query';
import { parseEnumArrayQuery } from '../common/parse-enum-array-query';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { ExportService } from '../common/export';
import { APPLICATION_EXPORT_COLUMNS } from './applications-export';
import { AccessGrantDto } from '../access-grants/access-grant.dto';
import {
  parseApplicationGrantQuery,
  type ApplicationGrantQuery,
} from '../access-grants/application-grant-query';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

class ApplicationDto extends createZodDto(ApplicationSchema) {}
class ApplicationListPageDto extends createZodDto(ApplicationListPageSchema) {}
class CreateApplicationDto extends createZodDto(CreateApplicationSchema) {}
class UpdateApplicationDto extends createZodDto(UpdateApplicationSchema) {}
// Reverse KB lookup (ADR-0042 / #220): the lean, paginated article-list envelope for
// GET /applications/:id/articles (a Page<ArticleListItem>, no markdown content).
class ArticleListPageDto extends createZodDto(ArticleListPageSchema) {}
// #1660: one page of an application's grants, and the headline numbers the Access tab shows.
class AccessGrantListPageDto extends createZodDto(AccessGrantListPageSchema) {}
class ApplicationGrantSummaryDto extends createZodDto(
  ApplicationGrantSummarySchema,
) {}

/** The query params of the per-application grant filters (#1660), shared by the page and the export. */
const GRANT_FILTER_QUERIES = [
  {
    name: 'status',
    required: false,
    enum: ApplicationGrantStatusSchema.options,
    description:
      'active (not revoked) | expiring (not revoked, expires within 30 days or already past expiry) | revoked | all. Unknown value → 400.',
  },
  {
    name: 'accessLevel',
    required: false,
    description:
      'Exact access level (1-100 characters). Cannot be combined with noAccessLevel.',
  },
  {
    name: 'noAccessLevel',
    required: false,
    type: Boolean,
    description: 'true = only grants with no access level.',
  },
  {
    name: 'q',
    required: false,
    description:
      "Person search: each whitespace-separated token must match the grantee's first name, last name or email (case-insensitive). Needs user:read as well (403 otherwise). At most 200 characters.",
  },
] as const;

@ApiTags('applications')
@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly grants: AccessGrantsService,
    private readonly articles: ArticlesService,
    private readonly grantExports: AccessGrantsExportService,
    private readonly exports: ExportService,
    private readonly permissions: PermissionResolverService,
  ) {}

  /**
   * A person search reads the user directory (names and emails), so it needs `user:read` on top of
   * `accessGrant:read` — otherwise `q` would be an oracle on directory data the caller cannot list
   * (the grant export keeps ids for the same caller). #1660.
   */
  private async assertCanSearchPeople(
    filters: ApplicationGrantQuery,
    principal: Principal,
  ): Promise<void> {
    if (
      filters.q !== undefined &&
      !(await this.permissions.principalHas(principal, 'user:read'))
    ) {
      throw new ForbiddenException(
        'Searching grants by person needs the user:read permission',
      );
    }
  }

  @Get()
  @RequirePermission('application:read')
  @ApiOperation({
    summary:
      'List applications (paginated; active by default). Server-side q search, category and criticality filters + sort. deleted=only lists archived rows (ADMIN).',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on name, vendor, url and description',
  })
  @ApiQuery({
    name: 'categoryId',
    required: false,
    description:
      'Only applications filed under this category (an archived category still matches). Invalid cuid → 400.',
  })
  @ApiQuery({
    name: 'isCritical',
    required: false,
    enum: ['true', 'false'],
    description:
      'Criticality filter: true = critical only; false = non-critical only; absent = both. Any other value → 400.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size. Default 50, max 200 (ADR-0030).',
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
    name: 'sort',
    required: false,
    enum: Object.keys(APPLICATION_SORT_ALLOWLIST),
    description:
      'Server-side sort field. Unknown field → 400. Default: name asc.',
  })
  @ApiQuery({
    name: 'dir',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort direction (default asc when sort is set).',
  })
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description:
      'Soft-delete slice. active (default) = live rows; only = archived (soft-deleted) rows — ADMIN only (403 otherwise). (ADR-0041)',
  })
  @ApiOkResponse({ type: ApplicationListPageDto })
  findAll(
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('isCritical') isCritical?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('deleted') deleted?: string,
    @CurrentUser() user?: User,
  ) {
    const pageQuery = parsePageQuery({
      limit,
      offset,
      page,
      sort,
      dir,
      deleted,
    });
    // The list route carries no @Roles (any authenticated user may list ACTIVE rows), so gate the
    // privileged archived slice here: deleted=only is ADMIN-only (403 otherwise). (ADR-0041)
    assertCanListDeleted(pageQuery.deleted, user);
    return this.applications.findPage(
      this.parseFilters(q, categoryId, isCritical),
      pageQuery,
    );
  }

  /** The list's filters, parsed once for GET /applications and its export so the two cannot drift. */
  private parseFilters(
    q: string | undefined,
    categoryId: string | undefined,
    isCritical: string | undefined,
  ): ApplicationFilters {
    return {
      q,
      categoryId: parseCuidQuery(categoryId, 'categoryId'),
      isCritical:
        isCritical !== undefined
          ? this.parseIsCriticalQuery(isCritical)
          : undefined,
    };
  }

  /** Exactly "true" or "false": a raw @Query is otherwise unchecked, so anything else is a clean 400. */
  private parseIsCriticalQuery(raw: string): boolean {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new BadRequestException(
      'Invalid isCritical filter: must be "true" or "false"',
    );
  }

  // STATIC route declared BEFORE `:id` so `/applications/export` never resolves as an id.
  @Get('export')
  @RequirePermission('application:read')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      'CSV export of every application matching the list filters (ADR-0103): same permission, filters and rows as GET /applications, newest first. Refused above 100,000 rows (422); one running export and five a minute per caller (429). Every export is audited. deleted=only is ADMIN only (403 otherwise).',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'isCritical', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'deleted', required: false, enum: ['active', 'only'] })
  @ApiOkResponse({
    description: 'The filtered applications as CSV (text/csv).',
  })
  export(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('isCritical') isCritical?: string,
    @Query('deleted') deleted?: string,
    @CurrentUser() user?: User,
  ): Promise<StreamableFile> {
    const { deleted: slice } = parsePageQuery({ deleted });
    assertCanListDeleted(slice, user);
    const filters = this.parseFilters(q, categoryId, isCritical);
    return this.exports.exportCsv({
      resource: 'APPLICATIONS',
      principal,
      response: res,
      filters: { ...filters, deleted: slice },
      columns: APPLICATION_EXPORT_COLUMNS,
      filename: 'applications',
      ...this.applications.exportSource(filters, slice),
    });
  }

  @Get(':id')
  @RequirePermission('application:read')
  @ApiOperation({ summary: 'Get an application by id' })
  @ApiOkResponse({ type: ApplicationDto })
  findOne(@Param('id') id: string) {
    return this.applications.findOne(id);
  }

  // The access-MAP for this application (who can reach it) is access-grant data, so it is gated on
  // `accessGrant:read` (ADR-0046 pre-tightened) — a VIEWER cannot enumerate it, even via an app.
  @Get(':id/access-grants')
  @RequirePermission('accessGrant:read')
  @ApiOperation({
    summary: "List an application's access grants (active-only by default)",
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include revoked grants.',
  })
  @ApiQuery({
    name: 'includeExpired',
    required: false,
    type: Boolean,
    description:
      'Default true. Pass false to hide active grants already past their expiresAt.',
  })
  @ApiOkResponse({ type: [AccessGrantDto] })
  async findGrants(
    @Param('id') id: string,
    @Query('activeOnly') activeOnly?: string,
    @Query('includeExpired') includeExpired?: string,
  ) {
    await this.applications.findOne(id); // 404 if the application is missing or soft-deleted
    return this.grants.findAll({
      applicationId: id,
      activeOnly: parseBooleanQuery(activeOnly, true),
      includeExpired: parseBooleanQuery(includeExpired, true),
    });
  }

  @Get(':id/access-grants/page')
  @RequirePermission('accessGrant:read')
  @ApiOperation({
    summary:
      "One page of an application's access grants, filtered server-side by status, access level and person (#1660, ADR-0030). The order follows the status: by person for active/all, soonest expiry for expiring, newest revocation for revoked. No sort param.",
  })
  @ApiQuery(GRANT_FILTER_QUERIES[0])
  @ApiQuery(GRANT_FILTER_QUERIES[1])
  @ApiQuery(GRANT_FILTER_QUERIES[2])
  @ApiQuery(GRANT_FILTER_QUERIES[3])
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size. Default 50, max 200 (ADR-0030).',
  })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: AccessGrantListPageDto })
  async findGrantsPage(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Query('status') status?: string,
    @Query('accessLevel') accessLevel?: string,
    @Query('noAccessLevel') noAccessLevel?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
  ) {
    await this.applications.findOne(id); // 404 if the application is missing or soft-deleted
    if (sort !== undefined) {
      throw new BadRequestException(
        'This list has no sort param: its order follows the status filter',
      );
    }
    const filters = parseApplicationGrantQuery({
      status,
      accessLevel,
      noAccessLevel,
      q,
    });
    await this.assertCanSearchPeople(filters, principal);
    return this.grants.findApplicationPage(
      { ...filters, applicationId: id, status: filters.status ?? 'active' },
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get(':id/access-grants/summary')
  @RequirePermission('accessGrant:read')
  @ApiOperation({
    summary:
      "Headline numbers of an application's grants over all of them (#1660): a count per status view plus expired, the access levels in use, and how many offboarded people still hold an active grant (null without user:read).",
  })
  @ApiOkResponse({ type: ApplicationGrantSummaryDto })
  async grantsSummary(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.applications.findOne(id); // 404 if the application is missing or soft-deleted
    return this.grants.applicationSummary(id, {
      canReadUsers: await this.permissions.principalHas(principal, 'user:read'),
    });
  }

  @Get(':id/access-grants/export')
  @RequirePermission('accessGrant:read')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      "CSV export of an application's grants, same filters and rows as GET /applications/:id/access-grants/page (status, accessLevel, noAccessLevel, q — #1660) or, for older clients, GET /applications/:id/access-grants (activeOnly, includeExpired); the two families cannot be mixed (400). ADR-0103. Audited; above 100,000 rows → 422; a parallel or sixth export in a minute → 429.",
  })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'includeExpired', required: false, type: Boolean })
  @ApiQuery(GRANT_FILTER_QUERIES[0])
  @ApiQuery(GRANT_FILTER_QUERIES[1])
  @ApiQuery(GRANT_FILTER_QUERIES[2])
  @ApiQuery(GRANT_FILTER_QUERIES[3])
  @ApiOkResponse({ description: "The application's grants as CSV (text/csv)." })
  async exportGrants(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
    @Query('activeOnly') activeOnly?: string,
    @Query('includeExpired') includeExpired?: string,
    @Query('status') status?: string,
    @Query('accessLevel') accessLevel?: string,
    @Query('noAccessLevel') noAccessLevel?: string,
    @Query('q') q?: string,
  ): Promise<StreamableFile> {
    await this.applications.findOne(id); // 404 if the application is missing or soft-deleted
    const filters = parseApplicationGrantQuery({
      status,
      accessLevel,
      noAccessLevel,
      q,
    });
    if (
      filters.status !== undefined &&
      (activeOnly !== undefined || includeExpired !== undefined)
    ) {
      throw new BadRequestException(
        'Send either status or activeOnly/includeExpired, not both',
      );
    }
    await this.assertCanSearchPeople(filters, principal);
    // `status` replaces activeOnly/includeExpired, so they are only part of the query (and the audit
    // row) when `status` is absent. The audit records `noAccessLevel: true` rather than a null level,
    // which the audit sanitizer would drop as "any level" (ADR-0103 §10).
    const query = {
      applicationId: id,
      ...(filters.status === undefined
        ? {
            activeOnly: parseBooleanQuery(activeOnly, true),
            includeExpired: parseBooleanQuery(includeExpired, true),
          }
        : {}),
      ...filters,
    };
    const audit: Record<string, unknown> = { ...query };
    if (query.accessLevel === null) {
      delete audit.accessLevel;
      audit.noAccessLevel = true;
    }
    return this.grantExports.export(query, principal, response, audit);
  }

  @Get(':id/articles')
  @RequirePermission('article:read')
  @ApiOperation({
    summary:
      "List the PUBLISHED knowledge-base articles linked to this application ('the runbook for THIS app'; paginated + filterable). (ADR-0042 / ADR-0030 / #220)",
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Case-insensitive substring match on title and excerpt.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...ArticleStatusSchema.options],
    isArray: true,
    description:
      'Filter by status. Multi-value (#198): comma-separated or repeated; values OR-combine. Unknown value → 400. The list is always PUBLISHED-only, so this only narrows within PUBLISHED (a draft never surfaces here).',
  })
  @ApiQuery({
    name: 'categoryId',
    required: false,
    description:
      'Filter by category. Multi-value (#198): comma-separated (categoryId=cuid1,cuid2) or repeated; values OR-combine. Each element must be a cuid — an invalid element → 400.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size. Default 50, max 200 (ADR-0030).',
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
  @ApiOkResponse({ type: ArticleListPageDto })
  async findArticles(
    @Param('id') id: string,
    @Query('q') q?: string,
    // Multi-value filters (#198) arrive comma-encoded (one param) OR repeated (Nest hands a string[]).
    @Query('status') status?: string | string[],
    @Query('categoryId') categoryId?: string | string[],
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    // Folder access (ADR-0060 §4 / INV-9 — #553): thread the caller so the reverse list is pinned to
    // the folders this actor may see (a restricted article never leaks through the link scope).
    @CurrentPrincipal() principal?: Principal,
  ) {
    await this.applications.findOne(id); // 404 if the application is missing or soft-deleted
    return this.articles.findArticlesForApplication(
      id,
      {
        q,
        // Each value is validated against its allowlist (unknown element → 400, ADR-0030).
        status: parseEnumArrayQuery(status, ArticleStatusSchema, 'status'),
        categoryId: parseCuidArrayQuery(categoryId, 'categoryId'),
      },
      parsePageQuery({ limit, offset, page }),
      principal,
    );
  }

  @Post()
  @RequirePermission('application:write')
  @ApiOperation({ summary: 'Create an application (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: ApplicationDto })
  create(@Body() dto: CreateApplicationDto) {
    return this.applications.create(dto);
  }

  @Patch(':id')
  @RequirePermission('application:write')
  @ApiOperation({ summary: 'Update an application (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: ApplicationDto })
  update(@Param('id') id: string, @Body() dto: UpdateApplicationDto) {
    return this.applications.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('application:delete')
  @ApiOperation({ summary: 'Soft-delete an application — ADMIN only' })
  @ApiOkResponse({ type: ApplicationDto })
  remove(@Param('id') id: string) {
    return this.applications.remove(id);
  }

  @Post(':id/restore')
  @RequirePermission('application:delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted application — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ApplicationDto })
  restore(@Param('id') id: string) {
    return this.applications.restore(id);
  }
}
