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
  AssetModelListPageSchema,
  AssetModelSchema,
  CreateAssetModelSchema,
  UpdateAssetModelSchema,
} from '@lazyit/shared';
import {
  ASSET_MODEL_SORT_ALLOWLIST,
  AssetModelsService,
} from './asset-models.service';
import { parseCuidQuery } from '../common/parse-cuid-query';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../../generated/prisma/client';
import { RequirePermission } from '../auth/require-permission.decorator';

class AssetModelDto extends createZodDto(AssetModelSchema) {}
class AssetModelListPageDto extends createZodDto(AssetModelListPageSchema) {}
class CreateAssetModelDto extends createZodDto(CreateAssetModelSchema) {}
class UpdateAssetModelDto extends createZodDto(UpdateAssetModelSchema) {}

@ApiTags('asset-models')
@Controller('asset-models')
export class AssetModelsController {
  constructor(private readonly models: AssetModelsService) {}

  @Get()
  @RequirePermission('assetModel:read')
  @ApiOperation({
    summary:
      'List asset models, paged (ADR-0030); optional q search + category filter',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Case-insensitive substring over name / manufacturer / sku.',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(ASSET_MODEL_SORT_ALLOWLIST),
    description:
      'Server-side sort field. Unknown field → 400. Default: createdAt desc.',
  })
  @ApiQuery({
    name: 'dir',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort direction (default asc when sort is set).',
  })
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description:
      'Soft-delete slice. active (default) = live rows; only = archived (soft-deleted) rows — ADMIN only (403 otherwise). (ADR-0041)',
  })
  @ApiOkResponse({ type: AssetModelListPageDto })
  findAll(
    @Query('q') q?: string,
    @Query('categoryId') categoryId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
    @Query('deleted') deleted?: string,
    @CurrentUser() user?: User,
  ) {
    const pageQuery = parsePageQuery({
      limit,
      offset,
      page,
      sort,
      dir,
      deleted,
    });
    // The list route is gated only on assetModel:read (a MEMBER/VIEWER may list ACTIVE rows), so gate
    // the privileged archived slice here: deleted=only is ADMIN-only (403 otherwise). (ADR-0041)
    assertCanListDeleted(pageQuery.deleted, user);
    return this.models.findPage(
      { q, categoryId: parseCuidQuery(categoryId, 'categoryId') },
      pageQuery,
    );
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
