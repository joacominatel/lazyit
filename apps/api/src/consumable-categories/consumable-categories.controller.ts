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
import { Roles } from '../auth/roles.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';

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
  @RequirePermission('category:read')
  @ApiOperation({
    summary: 'List all consumable categories (excludes soft-deleted)',
  })
  @ApiOkResponse({ type: [ConsumableCategoryDto] })
  findAll() {
    return this.categories.findAll();
  }

  @Get(':id')
  @RequirePermission('category:read')
  @ApiOperation({ summary: 'Get a consumable category by id' })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  findOne(@Param('id') id: string) {
    return this.categories.findOne(id);
  }

  @Post()
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Create a consumable category (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: ConsumableCategoryDto })
  create(@Body() dto: CreateConsumableCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({ summary: 'Update a consumable category (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateConsumableCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Soft-delete a consumable category (detaches its consumables) — ADMIN only',
  })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }

  @Post(':id/restore')
  @Roles('ADMIN')
  @ApiOperation({
    summary:
      'Restore a soft-deleted consumable category — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  restore(@Param('id') id: string) {
    return this.categories.restore(id);
  }
}
