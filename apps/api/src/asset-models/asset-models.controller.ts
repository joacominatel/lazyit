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

class AssetModelDto extends createZodDto(AssetModelSchema) {}
class CreateAssetModelDto extends createZodDto(CreateAssetModelSchema) {}
class UpdateAssetModelDto extends createZodDto(UpdateAssetModelSchema) {}

@ApiTags('asset-models')
@Controller('asset-models')
export class AssetModelsController {
  constructor(private readonly models: AssetModelsService) {}

  @Get()
  @ApiOperation({
    summary: 'List asset models (excludes soft-deleted); optional category filter',
  })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiOkResponse({ type: [AssetModelDto] })
  findAll(@Query('categoryId') categoryId?: string) {
    return this.models.findAll(categoryId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an asset model by id' })
  @ApiOkResponse({ type: AssetModelDto })
  findOne(@Param('id') id: string) {
    return this.models.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create an asset model' })
  @ApiCreatedResponse({ type: AssetModelDto })
  create(@Body() dto: CreateAssetModelDto) {
    return this.models.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an asset model' })
  @ApiOkResponse({ type: AssetModelDto })
  update(@Param('id') id: string, @Body() dto: UpdateAssetModelDto) {
    return this.models.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete an asset model' })
  @ApiOkResponse({ type: AssetModelDto })
  remove(@Param('id') id: string) {
    return this.models.remove(id);
  }
}
