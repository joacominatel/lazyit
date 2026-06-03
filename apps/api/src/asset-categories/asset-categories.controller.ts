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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AssetCategorySchema,
  CreateAssetCategorySchema,
  UpdateAssetCategorySchema,
} from '@lazyit/shared';
import { AssetCategoriesService } from './asset-categories.service';
import { RequirePermission } from '../auth/require-permission.decorator';

class AssetCategoryDto extends createZodDto(AssetCategorySchema) {}
class CreateAssetCategoryDto extends createZodDto(CreateAssetCategorySchema) {}
class UpdateAssetCategoryDto extends createZodDto(UpdateAssetCategorySchema) {}

@ApiTags('asset-categories')
@Controller('asset-categories')
export class AssetCategoriesController {
  constructor(private readonly categories: AssetCategoriesService) {}

  @Get()
  @RequirePermission('category:read')
  @ApiOperation({ summary: 'List all asset categories (excludes soft-deleted)' })
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

  @Delete(':id')
  @RequirePermission('category:delete')
  @ApiOperation({ summary: 'Soft-delete an asset category — ADMIN only' })
  @ApiOkResponse({ type: AssetCategoryDto })
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
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
