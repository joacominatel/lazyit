import { Readable } from 'node:stream';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
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
  ArticleListPageSchema,
  ArticleStatusSchema,
  AssetAssignmentWithUserSchema,
  AssetHistoryQuerySchema,
  AssetHistorySchema,
  AssetListPageSchema,
  AssetSchema,
  AssetStatusSchema,
  AssetWithRelationsSchema,
  BatchAssetStatusSchema,
  BatchIdsSchema,
  BatchResultSchema,
  CreateAssetSchema,
  UpdateAssetSchema,
  type AssetStatus,
} from '@lazyit/shared';
import { ASSET_SORT_ALLOWLIST } from './assets.service';
import { AssetsService } from './assets.service';
import { ArticlesService } from '../articles/articles.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parseCuidArrayQuery } from '../common/parse-cuid-array-query';
import { parseCuidQuery } from '../common/parse-cuid-query';
import { parseUuidQuery } from '../common/parse-uuid-query';
import { parseEnumArrayQuery } from '../common/parse-enum-array-query';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

// Writes keep the lean Asset shape; the detail read returns the expanded AssetWithRelations, while
// the (paginated) list returns the trimmed AssetListItem envelope.
class AssetDto extends createZodDto(AssetSchema) {}
class CreateAssetDto extends createZodDto(CreateAssetSchema) {}
class UpdateAssetDto extends createZodDto(UpdateAssetSchema) {}
class AssetWithRelationsDto extends createZodDto(AssetWithRelationsSchema) {}
class AssetListPageDto extends createZodDto(AssetListPageSchema) {}
class AssetAssignmentWithUserDto extends createZodDto(
  AssetAssignmentWithUserSchema,
) {}
class AssetHistoryDto extends createZodDto(AssetHistorySchema) {}
// Reverse KB lookup (ADR-0042 / #220): the lean, paginated article-list envelope for
// GET /assets/:id/articles (a Page<ArticleListItem>, no markdown content).
class ArticleListPageDto extends createZodDto(ArticleListPageSchema) {}
// Batch (bulk) action DTOs (ADR-0030 amendment): the ids payload, the status payload, and the
// per-item batch result envelope.
class BatchIdsDto extends createZodDto(BatchIdsSchema) {}
class BatchAssetStatusDto extends createZodDto(BatchAssetStatusSchema) {}
class BatchResultDto extends createZodDto(BatchResultSchema) {}

