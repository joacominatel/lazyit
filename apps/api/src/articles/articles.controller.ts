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
  ApiBearerAuth,
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
  ArticleListPageSchema,
  ArticleSchema,
  ArticleStatusSchema,
  CreateArticleSchema,
  ImportArticleSchema,
  UpdateArticleSchema,
  type ArticleStatus,
} from '@lazyit/shared';
import { ArticlesService } from './articles.service';
import { maxImportBytes } from './article-import';
import { parseUuidQuery } from '../common/parse-uuid-query';
import { parsePageQuery } from '../common/parse-page-query';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { User } from '../../generated/prisma/client';

// The detail reads return the full Article (with `content`); the paginated list returns the lean
// ArticleListItem envelope (content omitted, excerpt kept).
class ArticleDto extends createZodDto(ArticleSchema) {}
class CreateArticleDto extends createZodDto(CreateArticleSchema) {}
class UpdateArticleDto extends createZodDto(UpdateArticleSchema) {}
class ImportArticleDto extends createZodDto(ImportArticleSchema) {}
class ArticleListPageDto extends createZodDto(ArticleListPageSchema) {}

@ApiBearerAuth()
@ApiTags('articles')
@Controller('articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Get()
  @ApiOperation({
    summary:
      'List articles (paginated; lean — no markdown content, excerpt kept). Excludes soft-deleted; drafts are visible only to their author.',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'authorId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...ArticleStatusSchema.options],
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Case-insensitive substring match on title and excerpt',
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
    @Query('categoryId') categoryId?: string,
    @Query('authorId') authorId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    let parsedStatus: ArticleStatus | undefined;
    if (status !== undefined) {
      const result = ArticleStatusSchema.safeParse(status);
      if (!result.success) {
        throw new BadRequestException(
          `Invalid status. Expected one of: ${ArticleStatusSchema.options.join(', ')}`,
        );
      }
      parsedStatus = result.data;
    }
    return this.articles.findPage(
      {
        categoryId,
        authorId: parseUuidQuery(authorId, 'authorId'),
        status: parsedStatus,
        q,
      },
      parsePageQuery({ limit, offset, page }),
      user,
    );
  }

  @Get('by-slug/:slug')
  @ApiOperation({ summary: 'Get an article by slug' })
  @ApiOkResponse({ type: ArticleDto })
  findBySlug(
    @Param('slug') slug: string,
    @CurrentUser() user?: User,
  ) {
    return this.articles.findBySlug(slug, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an article by id' })
  @ApiOkResponse({ type: ArticleDto })
  findOne(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.articles.findOne(id, user);
  }

  @Post()
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary: 'Create an article (author = current user) (ADMIN or MEMBER)',
  })
  @ApiCreatedResponse({ type: ArticleDto })
  create(@Body() dto: CreateArticleDto, @CurrentUser() user?: User) {
    return this.articles.create(dto, user);
  }

  @Post('import')
  @Roles('ADMIN', 'MEMBER')
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
    @CurrentUser() user?: User,
  ) {
    return this.articles.importArticle(file, dto, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary:
      'Update an article (author only; never changes status) (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: ArticleDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateArticleDto,
    @CurrentUser() user?: User,
  ) {
    return this.articles.update(id, dto, user);
  }

  @Post(':id/publish')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary:
      'Publish an article (author only). Sets publishedAt on first publish. (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: ArticleDto })
  publish(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.articles.publish(id, user);
  }

  @Post(':id/unpublish')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary:
      'Unpublish an article back to DRAFT (author only). Keeps publishedAt. (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: ArticleDto })
  unpublish(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.articles.unpublish(id, user);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Soft-delete an article (destructive) — ADMIN only',
  })
  @ApiOkResponse({ type: ArticleDto })
  remove(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.articles.remove(id, user);
  }

  @Post(':id/restore')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Restore a soft-deleted article (author only) — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ArticleDto })
  restore(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.articles.restore(id, user);
  }
}
