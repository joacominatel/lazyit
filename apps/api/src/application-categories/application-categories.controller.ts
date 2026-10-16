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
  ApplicationCategoryDeleteImpactSchema,
  ApplicationCategorySchema,
  CreateApplicationCategorySchema,
  UpdateApplicationCategorySchema,
} from '@lazyit/shared';
import { ApplicationCategoriesService } from './application-categories.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { parseDeleteResolution } from '../common/delete-resolution';

class ApplicationCategoryDto extends createZodDto(ApplicationCategorySchema) {}
class CreateApplicationCategoryDto extends createZodDto(
  CreateApplicationCategorySchema,
) {}
class UpdateApplicationCategoryDto extends createZodDto(
  UpdateApplicationCategorySchema,
) {}
class ApplicationCategoryDeleteImpactDto extends createZodDto(
  ApplicationCategoryDeleteImpactSchema,
) {}

@ApiTags('application-categories')
@Controller('application-categories')
export class ApplicationCategoriesController {
  constructor(private readonly categories: ApplicationCategoriesService) {}

  @Get()
  @RequirePermission('category:read')
  @ApiOperation({
    summary: 'List all application categories (excludes soft-deleted)',
  })
  @ApiOkResponse({ type: [ApplicationCategoryDto] })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @RequirePermission('category:read')
  @ApiOperation({ summary: 'Get an application category by id' })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @RequirePermission('category:write')
  @ApiOperation({ summary: 'Create an application category (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: ApplicationCategoryDto })
  create(@Body() dto: CreateApplicationCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @RequirePermission('category:write')
  @ApiOperation({ summary: 'Update an application category (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateApplicationCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Get(':id/delete-impact')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'The live applications deleting this category would detach or move (count, plus the first 50 when the caller may read applications).',
  })
  @ApiOkResponse({ type: ApplicationCategoryDeleteImpactDto })
  deleteImpact(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.categories.deleteImpact(id, principal);
  }

  @Delete(':id')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'Soft-delete an application category — ADMIN only. While live applications are filed under it, give ONE strategy for all of them (409 DELETE_RESOLUTION_REQUIRED otherwise).',
  })
  @ApiQuery({
    name: 'strategy',
    required: false,
    enum: ['detach', 'move'],
    description:
      'detach: the applications keep no category. move: they all go to targetId.',
  })
  @ApiQuery({
    name: 'targetId',
    required: false,
    description: 'With strategy=move: another live application category.',
  })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  remove(
    @Param('id') id: string,
    @Query('strategy') strategy?: string,
    @Query('targetId') targetId?: string,
  ) {
    return this.categories.remove(
      id,
      parseDeleteResolution(strategy, targetId),
    );
  }

  @Post(':id/restore')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'Restore a soft-deleted application category — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ApplicationCategoryDto })
  restore(@Param('id') id: string) {
    return this.categories.restore(id);
  }
}
