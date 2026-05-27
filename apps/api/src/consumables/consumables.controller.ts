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
  ConsumableMovementQuerySchema,
  ConsumableMovementSchema,
  ConsumableMovementTypeSchema,
  ConsumableSchema,
  CreateConsumableMovementSchema,
  CreateConsumableSchema,
  UpdateConsumableSchema,
} from '@lazyit/shared';
import { ConsumablesService } from './consumables.service';
import { CurrentUser } from '../auth/current-user.decorator';
import type { User } from '../../generated/prisma/client';

class ConsumableDto extends createZodDto(ConsumableSchema) {}
class CreateConsumableDto extends createZodDto(CreateConsumableSchema) {}
class UpdateConsumableDto extends createZodDto(UpdateConsumableSchema) {}
class ConsumableMovementDto extends createZodDto(ConsumableMovementSchema) {}
class CreateConsumableMovementDto extends createZodDto(
  CreateConsumableMovementSchema,
) {}

@ApiBearerAuth()
@ApiTags('consumables')
@Controller('consumables')
export class ConsumablesController {
  constructor(private readonly consumables: ConsumablesService) {}

  @Get()
  @ApiOperation({ summary: 'List consumables (excludes soft-deleted)' })
  @ApiQuery({
    name: 'lowStock',
    required: false,
    type: Boolean,
    description: 'When true, only items at or below their reorder threshold.',
  })
  @ApiOkResponse({ type: [ConsumableDto] })
  findAll(@Query('lowStock') lowStock?: string) {
    return this.consumables.findAll({ lowStock: lowStock === 'true' });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a consumable by id' })
  @ApiOkResponse({ type: ConsumableDto })
  findOne(@Param('id') id: string) {
    return this.consumables.findOne(id);
  }

  @Get(':id/movements')
  @ApiOperation({
    summary: "List a consumable's stock movements (newest first)",
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: [...ConsumableMovementTypeSchema.options],
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'Inclusive lower bound on createdAt (ISO datetime).',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'Inclusive upper bound on createdAt (ISO datetime).',
  })
  @ApiOkResponse({ type: [ConsumableMovementDto] })
  async findMovements(
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const parsed = ConsumableMovementQuerySchema.safeParse({ type, from, to });
    if (!parsed.success) {
      throw new BadRequestException(
        'Invalid movement filters: type (IN|OUT|ADJUSTMENT) and from/to (ISO datetime)',
      );
    }
    return this.consumables.listMovements(id, parsed.data);
  }

  @Post()
  @ApiOperation({ summary: 'Create a consumable (stock starts at 0)' })
  @ApiCreatedResponse({ type: ConsumableDto })
  create(@Body() dto: CreateConsumableDto) {
    return this.consumables.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a consumable (currentStock is not editable)',
  })
  @ApiOkResponse({ type: ConsumableDto })
  update(@Param('id') id: string, @Body() dto: UpdateConsumableDto) {
    return this.consumables.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete a consumable' })
  @ApiOkResponse({ type: ConsumableDto })
  remove(@Param('id') id: string) {
    return this.consumables.remove(id);
  }

  @Post(':id/movements')
  @ApiOperation({
    summary:
      'Record a stock movement (IN adds, OUT subtracts, ADJUSTMENT sets)',
  })
  @ApiCreatedResponse({ type: ConsumableMovementDto })
  createMovement(
    @Param('id') id: string,
    @Body() dto: CreateConsumableMovementDto,
    @CurrentUser() user?: User,
  ) {
    return this.consumables.createMovement(id, dto, user);
  }
}
