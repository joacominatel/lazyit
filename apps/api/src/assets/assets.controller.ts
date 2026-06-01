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
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import {
  AssetAssignmentWithUserSchema,
  AssetHistoryQuerySchema,
  AssetHistorySchema,
  AssetListPageSchema,
  AssetSchema,
  AssetStatusSchema,
  AssetWithRelationsSchema,
  CreateAssetSchema,
  UpdateAssetSchema,
  type AssetStatus,
} from '@lazyit/shared';
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { parseActiveOnly } from '../asset-assignments/active-only';
import { parsePageQuery } from '../common/parse-page-query';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { User } from '../../generated/prisma/client';

// Writes keep the lean Asset shape; the detail read returns the expanded AssetWithRelations, while
// the (paginated) list returns the trimmed AssetListItem envelope.
class AssetDto extends createZodDto(AssetSchema) {}
class CreateAssetDto extends createZodDto(CreateAssetSchema) {}
class UpdateAssetDto extends createZodDto(UpdateAssetSchema) {}
class AssetWithRelationsDto extends createZodDto(AssetWithRelationsSchema) {}
class AssetListPageDto extends createZodDto(AssetListPageSchema) {}
class AssetAssignmentWithUserDto extends createZodDto(
  AssetAssignmentWithUserSchema,
) {}
class AssetHistoryDto extends createZodDto(AssetHistorySchema) {}

@ApiBearerAuth()
@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly assignments: AssetAssignmentsService,
    private readonly history: AssetHistoryService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List assets (paginated; lean: model/category, location, activeAssignments — no specs). Excludes soft-deleted.',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'locationId', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...AssetStatusSchema.options],
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on name, serial and assetTag',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Page size. Default 50, max 200 (ADR-0030).',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Zero-based offset. Mutually redundant with page.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: '1-based page number (alternative to offset).',
  })
  @ApiOkResponse({ type: AssetListPageDto })
  findAll(
    @Query('categoryId') categoryId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    let parsedStatus: AssetStatus | undefined;
    if (status !== undefined) {
      const result = AssetStatusSchema.safeParse(status);
      if (!result.success) {
        throw new BadRequestException(
          `Invalid status. Expected one of: ${AssetStatusSchema.options.join(', ')}`,
        );
      }
      parsedStatus = result.data;
    }
    return this.assets.findPage(
      {
        categoryId,
        locationId,
        status: parsedStatus,
        q,
      },
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get an asset by id (expanded with its relations)',
  })
  @ApiOkResponse({ type: AssetWithRelationsDto })
  findOne(@Param('id') id: string) {
    return this.assets.findOne(id);
  }

  @Get(':id/assignments')
  @ApiOperation({
    summary:
      "List an asset's ownership assignments, each with its user (active-only by default)",
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include released assignments.',
  })
  @ApiOkResponse({ type: [AssetAssignmentWithUserDto] })
  async findAssignments(
    @Param('id') id: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    await this.assets.assertExists(id); // 404 if the asset is missing or soft-deleted
    return this.assignments.findAll({
      assetId: id,
      activeOnly: parseActiveOnly(activeOnly),
      includeUser: true,
    });
  }

  @Get(':id/history')
  @ApiOperation({
    summary:
      "List an asset's history (newest first; cursor pagination via `before`)",
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Default 50, max 100.',
  })
  @ApiQuery({
    name: 'before',
    required: false,
    type: Number,
    description: 'Cursor: return events with id < before.',
  })
  @ApiOkResponse({ type: [AssetHistoryDto] })
  async findHistory(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    await this.assets.assertExists(id); // 404 if the asset is missing or soft-deleted
    const parsed = AssetHistoryQuerySchema.safeParse({ limit, before });
    if (!parsed.success) {
      throw new BadRequestException(
        'Invalid pagination: limit (1-100) and before (positive integer)',
      );
    }
    return this.history.list(id, parsed.data);
  }

  @Post()
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Create an asset (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: AssetDto })
  create(@Body() dto: CreateAssetDto, @CurrentUser() user?: User) {
    return this.assets.create(dto, user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Update an asset (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: AssetDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() user?: User,
  ) {
    return this.assets.update(id, dto, user);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Soft-delete an asset — ADMIN only' })
  @ApiOkResponse({ type: AssetDto })
  remove(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.assets.remove(id, user);
  }

  @Post(':id/restore')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Restore a soft-deleted asset (emits a RESTORED history event) — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: AssetWithRelationsDto })
  restore(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.assets.restore(id, user);
  }
}
