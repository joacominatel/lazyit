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
  ConsumableCategorySchema,
  CreateConsumableCategorySchema,
  UpdateConsumableCategorySchema,
} from '@lazyit/shared';
import { ConsumableCategoriesService } from './consumable-categories.service';

class ConsumableCategoryDto extends createZodDto(ConsumableCategorySchema) {}
class CreateConsumableCategoryDto extends createZodDto(
  CreateConsumableCategorySchema,
) {}
class UpdateConsumableCategoryDto extends createZodDto(
  UpdateConsumableCategorySchema,
) {}

@ApiTags('consumable-categories')
@Controller('consumable-categories')
export class ConsumableCategoriesController {
  constructor(private readonly categories: ConsumableCategoriesService) {}

  @Get()
  @ApiOperation({
    summary: 'List all consumable categories (excludes soft-deleted)',
  })
  @ApiOkResponse({ type: [ConsumableCategoryDto] })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a consumable category by id' })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a consumable category' })
  @ApiCreatedResponse({ type: ConsumableCategoryDto })
  create(@Body() dto: CreateConsumableCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a consumable category' })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateConsumableCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Soft-delete a consumable category (detaches its consumables)',
  })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
