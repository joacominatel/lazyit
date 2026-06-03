import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
}
