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
  CreateLocationSchema,
  LocationListPageSchema,
  LocationSchema,
  UpdateLocationSchema,
} from '@lazyit/shared';
import { LocationsService, LOCATION_SORT_ALLOWLIST } from './locations.service';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';

// DTOs from the shared zod schemas (validation + TS type + OpenAPI). See ADR-0018.
class LocationDto extends createZodDto(LocationSchema) {}
class LocationListPageDto extends createZodDto(LocationListPageSchema) {}
class CreateLocationDto extends createZodDto(CreateLocationSchema) {}
class UpdateLocationDto extends createZodDto(UpdateLocationSchema) {}

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  @RequirePermission('location:read')
  @ApiOperation({
    summary:
      'List locations (paginated; active by default). Server-side q search + sort. deleted=only lists archived rows (ADMIN).',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on name, address, floor and description',
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
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(LOCATION_SORT_ALLOWLIST),
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
  @ApiOkResponse({ type: LocationListPageDto })
  findAll(
    @Query('q') q?: string,
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
    // The list route carries no @Roles (any authenticated user may list ACTIVE rows), so gate the
    // privileged archived slice here: deleted=only is ADMIN-only (403 otherwise). (ADR-0041)
    assertCanListDeleted(pageQuery.deleted, user);
    return this.locations.findPage({ q }, pageQuery);
  }

  @Get(':id')
  @RequirePermission('location:read')
  @ApiOperation({ summary: 'Get a location by id' })
  @ApiOkResponse({ type: LocationDto })
  findOne(@Param('id') id: string) {
    return this.locations.findOne(id);
  }

  @Post()
  @RequirePermission('location:write')
  @ApiOperation({ summary: 'Create a location (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: LocationDto })
  create(@Body() dto: CreateLocationDto) {
    return this.locations.create(dto);
  }

  @Patch(':id')
  @RequirePermission('location:write')
  @ApiOperation({ summary: 'Update a location (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: LocationDto })
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.locations.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('location:delete')
  @ApiOperation({ summary: 'Soft-delete a location — ADMIN only' })
  @ApiOkResponse({ type: LocationDto })
  remove(@Param('id') id: string) {
    return this.locations.remove(id);
  }

  @Post(':id/restore')
  @RequirePermission('location:delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted location — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: LocationDto })
  restore(@Param('id') id: string) {
    return this.locations.restore(id);
  }
}
