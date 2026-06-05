import {
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
} from './applications.service';
import { ArticlesService } from '../articles/articles.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parseCuidArrayQuery } from '../common/parse-cuid-array-query';
import { parseEnumArrayQuery } from '../common/parse-enum-array-query';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { AccessGrantDto } from '../access-grants/access-grant.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';

class ApplicationDto extends createZodDto(ApplicationSchema) {}
class ApplicationListPageDto extends createZodDto(ApplicationListPageSchema) {}
class CreateApplicationDto extends createZodDto(CreateApplicationSchema) {}
class UpdateApplicationDto extends createZodDto(UpdateApplicationSchema) {}
// Reverse KB lookup (ADR-0042 / #220): the lean, paginated article-list envelope for
// GET /applications/:id/articles (a Page<ArticleListItem>, no markdown content).
class ArticleListPageDto extends createZodDto(ArticleListPageSchema) {}

@ApiTags('applications')
@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly grants: AccessGrantsService,
    private readonly articles: ArticlesService,
  ) {}

  @Get()
  @RequirePermission('application:read')
  @ApiOperation({
    summary:
      'List applications (paginated; active by default). Server-side q search + sort. deleted=only lists archived rows (ADMIN).',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on name, vendor, url and description',
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
    return this.applications.findPage({ q }, pageQuery);
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
