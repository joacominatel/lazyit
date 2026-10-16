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
  ConsumableCategoryDeleteImpactSchema,
  ConsumableCategorySchema,
  CreateConsumableCategorySchema,
  UpdateConsumableCategorySchema,
} from '@lazyit/shared';
import { ConsumableCategoriesService } from './consumable-categories.service';
import { RequirePermission } from '../auth/require-permission.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { Principal } from '../auth/principal';
import { parseDeleteResolution } from '../common/delete-resolution';

class ConsumableCategoryDto extends createZodDto(ConsumableCategorySchema) {}
class CreateConsumableCategoryDto extends createZodDto(
  CreateConsumableCategorySchema,
) {}
class UpdateConsumableCategoryDto extends createZodDto(
  UpdateConsumableCategorySchema,
) {}
class ConsumableCategoryDeleteImpactDto extends createZodDto(
  ConsumableCategoryDeleteImpactSchema,
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
  @RequirePermission('category:write')
  @ApiOperation({ summary: 'Create a consumable category (ADMIN or MEMBER)' })
  @ApiCreatedResponse({ type: ConsumableCategoryDto })
  create(@Body() dto: CreateConsumableCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @RequirePermission('category:write')
  @ApiOperation({ summary: 'Update a consumable category (ADMIN or MEMBER)' })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  update(@Param('id') id: string, @Body() dto: UpdateConsumableCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Get(':id/delete-impact')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'The live consumables deleting this category would detach or move (count, plus the first 50 when the caller may read consumables).',
  })
  @ApiOkResponse({ type: ConsumableCategoryDeleteImpactDto })
  deleteImpact(
    @Param('id') id: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.categories.deleteImpact(id, principal);
  }

  @Delete(':id')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'Soft-delete a consumable category — ADMIN only. While live consumables are filed under it, give ONE strategy for all of them (409 DELETE_RESOLUTION_REQUIRED otherwise).',
  })
  @ApiQuery({
    name: 'strategy',
    required: false,
    enum: ['detach', 'move'],
    description:
      'detach: the consumables keep no category. move: they all go to targetId.',
  })
  @ApiQuery({
    name: 'targetId',
    required: false,
    description: 'With strategy=move: another live consumable category.',
  })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  remove(
    @Param('id') id: string,
    @Query('strategy') strategy?: string,
    @Query('targetId') targetId?: string,
  ) {
    return this.categories.remove(
      id,
      parseDeleteResolution(strategy, targetId),
    );
  }

  @Post(':id/restore')
  @RequirePermission('category:delete')
  @ApiOperation({
    summary:
      'Restore a soft-deleted consumable category — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ConsumableCategoryDto })
  restore(@Param('id') id: string) {
    return this.categories.restore(id);
  }
}
