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
  ConsumableListPageSchema,
  ConsumableMovementQuerySchema,
  ConsumableMovementSchema,
  ConsumableMovementTypeSchema,
  ConsumableSchema,
  CreateConsumableMovementSchema,
  CreateConsumableSchema,
  UpdateConsumableSchema,
} from '@lazyit/shared';
import {
  ConsumablesService,
  CONSUMABLE_SORT_ALLOWLIST,
} from './consumables.service';
import { parseBooleanQuery } from '../common/parse-boolean-query';
import { parsePageQuery } from '../common/parse-page-query';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { User } from '../../generated/prisma/client';

class ConsumableDto extends createZodDto(ConsumableSchema) {}
class ConsumableListPageDto extends createZodDto(ConsumableListPageSchema) {}
class CreateConsumableDto extends createZodDto(CreateConsumableSchema) {}
class UpdateConsumableDto extends createZodDto(UpdateConsumableSchema) {}
class ConsumableMovementDto extends createZodDto(ConsumableMovementSchema) {}
class CreateConsumableMovementDto extends createZodDto(
  CreateConsumableMovementSchema,
) {}

@ApiTags('consumables')
@Controller('consumables')
export class ConsumablesController {
  constructor(private readonly consumables: ConsumablesService) {}

  @Get()
  @ApiOperation({
    summary:
      'List consumables (paginated; excludes soft-deleted). Server-side q search + sort + lowStock filter.',
  })
  @ApiQuery({
    name: 'lowStock',
    required: false,
    type: Boolean,
    description: 'When true, only items at or below their reorder threshold.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on name, sku and description',
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
    enum: Object.keys(CONSUMABLE_SORT_ALLOWLIST),
    description:
      'Server-side sort field. Unknown field → 400. Default: name asc.',
  })
  @ApiQuery({
    name: 'dir',
    required: false,
    enum: ['asc', 'desc'],
    description: 'Sort direction (default asc when sort is set).',
  })
  @ApiOkResponse({ type: ConsumableListPageDto })
  findAll(
    @Query('lowStock') lowStock?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
  ) {
    return this.consumables.findPage(
      { lowStock: parseBooleanQuery(lowStock), q },
      parsePageQuery({ limit, offset, page, sort, dir }),
    );
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
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary: 'Create a consumable (stock starts at 0) (ADMIN or MEMBER)',
  })
  @ApiCreatedResponse({ type: ConsumableDto })
  create(@Body() dto: CreateConsumableDto) {
    return this.consumables.create(dto);
  }

  @Patch(':id')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary:
      'Update a consumable (currentStock is not editable) (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: ConsumableDto })
  update(@Param('id') id: string, @Body() dto: UpdateConsumableDto) {
    return this.consumables.update(id, dto);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @ApiOperation({ summary: 'Soft-delete a consumable — ADMIN only' })
  @ApiOkResponse({ type: ConsumableDto })
  remove(@Param('id') id: string) {
    return this.consumables.remove(id);
  }

  @Post(':id/restore')
  @Roles('ADMIN')
  @ApiOperation({
    summary: 'Restore a soft-deleted consumable — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ConsumableDto })
  restore(@Param('id') id: string) {
    return this.consumables.restore(id);
  }

  @Post(':id/movements')
  @Roles('ADMIN', 'MEMBER')
  @ApiOperation({
    summary:
      'Record a stock movement (IN adds, OUT subtracts, ADJUSTMENT sets) (ADMIN or MEMBER)',
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
