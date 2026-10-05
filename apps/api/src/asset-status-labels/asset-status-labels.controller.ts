import {
  BadRequestException,
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
  AssetStatusLabelListQuerySchema,
  AssetStatusLabelSchema,
  AssetStatusSchema,
  CreateAssetStatusLabelSchema,
  DeleteAssetStatusLabelQuerySchema,
  DeleteAssetStatusLabelResultSchema,
  UpdateAssetStatusLabelSchema,
} from '@lazyit/shared';
import { AssetStatusLabelsService } from './asset-status-labels.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { assertCanListDeleted } from '../common/deleted-filter';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

class AssetStatusLabelDto extends createZodDto(AssetStatusLabelSchema) {}
class CreateAssetStatusLabelDto extends createZodDto(
  CreateAssetStatusLabelSchema,
) {}
class UpdateAssetStatusLabelDto extends createZodDto(
  UpdateAssetStatusLabelSchema,
) {}
class DeleteAssetStatusLabelResultDto extends createZodDto(
  DeleteAssetStatusLabelResultSchema,
) {}

/**
 * Custom asset statuses (ADR-0101, #1524) — taxonomy data under the CATEGORY permissions, no permission
 * of their own: read `category:read`, create/update `category:write`, archive/restore `category:delete`.
 */
@ApiTags('asset-status-labels')
@Controller('asset-status-labels')
export class AssetStatusLabelsController {
  constructor(private readonly labels: AssetStatusLabelsService) {}

  @Get()
  @RequirePermission('category:read')
  @ApiOperation({
    summary:
      'List the custom asset statuses, each with its live assetCount, ordered by built-in kind, then order, then name. deleted=only lists the archived ones (ADMIN).',
  })
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description:
      'Soft-delete slice. active (default) = live; only = archived — ADMIN only (403 otherwise). (ADR-0041)',
  })
  @ApiOkResponse({ type: [AssetStatusLabelDto] })
  findAll(@Query('deleted') deleted?: string, @CurrentUser() user?: User) {
    const query = AssetStatusLabelListQuerySchema.safeParse({ deleted });
    if (!query.success) {
      throw new BadRequestException('Invalid deleted: expected active|only');
    }
    assertCanListDeleted(query.data.deleted, user);
    return this.labels.findAll(query.data.deleted);
  }

  @Get(':id')
  @RequirePermission('category:read')
  @ApiOperation({ summary: 'Get a live custom asset status by id' })
  @ApiOkResponse({ type: AssetStatusLabelDto })
  findOne(@Param('id') id: string) {
    return this.labels.findOne(id);
  }

  @Post()
  @RequirePermission('category:write')
  @ApiOperation({
    summary:
      'Create a custom asset status mapped to a built-in status (kind). A live duplicate name is a 409.',
  })
  @ApiCreatedResponse({ type: AssetStatusLabelDto })
  create(@Body() dto: CreateAssetStatusLabelDto) {
    return this.labels.create(dto);
  }

  @Patch(':id')
  @RequirePermission('category:write')
  @ApiOperation({
    summary:
      'Update a custom asset status. Changing its kind while any asset carries it is a 409.',
  })
  @ApiOkResponse({ type: AssetStatusLabelDto })
  update(@Param('id') id: string, @Body() dto: UpdateAssetStatusLabelDto) {
    return this.labels.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'Archive a custom asset status. If assets carry it, give exactly one target (reassignLabelId or reassignStatus): they move there, with history, in the same transaction.',
  })
  @ApiQuery({
    name: 'reassignLabelId',
    required: false,
    description:
      'Move the assets to this other LIVE custom status (their built-in status becomes its kind).',
  })
  @ApiQuery({
    name: 'reassignStatus',
    required: false,
    enum: [...AssetStatusSchema.options],
    description: 'Move the assets to this bare built-in status.',
  })
  @ApiOkResponse({ type: DeleteAssetStatusLabelResultDto })
  remove(
    @Param('id') id: string,
    @Query('reassignLabelId') reassignLabelId?: string,
    @Query('reassignStatus') reassignStatus?: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    const target = DeleteAssetStatusLabelQuerySchema.safeParse({
      reassignLabelId,
      reassignStatus,
    });
    if (!target.success) {
      throw new BadRequestException(
        `Invalid reassign target: ${target.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    return this.labels.remove(id, target.data, principal);
  }

  @Post(':id/restore')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'Restore an archived custom asset status (ADR-0041). 409 if a live one took its name.',
  })
  @ApiOkResponse({ type: AssetStatusLabelDto })
  restore(@Param('id') id: string) {
    return this.labels.restore(id);
  }
}
