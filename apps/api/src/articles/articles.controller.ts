import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  ArticleSchema,
  ArticleStatusSchema,
  CreateArticleSchema,
  ImportArticleSchema,
  UpdateArticleSchema,
  type ArticleStatus,
} from '@lazyit/shared';
import { ArticlesService } from './articles.service';
import { maxImportBytes } from './article-import';

class ArticleDto extends createZodDto(ArticleSchema) {}
class CreateArticleDto extends createZodDto(CreateArticleSchema) {}
class UpdateArticleDto extends createZodDto(UpdateArticleSchema) {}
class ImportArticleDto extends createZodDto(ImportArticleSchema) {}

// X-User-Id is the auth shim (ADR-0022): on reads it reveals the caller's own drafts; on writes it
// is required and becomes the author/editor. Declared per-endpoint with the right `required` flag.
const READ_USER_HEADER = {
  name: 'X-User-Id',
  required: false,
  description: "Caller user id (auth shim). Reveals the caller's own drafts.",
} as const;
const WRITE_USER_HEADER = {
  name: 'X-User-Id',
  required: true,
  description:
    'Caller user id (auth shim). Required; becomes the author/editor.',
} as const;

@ApiTags('articles')
@Controller('articles')
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Get()
  @ApiOperation({
    summary:
      'List articles (excludes soft-deleted). Drafts are visible only to their author.',
  })
  @ApiHeader(READ_USER_HEADER)
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
  @ApiOkResponse({ type: [ArticleDto] })
  findAll(
    @Headers('x-user-id') userId?: string,
    @Query('categoryId') categoryId?: string,
    @Query('authorId') authorId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
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
    return this.articles.findAll(
      { categoryId, authorId, status: parsedStatus, q },
      userId,
    );
  }

  @Get('by-slug/:slug')
  @ApiOperation({ summary: 'Get an article by slug' })
  @ApiHeader(READ_USER_HEADER)
  @ApiOkResponse({ type: ArticleDto })
  findBySlug(
    @Param('slug') slug: string,
    @Headers('x-user-id') userId?: string,
  ) {
    return this.articles.findBySlug(slug, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an article by id' })
  @ApiHeader(READ_USER_HEADER)
  @ApiOkResponse({ type: ArticleDto })
  findOne(@Param('id') id: string, @Headers('x-user-id') userId?: string) {
    return this.articles.findOne(id, userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an article (author = X-User-Id)' })
  @ApiHeader(WRITE_USER_HEADER)
  @ApiCreatedResponse({ type: ArticleDto })
  create(@Body() dto: CreateArticleDto, @Headers('x-user-id') userId?: string) {
    return this.articles.create(dto, userId);
  }

  @Post('import')
  @ApiOperation({ summary: 'Import an article from a .md, .txt or .docx file' })
  @ApiHeader(WRITE_USER_HEADER)
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
    @Headers('x-user-id') userId?: string,
  ) {
    return this.articles.importArticle(file, dto, userId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an article (author only; never changes status)',
  })
  @ApiHeader(WRITE_USER_HEADER)
  @ApiOkResponse({ type: ArticleDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateArticleDto,
    @Headers('x-user-id') userId?: string,
  ) {
    return this.articles.update(id, dto, userId);
  }

  @Post(':id/publish')
  @ApiOperation({
    summary:
      'Publish an article (author only). Sets publishedAt on first publish.',
  })
  @ApiHeader(WRITE_USER_HEADER)
  @ApiOkResponse({ type: ArticleDto })
  publish(@Param('id') id: string, @Headers('x-user-id') userId?: string) {
    return this.articles.publish(id, userId);
  }

  @Post(':id/unpublish')
  @ApiOperation({
    summary:
      'Unpublish an article back to DRAFT (author only). Keeps publishedAt.',
  })
  @ApiHeader(WRITE_USER_HEADER)
  @ApiOkResponse({ type: ArticleDto })
  unpublish(@Param('id') id: string, @Headers('x-user-id') userId?: string) {
    return this.articles.unpublish(id, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete an article (author only)' })
  @ApiHeader(WRITE_USER_HEADER)
  @ApiOkResponse({ type: ArticleDto })
  remove(@Param('id') id: string, @Headers('x-user-id') userId?: string) {
    return this.articles.remove(id, userId);
  }
}
