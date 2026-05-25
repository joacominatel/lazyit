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
  ApplicationSchema,
  CreateApplicationSchema,
  UpdateApplicationSchema,
} from '@lazyit/shared';
import { ApplicationsService } from './applications.service';
import { AccessGrantsService } from '../access-grants/access-grants.service';
import {
  parseActiveOnly,
  parseIncludeExpired,
} from '../access-grants/query-params';
import { AccessGrantDto } from '../access-grants/access-grant.dto';

class ApplicationDto extends createZodDto(ApplicationSchema) {}
class CreateApplicationDto extends createZodDto(CreateApplicationSchema) {}
class UpdateApplicationDto extends createZodDto(UpdateApplicationSchema) {}

@ApiTags('applications')
@Controller('applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly grants: AccessGrantsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List all applications (excludes soft-deleted)' })
  @ApiOkResponse({ type: [ApplicationDto] })
  findAll() {
    return this.applications.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an application by id' })
  @ApiOkResponse({ type: ApplicationDto })
  findOne(@Param('id') id: string) {
    return this.applications.findOne(id);
  }

  @Get(':id/access-grants')
  @ApiOperation({
    summary: "List an application's access grants (active-only by default)",
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include revoked grants.',
  })
  @ApiQuery({
    name: 'includeExpired',
    required: false,
    type: Boolean,
    description:
      'Default true. Pass false to hide active grants already past their expiresAt.',
  })
  @ApiOkResponse({ type: [AccessGrantDto] })
  async findGrants(
    @Param('id') id: string,
    @Query('activeOnly') activeOnly?: string,
    @Query('includeExpired') includeExpired?: string,
  ) {
    await this.applications.findOne(id); // 404 if the application is missing or soft-deleted
    return this.grants.findAll({
      applicationId: id,
      activeOnly: parseActiveOnly(activeOnly),
      includeExpired: parseIncludeExpired(includeExpired),
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create an application' })
  @ApiCreatedResponse({ type: ApplicationDto })
  create(@Body() dto: CreateApplicationDto) {
    return this.applications.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an application' })
  @ApiOkResponse({ type: ApplicationDto })
  update(@Param('id') id: string, @Body() dto: UpdateApplicationDto) {
    return this.applications.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete an application' })
  @ApiOkResponse({ type: ApplicationDto })
  remove(@Param('id') id: string) {
    return this.applications.remove(id);
  }
}