@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly assignments: AssetAssignmentsService,
    private readonly history: AssetHistoryService,
    private readonly articles: ArticlesService,
  ) {}

  @Get()
  @RequirePermission('asset:read')
  @ApiOperation({
    summary:
      'List assets (paginated; lean: model/category, location, activeAssignments — no specs). Active by default; deleted=only lists archived assets (ADMIN).',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'locationId', required: false })
  @ApiQuery({
    name: 'company',
    required: false,
    description:
      'Exact-match grouping filter on the free-text company value (ADR-0076). Not a scoping boundary — see GET /assets/companies for the distinct values.',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...AssetStatusSchema.options],
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on name, serial and assetTag',
  })
  @ApiQuery({
    name: 'assignedToUserId',
    required: false,
    description:
      'Restrict to assets currently assigned (live, releasedAt null) to this user (a User uuid). Invalid uuid → 400.',
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
    enum: Object.keys(ASSET_SORT_ALLOWLIST),
    description:
      'Server-side sort field (over the full result set). Unknown field → 400. Default order: createdAt desc.',
  })
  @ApiQuery({
    name: 'dir',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort direction (default asc when sort is set).',
  })
  @ApiQuery({
    name: 'ownership',
    required: false,
    enum: ['HAS', 'NONE'],
    description:
      'Ownership slice over LIVE assignments. HAS = assets with an active owner; NONE = unassigned. Invalid value → 400.',
  })
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description:
      'Soft-delete slice. active (default) = live assets; only = archived (soft-deleted) assets — ADMIN only (403 otherwise). (ADR-0041)',
  })
  @ApiOkResponse({ type: AssetListPageDto })
  findAll(
    @Query('categoryId') categoryId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
    @Query('company') company?: string,
    @Query('q') q?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('ownership') ownership?: string,
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
    // The list route carries no @Roles (any authenticated user may list ACTIVE assets), so gate the
    // privileged archived slice here: deleted=only is ADMIN-only (403 otherwise). (ADR-0041)
    assertCanListDeleted(pageQuery.deleted, user);
    return this.assets.findPage(
      this.parseAssetFilters({
        categoryId,
        locationId,
        status,
        company,
        q,
        assignedToUserId,
        ownership,
      }),
      pageQuery,
    );
  }

  /**
   * Parse + validate the shared asset FILTERS (the additive `where` inputs common to the list read and
   * the CSV export) into the service's {@link AssetFilters}. The global ZodValidationPipe only checks
   * `@Body()`, so these raw `@Query` strings are validated here: an invalid status/ownership → 400, and
   * categoryId/locationId (cuid) / assignedToUserId (a User uuid, ADR-0005) are id-validated. Shared so
   * the export interprets every param IDENTICALLY to the list — it can never drift.
   */
  private parseAssetFilters(raw: {
    categoryId?: string;
    locationId?: string;
    status?: string;
    company?: string;
    q?: string;
    assignedToUserId?: string;
    ownership?: string;
  }) {
    let parsedStatus: AssetStatus | undefined;
    if (raw.status !== undefined) {
      const result = AssetStatusSchema.safeParse(raw.status);
      if (!result.success) {
        throw new BadRequestException(
          `Invalid status. Expected one of: ${AssetStatusSchema.options.join(', ')}`,
        );
      }
      parsedStatus = result.data;
    }
    let parsedOwnership: 'HAS' | 'NONE' | undefined;
    if (raw.ownership !== undefined) {
      if (raw.ownership !== 'HAS' && raw.ownership !== 'NONE') {
        throw new BadRequestException(
          'Invalid ownership. Expected one of: HAS, NONE',
        );
      }
      parsedOwnership = raw.ownership;
    }
    return {
      categoryId: parseCuidQuery(raw.categoryId, 'categoryId'),
      locationId: parseCuidQuery(raw.locationId, 'locationId'),
      status: parsedStatus,
      company: raw.company?.trim() || undefined,
      q: raw.q,
      assignedToUserId: parseUuidQuery(
        raw.assignedToUserId,
        'assignedToUserId',
      ),
      ownership: parsedOwnership,
    };
  }

  // STATIC route declared BEFORE the `:id` param route so `/assets/companies` never resolves as an id.
  @Get('companies')
  @RequirePermission('asset:read')
  @ApiOperation({
    summary:
      'List the distinct, non-empty company values across live assets (ADR-0076) — powers the form autocomplete and the list filter. A grouping facet, NOT an access boundary.',
  })
  @ApiOkResponse({ type: [String] })
  listCompanies() {
    return this.assets.listCompanies();
  }

  // STATIC route declared BEFORE the `:id` param route so `/assets/export` never resolves as an id.
  @Get('export')
  @RequirePermission('asset:read')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      'Bulk CSV export of the WHOLE filtered asset inventory (issue #872), gated on asset:read. Takes the SAME filters as GET /assets (minus paging/sort) and streams EVERY matching asset newest-first — not just the visible page. Cells are RFC-4180 escaped with a spreadsheet formula-injection guard. `deleted=only` (archived) is ADMIN-only (403 otherwise). The per-unit `specs` jsonb is not included (v1).',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'locationId', required: false })
  @ApiQuery({ name: 'company', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...AssetStatusSchema.options],
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'assignedToUserId', required: false })
  @ApiQuery({ name: 'ownership', required: false, enum: ['HAS', 'NONE'] })
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description:
      'Soft-delete slice. active (default) = live assets; only = archived — ADMIN only (403 otherwise).',
  })
  @ApiOkResponse({
    description: 'The filtered asset inventory as CSV (text/csv).',
  })
  export(
    @Query('categoryId') categoryId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
    @Query('company') company?: string,
    @Query('q') q?: string,
    @Query('assignedToUserId') assignedToUserId?: string,
    @Query('ownership') ownership?: string,
    @Query('deleted') deleted?: string,
    @CurrentUser() user?: User,
  ): StreamableFile {
    const filters = this.parseAssetFilters({
      categoryId,
      locationId,
      status,
      company,
      q,
      assignedToUserId,
      ownership,
    });
    // Reuse parsePageQuery ONLY for its `deleted` validation (the export is unpaginated); an invalid
    // slice → 400, then gate the privileged archived slice ADMIN-only exactly like the list (ADR-0041).
    const { deleted: slice } = parsePageQuery({ deleted });
    assertCanListDeleted(slice, user);

    const filename = `lazyit-assets-${new Date().toISOString().slice(0, 10)}.csv`;
    // Readable.from drains the async generator one chunk at a time → never the whole estate in memory.
    return new StreamableFile(
      Readable.from(this.assets.streamInventoryCsvRows(filters, slice), {
        objectMode: false,
      }),
      {
        type: 'text/csv; charset=utf-8',
        disposition: `attachment; filename="${filename}"`,
      },
    );
  }

  @Get(':id')
  @RequirePermission('asset:read')
  @ApiOperation({
    summary: 'Get an asset by id (expanded with its relations)',
  })
  @ApiOkResponse({ type: AssetWithRelationsDto })
  findOne(@Param('id') id: string) {
    return this.assets.findOne(id);
  }

  @Get(':id/assignments')
  @RequirePermission('asset:read')
  @ApiOperation({
    summary:
      "List an asset's ownership assignments, each with its user (active-only by default)",
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include released assignments.',
  })
  @ApiOkResponse({ type: [AssetAssignmentWithUserDto] })
  async findAssignments(
    @Param('id') id: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    await this.assets.assertExists(id); // 404 if the asset is missing or soft-deleted
    return this.assignments.findAll({
      assetId: id,
      activeOnly: parseBooleanQuery(activeOnly, true),
      includeUser: true,
    });
  }

  @Get(':id/history')
  @RequirePermission('asset:read')
  @ApiOperation({
    summary:
      "List an asset's history (newest first; cursor pagination via `before`)",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Default 50, max 100.',
  })
  @ApiQuery({
    name: 'before',
    required: false,
    type: Number,
    description: 'Cursor: return events with id < before.',
  })
  @ApiOkResponse({ type: [AssetHistoryDto] })
  async findHistory(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    await this.assets.assertExists(id); // 404 if the asset is missing or soft-deleted
    const parsed = AssetHistoryQuerySchema.safeParse({ limit, before });
    if (!parsed.success) {
      throw new BadRequestException(
        'Invalid pagination: limit (1-100) and before (positive integer)',
      );
    }
    return this.history.list(id, parsed.data);
  }

  @Get(':id/articles')
  @RequirePermission('article:read')
  @ApiOperation({
    summary:
      "List the PUBLISHED knowledge-base articles linked to this asset ('the runbook for THIS server'; paginated + filterable). (ADR-0042 / ADR-0030 / #220)",
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
    await this.assets.assertExists(id); // 404 if the asset is missing or soft-deleted
    return this.articles.findArticlesForAsset(
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
  @RequirePermission('asset:write')
  @ApiOperation({ summary: 'Create an asset (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: AssetDto })
  create(
    @Body() dto: CreateAssetDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.assets.create(dto, principal);
  }

  // --- batch (bulk) actions — ADMIN only (ADR-0030 amendment) ---------------
  // Declared as STATIC `batch/*` routes (before the `:id` param routes) so they never collide with
  // the single-item routes. Each runs in one transaction with per-entity AssetHistory (one event per
  // item, not per batch) and returns a per-id BatchResult (succeeded + skipped-with-reason).

  @Post('batch/delete')
  @RequirePermission('asset:delete')
  @ApiOperation({
    summary:
      'Bulk soft-delete assets (one DELETED history event per item; one transaction) — ADMIN only',
  })
  @ApiOkResponse({ type: BatchResultDto })
  batchRemove(
    @Body() dto: BatchIdsDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.assets.batchRemove(dto.ids, principal);
  }

  @Post('batch/restore')
  @RequirePermission('asset:delete')
  @ApiOperation({
    summary:
      'Bulk restore soft-deleted assets (one RESTORED history event per item; one transaction) — ADMIN only',
  })
  @ApiOkResponse({ type: BatchResultDto })
  batchRestore(
    @Body() dto: BatchIdsDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.assets.batchRestore(dto.ids, principal);
  }

  @Post('batch/status')
  @RequirePermission('asset:delete')
  @ApiOperation({
    summary:
      'Bulk set asset status (one STATUS_CHANGED history event per changed item; one transaction) — ADMIN only',
  })
  @ApiOkResponse({ type: BatchResultDto })
  batchSetStatus(
    @Body() dto: BatchAssetStatusDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.assets.batchSetStatus(dto.ids, dto.status, principal);
  }

  @Patch(':id')
  @RequirePermission('asset:write')
  @ApiOperation({ summary: 'Update an asset (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: AssetDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.assets.update(id, dto, principal);
  }

  @Delete(':id')
  @RequirePermission('asset:delete')
  @ApiOperation({ summary: 'Soft-delete an asset — ADMIN only' })
  @ApiOkResponse({ type: AssetDto })
  remove(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.assets.remove(id, principal);
  }

  @Post(':id/restore')
  @RequirePermission('asset:delete')
  @ApiOperation({
    summary:
      'Restore a soft-deleted asset (emits a RESTORED history event) — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: AssetWithRelationsDto })
  restore(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.assets.restore(id, principal);
  }
}
