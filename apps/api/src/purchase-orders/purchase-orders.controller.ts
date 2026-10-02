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
  CreatePurchaseOrderLineSchema,
  CreatePurchaseOrderSchema,
  PurchaseOrderDetailSchema,
  PurchaseOrderEventPageSchema,
  PurchaseOrderLineSchema,
  PurchaseOrderListPageSchema,
  PurchaseOrderReceiptFilterSchema,
  PurchaseOrderSchema,
  PurchaseOrderStatusSchema,
  UpdatePurchaseOrderLineSchema,
  UpdatePurchaseOrderSchema,
  type PurchaseOrderReceiptFilter,
} from '@lazyit/shared';
import {
  PurchaseOrdersService,
  PURCHASE_ORDER_SORT_ALLOWLIST,
} from './purchase-orders.service';
import { parsePageQuery } from '../common/parse-page-query';
import { parseCuidQuery } from '../common/parse-cuid-query';
import { parseEnumArrayQuery } from '../common/parse-enum-array-query';
import { assertCanListDeleted } from '../common/deleted-filter';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

class PurchaseOrderDto extends createZodDto(PurchaseOrderSchema) {}
class PurchaseOrderDetailDto extends createZodDto(PurchaseOrderDetailSchema) {}
class PurchaseOrderListPageDto extends createZodDto(
  PurchaseOrderListPageSchema,
) {}
class PurchaseOrderLineDto extends createZodDto(PurchaseOrderLineSchema) {}
class PurchaseOrderEventPageDto extends createZodDto(
  PurchaseOrderEventPageSchema,
) {}
class CreatePurchaseOrderDto extends createZodDto(CreatePurchaseOrderSchema) {}
class UpdatePurchaseOrderDto extends createZodDto(UpdatePurchaseOrderSchema) {}
class CreatePurchaseOrderLineDto extends createZodDto(
  CreatePurchaseOrderLineSchema,
) {}
class UpdatePurchaseOrderLineDto extends createZodDto(
  UpdatePurchaseOrderLineSchema,
) {}

/** A single `receipt` filter value, or a 400 listing the allowed ones (ADR-0030). */
function parseReceiptQuery(
  value: string | undefined,
): PurchaseOrderReceiptFilter | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = PurchaseOrderReceiptFilterSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException(
      `Invalid receipt. Expected one of: ${PurchaseOrderReceiptFilterSchema.options.join(', ')}`,
    );
  }
  return parsed.data;
}

/**
 * Purchases (ADR-0099). `purchaseOrder:read` (ADMIN + MEMBER; VIEWER denied by default) to see them,
 * `:write` to create and edit purchases and their lines, `:delete` (ADMIN) to archive and restore. Every
 * write appends to the purchase's activity log in the same transaction, attributed to the caller.
 */
@ApiTags('purchase-orders')
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly purchases: PurchaseOrdersService) {}

  @Get()
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({
    summary:
      'List purchases (paginated; newest first). Each row carries its supplier, line count, derived receipt and totals per currency label.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Case-insensitive substring match on reference, invoice numbers, supplier name and line descriptions',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: [...PurchaseOrderStatusSchema.options],
    isArray: true,
    description: 'Comma-separated or repeated; values OR-combine.',
  })
  @ApiQuery({ name: 'supplierId', required: false })
  @ApiQuery({
    name: 'receipt',
    required: false,
    enum: [...PurchaseOrderReceiptFilterSchema.options],
    description:
      'A derived receipt state, or PENDING: at least one unit still pending on a purchase that is not CANCELLED.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(PURCHASE_ORDER_SORT_ALLOWLIST),
    description: 'Unknown field → 400. Default: createdAt desc.',
  })
  @ApiQuery({ name: 'dir', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'deleted',
    required: false,
    enum: ['active', 'only'],
    description: 'only = archived purchases — ADMIN only (403 otherwise).',
  })
  @ApiOkResponse({ type: PurchaseOrderListPageDto })
  findAll(
    @Query('q') q?: string,
    @Query('status') status?: string | string[],
    @Query('supplierId') supplierId?: string,
    @Query('receipt') receipt?: string,
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
    assertCanListDeleted(pageQuery.deleted, user);
    return this.purchases.findPage(
      {
        q,
        status: parseEnumArrayQuery(
          status,
          PurchaseOrderStatusSchema,
          'status',
        ),
        supplierId: parseCuidQuery(supplierId, 'supplierId'),
        receipt: parseReceiptQuery(receipt),
      },
      pageQuery,
    );
  }

  @Get(':id')
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({
    summary:
      'Get a purchase with its lines, derived received / pending counts, receipt state and totals per currency label',
  })
  @ApiOkResponse({ type: PurchaseOrderDetailDto })
  findOne(@Param('id') id: string) {
    return this.purchases.findOne(id);
  }

  @Get(':id/events')
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({
    summary: "A purchase's append-only activity log, newest first",
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: PurchaseOrderEventPageDto })
  findEvents(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.purchases.findEvents(
      id,
      parsePageQuery({ limit, offset, page }),
    );
  }

  @Post()
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary:
      'Create a purchase (lines may be given inline). Needs a supplier, a reference or one line; nothing is unique.',
  })
  @ApiCreatedResponse({ type: PurchaseOrderDetailDto })
  create(
    @Body() dto: CreatePurchaseOrderDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.purchases.create(dto, principal);
  }

  @Patch(':id')
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({ summary: 'Update a purchase header (null clears a field)' })
  @ApiOkResponse({ type: PurchaseOrderDetailDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePurchaseOrderDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.purchases.update(id, dto, principal);
  }

  @Delete(':id')
  @RequirePermission('purchaseOrder:delete')
  @ApiOperation({
    summary: 'Soft-delete a purchase — ADMIN only. Every asset link is kept.',
  })
  @ApiOkResponse({ type: PurchaseOrderDto })
  remove(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.purchases.remove(id, principal);
  }

  @Post(':id/restore')
  @RequirePermission('purchaseOrder:delete')
  @ApiOperation({
    summary: 'Restore a soft-deleted purchase — ADMIN only (ADR-0041)',
  })
  @ApiOkResponse({ type: PurchaseOrderDetailDto })
  restore(@Param('id') id: string, @CurrentPrincipal() principal?: Principal) {
    return this.purchases.restore(id, principal);
  }

  @Post(':id/lines')
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary: 'Add a line to a purchase. Only the description is required.',
  })
  @ApiCreatedResponse({ type: PurchaseOrderLineDto })
  addLine(
    @Param('id') id: string,
    @Body() dto: CreatePurchaseOrderLineDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.purchases.addLine(id, dto, principal);
  }

  @Patch(':id/lines/:lineId')
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary:
      'Update a line (null clears a field). The cancelled count may not exceed the quantity.',
  })
  @ApiOkResponse({ type: PurchaseOrderLineDto })
  updateLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdatePurchaseOrderLineDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.purchases.updateLine(id, lineId, dto, principal);
  }

  @Delete(':id/lines/:lineId')
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary:
      'Remove a line (soft delete) — only while no asset is linked to it (409 otherwise).',
  })
  @ApiOkResponse({ type: PurchaseOrderLineDto })
  removeLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.purchases.removeLine(id, lineId, principal);
  }
}
