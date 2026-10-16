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
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  ConsumableDeliveryPageSchema,
  ConsumableDeliveryQuerySchema,
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
import { parseCuidQuery } from '../common/parse-cuid-query';
import { parsePageQuery } from '../common/parse-page-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { ExportService } from '../common/export';
import {
  CONSUMABLE_EXPORT_COLUMNS,
  DELIVERY_EXPORT_COLUMNS,
  MOVEMENT_EXPORT_COLUMNS,
} from './consumables-export';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

class ConsumableDto extends createZodDto(ConsumableSchema) {}
class ConsumableListPageDto extends createZodDto(ConsumableListPageSchema) {}
class CreateConsumableDto extends createZodDto(CreateConsumableSchema) {}
class UpdateConsumableDto extends createZodDto(UpdateConsumableSchema) {}
class ConsumableMovementDto extends createZodDto(ConsumableMovementSchema) {}
class ConsumableDeliveryPageDto extends createZodDto(
  ConsumableDeliveryPageSchema,
) {}
class CreateConsumableMovementDto extends createZodDto(
  CreateConsumableMovementSchema,
) {}

function parseDeliveryQuery(query: Record<string, string | undefined>) {
  const parsed = ConsumableDeliveryQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new BadRequestException(
      'Invalid delivery filters: exactly one of targetUserId (uuid), targetAssetId (cuid) or targetLocationId (cuid); from/to (ISO datetime, from <= to)',
    );
  }
  return parsed.data;
}

function parseMovementQuery(query: Record<string, string | undefined>) {
  const parsed = ConsumableMovementQuerySchema.safeParse(query);
  if (!parsed.success) {
    throw new BadRequestException(
      'Invalid movement filters: type (IN|OUT|ADJUSTMENT) and from/to (ISO datetime)',
    );
  }
  return parsed.data;
}

@ApiTags('consumables')
@Controller('consumables')
export class ConsumablesController {
  constructor(
    private readonly consumables: ConsumablesService,
    private readonly exports: ExportService,
  ) {}

  @Get()
  @RequirePermission('consumable:read')
  @ApiOperation({
    summary:
      'List consumables (paginated; active by default). Server-side q search + sort + lowStock filter. deleted=only lists archived rows (ADMIN).',
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
    name: 'category',
    required: false,
    description:
      'Restrict to consumables in this category (a ConsumableCategory cuid). Invalid cuid → 400.',
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
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description:
      'Soft-delete slice. active (default) = live rows; only = archived (soft-deleted) rows — ADMIN only (403 otherwise). (ADR-0041)',
  })
  @ApiOkResponse({ type: ConsumableListPageDto })
  findAll(
    @Query('lowStock') lowStock?: string,
    @Query('q') q?: string,
    @Query('category') category?: string,
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
    return this.consumables.findPage(
      {
        lowStock: parseBooleanQuery(lowStock),
        q,
        categoryId: parseCuidQuery(category, 'category'),
      },
      pageQuery,
    );
  }

