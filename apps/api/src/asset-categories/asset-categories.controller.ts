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
  AssetCategoryDeleteImpactSchema,
  AssetCategorySchema,
  CreateAssetCategorySchema,
  UpdateAssetCategorySchema,
} from '@lazyit/shared';
import { AssetCategoriesService } from './asset-categories.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { parseDeleteResolution } from '../common/delete-resolution';

class AssetCategoryDto extends createZodDto(AssetCategorySchema) {}
class CreateAssetCategoryDto extends createZodDto(CreateAssetCategorySchema) {}
class UpdateAssetCategoryDto extends createZodDto(UpdateAssetCategorySchema) {}
class AssetCategoryDeleteImpactDto extends createZodDto(
  AssetCategoryDeleteImpactSchema,
) {}

@ApiTags('asset-categories')
@Controller('asset-categories')
export class AssetCategoriesController {
  constructor(private readonly categories: AssetCategoriesService) {}

  @Get()
  @RequirePermission('category:read')
  @ApiOperation({
    summary: 'List all asset categories (excludes soft-deleted)',
  })
  @ApiOkResponse({ type: [AssetCategoryDto] })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @RequirePermission('category:read')
  @ApiOperation({ summary: 'Get an asset category by id' })
  @ApiOkResponse({ type: AssetCategoryDto })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @RequirePermission('category:write')
  @ApiOperation({ summary: 'Create an asset category (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: AssetCategoryDto })
  create(@Body() dto: CreateAssetCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @RequirePermission('category:write')
  @ApiOperation({ summary: 'Update an asset category (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: AssetCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateAssetCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Get(':id/delete-impact')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'The live asset models deleting this category would detach or move, and their live assets (counts, plus the first 50 of each kind the caller may read).',
  })
  @ApiOkResponse({ type: AssetCategoryDeleteImpactDto })
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
      'Soft-delete an asset category — ADMIN only. While live asset models are filed under it, give ONE strategy for all of them (409 DELETE_RESOLUTION_REQUIRED otherwise).',
  })
  @ApiQuery({
    name: 'strategy',
    required: false,
    enum: ['detach', 'move'],
    description:
      'detach: the models keep no category. move: they all go to targetId. Their assets follow their model.',
  })
  @ApiQuery({
    name: 'targetId',
    required: false,
    description: 'With strategy=move: another live asset category.',
  })
  @ApiOkResponse({ type: AssetCategoryDto })
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
    summary: 'Restore a soft-deleted asset category — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: AssetCategoryDto })
  restore(@Param('id') id: string) {
    return this.categories.restore(id);
  }
}
