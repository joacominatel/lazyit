import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  ArticleCategorySchema,
  CreateArticleCategorySchema,
  UpdateArticleCategorySchema,
  UpdateFolderAccessRulesSchema,
} from '@lazyit/shared';
import {
  ArticleCategoriesService,
  type CascadeDeleteResult,
} from './article-categories.service';
import { RequirePermission } from '../auth/require-permission.decorator';

class ArticleCategoryDto extends createZodDto(ArticleCategorySchema) {}
class CreateArticleCategoryDto extends createZodDto(
  CreateArticleCategorySchema,
) {}
class UpdateArticleCategoryDto extends createZodDto(
  UpdateArticleCategorySchema,
) {}
class UpdateFolderAccessRulesDto extends createZodDto(
  UpdateFolderAccessRulesSchema,
) {}

/**
 * Validated query DTO for the DELETE endpoint. `cascade` is an optional boolean (default false);
 * the string "true" from the URL query-string is coerced to a boolean by the zod schema.
 */
const DeleteFolderQuerySchema = z.object({
  cascade: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

class DeleteFolderQueryDto extends createZodDto(DeleteFolderQuerySchema) {}

@ApiTags('article-categories')
@Controller('article-categories')
export class ArticleCategoriesController {
  constructor(private readonly categories: ArticleCategoriesService) {}

  @Get()
  @RequirePermission('category:read')
  @ApiOperation({
    summary: 'List all article categories (excludes soft-deleted)',
  })
  @ApiOkResponse({ type: [ArticleCategoryDto] })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @RequirePermission('category:read')
  @ApiOperation({ summary: 'Get an article category by id' })
  @ApiOkResponse({ type: ArticleCategoryDto })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @RequirePermission('category:write')
  @ApiOperation({ summary: 'Create an article category (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: ArticleCategoryDto })
  create(@Body() dto: CreateArticleCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @RequirePermission('category:write')
  @ApiOperation({ summary: 'Update an article category (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: ArticleCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateArticleCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'Soft-delete an article category. Without ?cascade=true: refuses (409) if the folder has live articles or child folders. With ?cascade=true (ADMIN): soft-deletes the folder, all descendant folders, and all their articles in a single transaction; hard-deletes all alias rows in the subtree. Returns { deletedFolders, deletedArticles } when cascading.',
  })
  @ApiQuery({
    name: 'cascade',
    required: false,
    enum: ['true', 'false'],
    description:
      'When "true", cascade the deletion through the entire folder subtree (ADMIN only). Default: "false".',
  })
  @ApiOkResponse({
    description:
      'Without cascade: the soft-deleted ArticleCategory row. With cascade: { deletedFolders, deletedArticles }.',
  })
  @ApiConflictResponse({
    description:
      'Without cascade: the category still has live articles or child folders.',
  })
  remove(
    @Param('id') id: string,
    @Query() query: DeleteFolderQueryDto,
  ): Promise<CascadeDeleteResult> | ReturnType<ArticleCategoriesService['remove']> {
    if (query.cascade) {
      return this.categories.removeCascade(id);
    }
    return this.categories.remove(id);
  }

  @Post(':id/restore')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted article category — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ArticleCategoryDto })
  restore(@Param('id') id: string) {
    return this.categories.restore(id);
  }

  @Put(':id/access-rules')
  // Setting a folder's access boundary is an AUTHORIZATION-management action (ADR-0060 §3 / INV-9), so
  // it is gated by `settings:manage` (ADMIN-only) — the same gate as the permission matrix (INV-8), not
  // the ordinary `category:write`. A non-admin can author content in a folder but never re-scope WHO
  // may read it.
  @RequirePermission('settings:manage')
  @ApiOperation({
    summary:
      "Set or clear a folder's access rules (ADR-0060 §3). The body's `accessRules` is the OR-combined closed rule vocabulary (users / role / appGrant / assetAssignment), or null to clear (make the folder PUBLIC again). ADMIN only.",
  })
  @ApiOkResponse({ type: ArticleCategoryDto })
  setAccessRules(
    @Param('id') id: string,
    @Body() dto: UpdateFolderAccessRulesDto,
  ) {
    return this.categories.setAccessRules(id, dto.accessRules);
  }
}
