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
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  ArticleListItemSchema,
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
import { parseCuidQuery } from '../common/parse-cuid-query';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';

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
// Reverse KB lookup (ADR-0042): the lean article-list shape for GET /assets/:id/articles.
class ArticleListItemDto extends createZodDto(ArticleListItemSchema) {}
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
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('deleted') deleted?: string,
    @CurrentUser() user?: User,
  ) {
    let parsedStatus: AssetStatus | undefined;
    if (status !== undefined) {
      const result = AssetStatusSchema.safeParse(status);
      if (!result.success) {
        throw new BadRequestException(
          `Invalid status. Expected one of: ${AssetStatusSchema.options.join(', ')}`,
        );
      }
      parsedStatus = result.data;
    }
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
      {
        categoryId: parseCuidQuery(categoryId, 'categoryId'),
        locationId: parseCuidQuery(locationId, 'locationId'),
        status: parsedStatus,
        q,
      },
      pageQuery,
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
      "List the PUBLISHED knowledge-base articles linked to this asset ('the runbook for THIS server'). (ADR-0042)",
  })
  @ApiOkResponse({ type: [ArticleListItemDto] })
  async findArticles(@Param('id') id: string) {
    await this.assets.assertExists(id); // 404 if the asset is missing or soft-deleted
    return this.articles.findArticlesForAsset(id);
  }

  @Post()
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Create an asset (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: AssetDto })
  create(@Body() dto: CreateAssetDto, @CurrentUser() user?: User) {
    return this.assets.create(dto, user);
  }

  // --- batch (bulk) actions — ADMIN only (ADR-0030 amendment) ---------------
  // Declared as STATIC `batch/*` routes (before the `:id` param routes) so they never collide with
  // the single-item routes. Each runs in one transaction with per-entity AssetHistory (one event per
  // item, not per batch) and returns a per-id BatchResult (succeeded + skipped-with-reason).

  @Post('batch/delete')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Bulk soft-delete assets (one DELETED history event per item; one transaction) — ADMIN only',
  })
  @ApiOkResponse({ type: BatchResultDto })
  batchRemove(@Body() dto: BatchIdsDto, @CurrentUser() user?: User) {
    return this.assets.batchRemove(dto.ids, user);
  }

  @Post('batch/restore')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Bulk restore soft-deleted assets (one RESTORED history event per item; one transaction) — ADMIN only',
  })
  @ApiOkResponse({ type: BatchResultDto })
  batchRestore(@Body() dto: BatchIdsDto, @CurrentUser() user?: User) {
    return this.assets.batchRestore(dto.ids, user);
  }

  @Post('batch/status')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Bulk set asset status (one STATUS_CHANGED history event per changed item; one transaction) — ADMIN only',
  })
  @ApiOkResponse({ type: BatchResultDto })
  batchSetStatus(@Body() dto: BatchAssetStatusDto, @CurrentUser() user?: User) {
    return this.assets.batchSetStatus(dto.ids, dto.status, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Update an asset (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: AssetDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() user?: User,
  ) {
    return this.assets.update(id, dto, user);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Soft-delete an asset — ADMIN only' })
  @ApiOkResponse({ type: AssetDto })
  remove(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.assets.remove(id, user);
  }

  @Post(':id/restore')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Restore a soft-deleted asset (emits a RESTORED history event) — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: AssetWithRelationsDto })
  restore(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.assets.restore(id, user);
  }
}
