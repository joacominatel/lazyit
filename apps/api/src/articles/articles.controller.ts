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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  ArticleLinkedFilterSchema,
  ArticleLinkedToSchema,
  ArticleLinkSchema,
  ArticleListPageSchema,
  ArticleSchema,
  ArticleStatusSchema,
  ArticleVersionPageSchema,
  ArticleVersionSchema,
  CreateArticleLinkSchema,
  CreateArticleSchema,
  ImportArticleSchema,
  UpdateArticleSchema,
  type ArticleLinkedFilter,
} from '@lazyit/shared';
import { ArticlesService } from './articles.service';
import { maxImportBytes } from './article-import';
import { parseUuidQuery } from '../common/parse-uuid-query';
import { parseCuidArrayQuery } from '../common/parse-cuid-array-query';
import { parseEnumArrayQuery } from '../common/parse-enum-array-query';
import { parsePageQuery } from '../common/parse-page-query';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

// The detail reads return the full Article (with `content`); the paginated list returns the lean
// ArticleListItem envelope (content omitted, excerpt kept).
class ArticleDto extends createZodDto(ArticleSchema) {}
class CreateArticleDto extends createZodDto(CreateArticleSchema) {}
class UpdateArticleDto extends createZodDto(UpdateArticleSchema) {}
class ImportArticleDto extends createZodDto(ImportArticleSchema) {}
class ArticleListPageDto extends createZodDto(ArticleListPageSchema) {}
// Versioning + linking (ADR-0042).
class ArticleVersionDto extends createZodDto(ArticleVersionSchema) {}
class ArticleVersionPageDto extends createZodDto(ArticleVersionPageSchema) {}
class ArticleLinkDto extends createZodDto(ArticleLinkSchema) {}
class CreateArticleLinkDto extends createZodDto(CreateArticleLinkSchema) {}

