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
import { Roles } from '../auth/roles.decorator';

class AssetCategoryDto extends createZodDto(AssetCategorySchema) {}
class CreateAssetCategoryDto extends createZodDto(CreateAssetCategorySchema) {}
class UpdateAssetCategoryDto extends createZodDto(UpdateAssetCategorySchema) {}

@ApiTags('asset-categories')
@Controller('asset-categories')
export class AssetCategoriesController {
  constructor(private readonly categories: AssetCategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List all asset categories (excludes soft-deleted)' })
  @ApiOkResponse({ type: [AssetCategoryDto] })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an asset category by id' })
  @ApiOkResponse({ type: AssetCategoryDto })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Create an asset category (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: AssetCategoryDto })
  create(@Body() dto: CreateAssetCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Update an asset category (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: AssetCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateAssetCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Soft-delete an asset category — ADMIN only' })
  @ApiOkResponse({ type: AssetCategoryDto })
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }

  @Post(':id/restore')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Restore a soft-deleted asset category — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: AssetCategoryDto })
  restore(@Param('id') id: string) {
    return this.categories.restore(id);
  }
}