  // STATIC route declared BEFORE `:id` so `/consumables/export` never resolves as an id.
  @Get('export')
  @RequirePermission('consumable:read')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      'CSV export of every consumable matching the list filters (ADR-0103): same permission, filters and rows as GET /consumables, newest first. Refused above 100,000 rows (422); one running export and five a minute per caller (429). Every export is audited. deleted=only is ADMIN only (403 otherwise).',
  })
  @ApiQuery({ name: 'lowStock', required: false, type: Boolean })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'deleted', required: false, enum: ['active', 'only'] })
  @ApiOkResponse({ description: 'The filtered consumables as CSV (text/csv).' })
  export(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
    @Query('lowStock') lowStock?: string,
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('deleted') deleted?: string,
    @CurrentUser() user?: User,
  ): Promise<StreamableFile> {
    const { deleted: slice } = parsePageQuery({ deleted });
    assertCanListDeleted(slice, user);
    const filters = {
      lowStock: parseBooleanQuery(lowStock),
      q,
      categoryId: parseCuidQuery(category, 'category'),
    };
    return this.exports.exportCsv({
      resource: 'CONSUMABLES',
      principal,
      response: res,
      filters: { ...filters, deleted: slice },
      columns: CONSUMABLE_EXPORT_COLUMNS,
      filename: 'consumables',
      ...this.consumables.exportSource(filters, slice),
    });
  }

  // Declared BEFORE `:id` so `deliveries` is never captured as a consumable id. Gated on
  // `consumable:read`; the service ALSO requires the target domain's read permission (`user:read` for a
  // person — a VIEWER lacks it, the ADR-0046 P3 directory-relational rule — `asset:read`,
  // `location:read`), else 403 (ADR-0098).
  @Get('deliveries')
  @RequirePermission('consumable:read')
  @ApiOperation({
    summary:
      'List the consumable deliveries made to ONE user, asset or location (paginated, newest first; ADR-0098)',
    description:
      'Exactly one of targetUserId / targetAssetId / targetLocationId is required (400 otherwise). ' +
      'Listing by targetUserId also requires user:read, by targetAssetId asset:read, by targetLocationId ' +
      'location:read (403 otherwise). Deliveries of soft-deleted consumables stay listed (the consumable ' +
      'carries its deletedAt), and a soft-deleted target is flagged in `target`, never a 404.',
  })
  @ApiQuery({
    name: 'targetUserId',
    required: false,
    description: 'Deliveries made to this user (uuid).',
  })
  @ApiQuery({
    name: 'targetAssetId',
    required: false,
    description: 'Deliveries made to this asset (cuid).',
  })
  @ApiQuery({
    name: 'targetLocationId',
    required: false,
    description: 'Deliveries left at this location (cuid).',
  })
  @ApiQuery({
    name: 'outstandingOnly',
    required: false,
    type: Boolean,
    description:
      'When true, only returnable deliveries with units still outstanding.',
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
  @ApiOkResponse({ type: ConsumableDeliveryPageDto })
  findDeliveries(
    @Query('targetUserId') targetUserId?: string,
    @Query('targetAssetId') targetAssetId?: string,
    @Query('targetLocationId') targetLocationId?: string,
    @Query('outstandingOnly') outstandingOnly?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.consumables.findDeliveries(
      parseDeliveryQuery({
        targetUserId,
        targetAssetId,
        targetLocationId,
        outstandingOnly,
        from,
        to,
      }),
      parsePageQuery({ limit, offset, page }),
      principal,
    );
  }

  @Get('deliveries/export')
  @RequirePermission('consumable:read')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      'CSV export of the deliveries made to ONE user, asset or location (ADR-0103): same permission, per-kind gate (403), filters, rows and target redaction as GET /consumables/deliveries, newest first. Refused above 100,000 rows (422); one running export and five a minute per caller (429). Every export is audited.',
  })
  @ApiQuery({ name: 'targetUserId', required: false })
  @ApiQuery({ name: 'targetAssetId', required: false })
  @ApiQuery({ name: 'targetLocationId', required: false })
  @ApiQuery({ name: 'outstandingOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiOkResponse({ description: 'The filtered deliveries as CSV (text/csv).' })
  async exportDeliveries(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
    @Query('targetUserId') targetUserId?: string,
    @Query('targetAssetId') targetAssetId?: string,
    @Query('targetLocationId') targetLocationId?: string,
    @Query('outstandingOnly') outstandingOnly?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StreamableFile> {
    const filters = parseDeliveryQuery({
      targetUserId,
      targetAssetId,
      targetLocationId,
      outstandingOnly,
      from,
      to,
    });
    return this.exports.exportCsv({
      resource: 'CONSUMABLE_DELIVERIES',
      principal,
      response: res,
      filters: { ...filters },
      columns: DELIVERY_EXPORT_COLUMNS,
      filename: 'consumable-deliveries',
      ...(await this.consumables.deliveriesExportSource(filters, principal)),
    });
  }

  @Get(':id')
  @RequirePermission('consumable:read')
  @ApiOperation({ summary: 'Get a consumable by id' })
  @ApiOkResponse({ type: ConsumableDto })
  findOne(@Param('id') id: string) {
    return this.consumables.findOne(id);
  }

  @Get(':id/movements')
  @RequirePermission('consumable:read')
  @ApiOperation({
    summary: "List a consumable's stock movements (newest first)",
    description:
      'Each row carries its resolved delivery `target` (ADR-0098) — null when untargeted. The display ' +
      'fields are null when the caller lacks the target domain read permission (user:read / asset:read / ' +
      'location:read).',
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
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.consumables.listMovements(
      id,
      parseMovementQuery({ type, from, to }),
      principal,
    );
  }

  @Get(':id/movements/export')
  @RequirePermission('consumable:read')
  @ApiProduces('text/csv')
  @ApiOperation({
    summary:
      "CSV export of a consumable's stock movements (ADR-0103): same permission, filters, rows and target redaction as GET /consumables/:id/movements, newest first. Refused above 100,000 rows (422); one running export and five a minute per caller (429). Every export is audited.",
  })
  @ApiQuery({
    name: 'type',
    required: false,
    enum: [...ConsumableMovementTypeSchema.options],
  })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  @ApiOkResponse({ description: 'The filtered movements as CSV (text/csv).' })
  async exportMovements(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) res: Response,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<StreamableFile> {
    const filters = parseMovementQuery({ type, from, to });
    return this.exports.exportCsv({
      resource: 'CONSUMABLE_MOVEMENTS',
      principal,
      response: res,
      filters: { consumableId: id, ...filters },
      columns: MOVEMENT_EXPORT_COLUMNS,
      filename: 'consumable-movements',
      ...(await this.consumables.movementsExportSource(id, filters, principal)),
    });
  }

  @Post()
  @RequirePermission('consumable:write')
  @ApiOperation({
    summary: 'Create a consumable (stock starts at 0) (ADMIN or MEMBER)',
  })
  @ApiCreatedResponse({ type: ConsumableDto })
  create(@Body() dto: CreateConsumableDto) {
    return this.consumables.create(dto);
  }

  @Patch(':id')
  @RequirePermission('consumable:write')
  @ApiOperation({
    summary:
      'Update a consumable (currentStock is not editable) (ADMIN or MEMBER)',
  })
  @ApiOkResponse({ type: ConsumableDto })
  update(@Param('id') id: string, @Body() dto: UpdateConsumableDto) {
    return this.consumables.update(id, dto);
  }

  @Delete(':id')
  @RequirePermission('consumable:delete')
  @ApiOperation({ summary: 'Soft-delete a consumable — ADMIN only' })
  @ApiOkResponse({ type: ConsumableDto })
  remove(@Param('id') id: string) {
    return this.consumables.remove(id);
  }

  @Post(':id/restore')
  @RequirePermission('consumable:delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted consumable — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: ConsumableDto })
  restore(@Param('id') id: string) {
    return this.consumables.restore(id);
  }

  @Post(':id/movements')
  @RequirePermission('consumable:write')
  @ApiOperation({
    summary:
      'Record a stock movement (IN adds, OUT subtracts, ADJUSTMENT sets) (ADMIN or MEMBER)',
    description:
      'Delivery (ADR-0098): an OUT may name ONE target — targetUserId | targetAssetId | targetLocationId ' +
      '(a missing or soft-deleted target → 400); the consumable returnable flag is snapshotted onto it. ' +
      'Return: an IN with returnOfId gives back (part of) a returnable delivery of THIS consumable — a ' +
      'missing / foreign / untargeted / non-returnable delivery → 400; more than outstanding → 409. A ' +
      'delivery to (or return from) an asset appends CONSUMABLE_DELIVERED / CONSUMABLE_RETURNED to its history.',
  })
  @ApiCreatedResponse({ type: ConsumableMovementDto })
  createMovement(
    @Param('id') id: string,
    @Body() dto: CreateConsumableMovementDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.consumables.createMovement(id, dto, principal);
  }
}
