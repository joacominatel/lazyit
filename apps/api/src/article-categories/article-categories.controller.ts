import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  ArticleCategorySchema,
  CreateArticleCategorySchema,
  UpdateArticleCategorySchema,
  UpdateFolderAccessRulesSchema,
} from '@lazyit/shared';
import { ArticleCategoriesService } from './article-categories.service';
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
      'Soft-delete an article category (409 if it still has articles) — ADMIN only',
  })
  @ApiOkResponse({ type: ArticleCategoryDto })
  @ApiConflictResponse({ description: 'The category still has live articles' })
  remove(@Param('id') id: string) {
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
