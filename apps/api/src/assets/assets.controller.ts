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
  AssetSchema,
  AssetStatusSchema,
  CreateAssetSchema,
  UpdateAssetSchema,
  type AssetStatus,
} from '@lazyit/shared';
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { parseActiveOnly } from '../asset-assignments/active-only';
import { AssetAssignmentDto } from '../asset-assignments/asset-assignment.dto';

class AssetDto extends createZodDto(AssetSchema) {}
class CreateAssetDto extends createZodDto(CreateAssetSchema) {}
class UpdateAssetDto extends createZodDto(UpdateAssetSchema) {}

@ApiTags('assets')
@Controller('assets')
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly assignments: AssetAssignmentsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List assets (excludes soft-deleted); optional category / location / status filters',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'locationId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: [...AssetStatusSchema.options] })
  @ApiOkResponse({ type: [AssetDto] })
  findAll(
    @Query('categoryId') categoryId?: string,
    @Query('locationId') locationId?: string,
    @Query('status') status?: string,
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
    return this.assets.findAll({ categoryId, locationId, status: parsedStatus });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an asset by id' })
  @ApiOkResponse({ type: AssetDto })
  findOne(@Param('id') id: string) {
    return this.assets.findOne(id);
  }

  @Get(':id/assignments')
  @ApiOperation({
    summary: "List an asset's ownership assignments (active-only by default)",
  })
  @ApiQuery({
    name: 'activeOnly',
    required: false,
    type: Boolean,
    description: 'Default true. Pass false to include released assignments.',
  })
  @ApiOkResponse({ type: [AssetAssignmentDto] })
  async findAssignments(
    @Param('id') id: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    await this.assets.findOne(id); // 404 if the asset is missing or soft-deleted
    return this.assignments.findAll({
      assetId: id,
      activeOnly: parseActiveOnly(activeOnly),
    });
  }

  @Post()
  @ApiOperation({ summary: 'Create an asset' })
  @ApiCreatedResponse({ type: AssetDto })
  create(@Body() dto: CreateAssetDto) {
    return this.assets.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an asset' })
  @ApiOkResponse({ type: AssetDto })
  update(@Param('id') id: string, @Body() dto: UpdateAssetDto) {
    return this.assets.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete an asset' })
  @ApiOkResponse({ type: AssetDto })
  remove(@Param('id') id: string) {
    return this.assets.remove(id);
  }
}