@ApiTags('articles')
@Controller('articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Get()
  @RequirePermission('article:read')
  @ApiOperation({
    summary:
      'List articles (paginated; lean — no markdown content, excerpt kept). Excludes soft-deleted; drafts are visible only to their author.',
  })
  @ApiQuery({
    name: 'categoryId',
    required: false,
    description:
      'Filter by category. Multi-value (#198): comma-separated (categoryId=cuid1,cuid2) or repeated; values OR-combine (union). Each element must be a cuid — an invalid element → 400. A single value still works.',
  })
  @ApiQuery({ name: 'authorId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...ArticleStatusSchema.options],
    isArray: true,
    description:
      'Filter by status. Multi-value (#198): comma-separated (status=DRAFT,PUBLISHED) or repeated; values OR-combine (union). Unknown value → 400. A single value still works.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Case-insensitive substring match on title and excerpt',
  })
  @ApiQuery({
    name: 'linked',
    required: false,
    enum: [...ArticleLinkedFilterSchema.options],
    description:
      'only → keep just articles with ≥1 link to an Asset/Application (ADR-0042). Omitted = both linked and unlinked. Unknown value → 400.',
  })
  @ApiQuery({
    name: 'linkedTo',
    required: false,
    enum: [...ArticleLinkedToSchema.options],
    isArray: true,
    description:
      'Narrow the linked filter to one or more target kinds. Multi-value (#198): comma-separated (linkedTo=asset,application) or repeated; kinds OR-combine. Implies linked=only. Unknown value → 400.',
  })
  @ApiQuery({
    name: 'assetId',
    required: false,
    isArray: true,
    description:
      'Narrow the linked filter to SPECIFIC Assets (#213): keep only articles linked to ≥1 of these exact assets. Multi-value (#198): comma-separated (assetId=cuid1,cuid2) or repeated; values OR-combine. Each element must be a cuid — an invalid element → 400. Implies linked=only; more granular than linkedTo=asset.',
  })
  @ApiQuery({
    name: 'applicationId',
    required: false,
    isArray: true,
    description:
      'Narrow the linked filter to SPECIFIC Applications (#213): keep only articles linked to ≥1 of these exact applications. Multi-value (#198): comma-separated (applicationId=cuid1,cuid2) or repeated; values OR-combine. Each element must be a cuid — an invalid element → 400. Implies linked=only.',
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
  findAll(
    @CurrentUser() user: User | undefined,
    // Multi-value filters (#198) arrive comma-encoded (one param) OR repeated (Nest hands a string[]).
    @Query('categoryId') categoryId?: string | string[],
    @Query('authorId') authorId?: string,
    @Query('status') status?: string | string[],
    @Query('q') q?: string,
    @Query('linked') linked?: string,
    @Query('linkedTo') linkedTo?: string | string[],
    @Query('assetId') assetId?: string | string[],
    @Query('applicationId') applicationId?: string | string[],
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.articles.findPage(
      {
        // status / categoryId / linkedTo are multi-select (#198): each value OR-combines within the
        // filter (union), filters AND-combine. Parsed to arrays here; each element is validated
        // against its allowlist (unknown element → 400, ADR-0030). A single value still parses.
        categoryId: parseCuidArrayQuery(categoryId, 'categoryId'),
        authorId: parseUuidQuery(authorId, 'authorId'),
        status: parseEnumArrayQuery(status, ArticleStatusSchema, 'status'),
        q,
        linked: this.parseLinked(linked),
        linkedTo: parseEnumArrayQuery(
          linkedTo,
          ArticleLinkedToSchema,
          'linkedTo',
        ),
        // assetId / applicationId are the specific-entity link filters (#213) — multi-value cuids,
        // same comma-encoded/repeated wire shape + 400-on-unknown-element contract as categoryId.
        assetId: parseCuidArrayQuery(assetId, 'assetId'),
        applicationId: parseCuidArrayQuery(applicationId, 'applicationId'),
      },
      parsePageQuery({ limit, offset, page }),
      user,
    );
  }

  /**
   * Validate `?linked=` against the {@link ArticleLinkedFilterSchema} allowlist — the only accepted
   * value is `only`. An unknown value is rejected with 400 (ADR-0030: an unknown filter value is
   * never silently ignored). Mirrors the inline `status` check; the global ZodValidationPipe only
   * validates `@Body()` DTOs, so raw `@Query` strings are otherwise unchecked.
   */
  private parseLinked(value?: string): ArticleLinkedFilter | undefined {
    if (value === undefined) return undefined;
    const result = ArticleLinkedFilterSchema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        `Invalid linked. Expected one of: ${ArticleLinkedFilterSchema.options.join(', ')}`,
      );
    }
    return result.data;
  }

  @Get('by-slug/:slug')
  @RequirePermission('article:read')
  @ApiOperation({ summary: 'Get an article by slug' })
  @ApiOkResponse({ type: ArticleDto })
  findBySlug(@Param('slug') slug: string, @CurrentUser() user?: User) {
    return this.articles.findBySlug(slug, user);
  }

  @Get(':id')
  @RequirePermission('article:read')
  @ApiOperation({ summary: 'Get an article by id' })
  @ApiOkResponse({ type: ArticleDto })
  findOne(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.articles.findOne(id, user);
  }

  @Get(':id/versions')
  @RequirePermission('article:read')
  @ApiOperation({
    summary:
      "List an article's version history (append-only; newest first; paginated). Drafts visible only to their author. (ADR-0042)",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size. Default 50, max 200 (ADR-0030).',
  })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: ArticleVersionPageDto })
  findVersions(
    @Param('id') id: string,
    @CurrentUser() user?: User,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.articles.listVersions(
      id,
      parsePageQuery({ limit, offset, page }),
      user,
    );
  }

  @Get(':id/versions/:version')
  @RequirePermission('article:read')
  @ApiOperation({
    summary:
      'Get a single version of an article by its version number (ADR-0042)',
  })
  @ApiOkResponse({ type: ArticleVersionDto })
  findVersion(
    @Param('id') id: string,
    @Param('version') version: string,
    @CurrentUser() user?: User,
  ) {
    const parsed = Number(version);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new BadRequestException('version must be a positive integer');
    }
    return this.articles.findVersion(id, parsed, user);
  }

  @Get(':id/links')
  @RequirePermission('article:read')
  @ApiOperation({
    summary:
      "List an article's links to assets/applications (readable by any reader of the article). (ADR-0042)",
  })
  @ApiOkResponse({ type: [ArticleLinkDto] })
  findLinks(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.articles.findLinks(id, user);
  }

  @Post()
  @RequirePermission('article:write')
  @ApiOperation({
    summary: 'Create an article (author = current user) (ADMIN or MEMBER)',
  })
  @ApiCreatedResponse({ type: ArticleDto })
  create(
    @Body() dto: CreateArticleDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.articles.create(dto, principal);
  }

  @Post('import')
  @RequirePermission('article:write')
  @ApiOperation({
    summary:
      'Import an article from a .md, .txt or .docx file (ADMIN or MEMBER)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'categoryId'],
      properties: {
        file: { type: 'string', format: 'binary' },
        categoryId: { type: 'string' },
        status: { type: 'string', enum: [...ArticleStatusSchema.options] },
        title: { type: 'string' },
        slug: { type: 'string' },
      },
    },
  })
  @ApiCreatedResponse({ type: ArticleDto })
  // Cap the upload at the interceptor so multer aborts the stream early instead of buffering an
  // arbitrarily large file into the heap (SEC-001). platform-express maps multer's LIMIT_FILE_SIZE
  // to 413. The limit is fixed at boot from MAX_IMPORT_SIZE_MB (decoration-time eval); the
  // service-level file.size check stays as defense in depth. This does not bound .docx decompression
  // (SEC-002) — a limit-compliant zip can still expand during parsing.
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: maxImportBytes() } }),
  )
  importArticle(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: ImportArticleDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.articles.importArticle(file, dto, principal);
  }

  @Patch(':id')
  @RequirePermission('article:write')
  @ApiOperation({
    summary:
      'Update an article (author only; never changes status) (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: ArticleDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateArticleDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.articles.update(id, dto, principal);
  }

  @Post(':id/links')
  @RequirePermission('article:write')
  @ApiOperation({
    summary:
      'Link an article to an Asset XOR an Application (author only; exactly one target). (ADMIN or MEMBER) (ADR-0042)',
  })
  @ApiCreatedResponse({ type: ArticleLinkDto })
  addLink(
    @Param('id') id: string,
    @Body() dto: CreateArticleLinkDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.articles.addLink(id, dto, principal);
  }

  @Delete(':id/links/:linkId')
  @RequirePermission('article:write')
  @ApiOperation({
    summary:
      'Remove a link from an article (author only). (ADMIN or MEMBER) (ADR-0042)',
  })
  @ApiOkResponse({ type: ArticleLinkDto })
  removeLink(
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.articles.removeLink(id, linkId, principal);
  }

  @Post(':id/publish')
  @RequirePermission('article:write')
  @ApiOperation({
    summary:
      'Publish an article (author only). Sets publishedAt on first publish. (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: ArticleDto })
  publish(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.articles.publish(id, principal);
  }

  @Post(':id/unpublish')
  @RequirePermission('article:write')
  @ApiOperation({
    summary:
      'Unpublish an article back to DRAFT (author only). Keeps publishedAt. (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: ArticleDto })
  unpublish(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.articles.unpublish(id, principal);
  }

  @Delete(':id')
  @RequirePermission('article:delete')
  @ApiOperation({
    summary: 'Soft-delete an article (destructive) — ADMIN only',
  })
  @ApiOkResponse({ type: ArticleDto })
  remove(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.articles.remove(id, principal);
  }

  @Post(':id/restore')
  @RequirePermission('article:delete')
  @ApiOperation({
    summary:
      'Restore a soft-deleted article (author only) — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ArticleDto })
  restore(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.articles.restore(id, principal);
  }
}
