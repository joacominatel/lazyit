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
  @ApiOperation({
    summary: 'List all article categories (excludes soft-deleted)',
  })
  @ApiOkResponse({ type: [ArticleCategoryDto] })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an article category by id' })
  @ApiOkResponse({ type: ArticleCategoryDto })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create an article category' })
  @ApiCreatedResponse({ type: ArticleCategoryDto })
  create(@Body() dto: CreateArticleCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an article category' })
  @ApiOkResponse({ type: ArticleCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateArticleCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Soft-delete an article category (409 if it still has articles)',
  })
  @ApiOkResponse({ type: ArticleCategoryDto })
  @ApiConflictResponse({ description: 'The category still has live articles' })
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
