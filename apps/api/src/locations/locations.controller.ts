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
  CreateLocationSchema,
  LocationSchema,
  UpdateLocationSchema,
} from '@lazyit/shared';
import { LocationsService } from './locations.service';
import { Roles } from '../auth/roles.decorator';

// DTOs from the shared zod schemas (validation + TS type + OpenAPI). See ADR-0018.
class LocationDto extends createZodDto(LocationSchema) {}
class CreateLocationDto extends createZodDto(CreateLocationSchema) {}
class UpdateLocationDto extends createZodDto(UpdateLocationSchema) {}

@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  @ApiOperation({ summary: 'List all locations (excludes soft-deleted)' })
  @ApiOkResponse({ type: [LocationDto] })
  findAll() {
    return this.locations.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a location by id' })
  @ApiOkResponse({ type: LocationDto })
  findOne(@Param('id') id: string) {
    return this.locations.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Create a location (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: LocationDto })
  create(@Body() dto: CreateLocationDto) {
    return this.locations.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Update a location (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: LocationDto })
  update(@Param('id') id: string, @Body() dto: UpdateLocationDto) {
    return this.locations.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Soft-delete a location — ADMIN only' })
  @ApiOkResponse({ type: LocationDto })
  remove(@Param('id') id: string) {
    return this.locations.remove(id);
  }

  @Post(':id/restore')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Restore a soft-deleted location — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: LocationDto })
  restore(@Param('id') id: string) {
    return this.locations.restore(id);
  }
}
