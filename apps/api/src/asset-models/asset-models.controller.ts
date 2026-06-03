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
  AssetModelSchema,
  CreateAssetModelSchema,
  UpdateAssetModelSchema,
} from '@lazyit/shared';
import { AssetModelsService } from './asset-models.service';
import { parseCuidQuery } from '../common/parse-cuid-query';
import { RequirePermission } from '../auth/require-permission.decorator';

class AssetModelDto extends createZodDto(AssetModelSchema) {}
class CreateAssetModelDto extends createZodDto(CreateAssetModelSchema) {}
class UpdateAssetModelDto extends createZodDto(UpdateAssetModelSchema) {}

@ApiTags('asset-models')
@Controller('asset-models')
export class AssetModelsController {
  constructor(private readonly models: AssetModelsService) {}

  @Get()
  @RequirePermission('assetModel:read')
  @ApiOperation({
    summary: 'List asset models (excludes soft-deleted); optional category filter',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiOkResponse({ type: [AssetModelDto] })
  findAll(@Query('categoryId') categoryId?: string) {
    return this.models.findAll(parseCuidQuery(categoryId, 'categoryId'));
  }

  @Get(':id')
  @RequirePermission('assetModel:read')
  @ApiOperation({ summary: 'Get an asset model by id' })
  @ApiOkResponse({ type: AssetModelDto })
  findOne(@Param('id') id: string) {
    return this.models.findOne(id);
  }

  @Post()
  @RequirePermission('assetModel:write')
  @ApiOperation({ summary: 'Create an asset model (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: AssetModelDto })
  create(@Body() dto: CreateAssetModelDto) {
    return this.models.create(dto);
  }

  @Patch(':id')
  @RequirePermission('assetModel:write')
  @ApiOperation({ summary: 'Update an asset model (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: AssetModelDto })
  update(@Param('id') id: string, @Body() dto: UpdateAssetModelDto) {
    return this.models.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('assetModel:delete')
  @ApiOperation({ summary: 'Soft-delete an asset model — ADMIN only' })
  @ApiOkResponse({ type: AssetModelDto })
  remove(@Param('id') id: string) {
    return this.models.remove(id);
  }

  @Post(':id/restore')
  @RequirePermission('assetModel:delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted asset model — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: AssetModelDto })
  restore(@Param('id') id: string) {
    return this.models.restore(id);
  }
}
