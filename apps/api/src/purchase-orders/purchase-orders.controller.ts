import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
  ApplyLicenseResultSchema,
  ApplyLicenseSchema,
  CreatePurchaseFromAssetsResultSchema,
  CreatePurchaseFromAssetsSchema,
  LicenseProposalSchema,
  PurchaseExtractionDraftSchema,
  PurchaseExtractionStatusSchema,
  CancelRemainingUnitsSchema,
  LinkAssetsResultSchema,
  LinkAssetsToLineSchema,
  PendingPurchaseLinePageSchema,
  PurchaseLinkPreviewRequestSchema,
  PurchaseLinkPreviewSchema,
  ReceiveFromLineResultSchema,
  ReceiveFromLineSchema,
  ReceiveStockFromLineResultSchema,
  ReceiveStockFromLineSchema,
  UnlinkAssetsFromLineSchema,
  UnlinkAssetsResultSchema,
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
import { PurchaseReceivingService } from './purchase-receiving.service';
import { PurchaseLicenseService } from './purchase-license.service';
import { PurchaseFromAssetsService } from './purchase-from-assets.service';
import { PurchaseExtractionService } from './extraction/purchase-extraction.service';
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
class PendingPurchaseLinePageDto extends createZodDto(
  PendingPurchaseLinePageSchema,
) {}
class PurchaseLinkPreviewRequestDto extends createZodDto(
  PurchaseLinkPreviewRequestSchema,
) {}
class PurchaseLinkPreviewDto extends createZodDto(PurchaseLinkPreviewSchema) {}
class LinkAssetsToLineDto extends createZodDto(LinkAssetsToLineSchema) {}
class LinkAssetsResultDto extends createZodDto(LinkAssetsResultSchema) {}
class UnlinkAssetsFromLineDto extends createZodDto(
  UnlinkAssetsFromLineSchema,
) {}
class UnlinkAssetsResultDto extends createZodDto(UnlinkAssetsResultSchema) {}
class ReceiveFromLineDto extends createZodDto(ReceiveFromLineSchema) {}
class ReceiveFromLineResultDto extends createZodDto(
  ReceiveFromLineResultSchema,
) {}
class ReceiveStockFromLineDto extends createZodDto(
  ReceiveStockFromLineSchema,
) {}
class ReceiveStockFromLineResultDto extends createZodDto(
  ReceiveStockFromLineResultSchema,
) {}
class CancelRemainingUnitsDto extends createZodDto(
  CancelRemainingUnitsSchema,
) {}
class PurchaseExtractionStatusDto extends createZodDto(
  PurchaseExtractionStatusSchema,
) {}
class PurchaseExtractionDraftDto extends createZodDto(
  PurchaseExtractionDraftSchema,
) {}
class LicenseProposalDto extends createZodDto(LicenseProposalSchema) {}
class ApplyLicenseDto extends createZodDto(ApplyLicenseSchema) {}
class ApplyLicenseResultDto extends createZodDto(ApplyLicenseResultSchema) {}
class CreatePurchaseFromAssetsDto extends createZodDto(
  CreatePurchaseFromAssetsSchema,
) {}
class CreatePurchaseFromAssetsResultDto extends createZodDto(
  CreatePurchaseFromAssetsResultSchema,
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
  constructor(
    private readonly purchases: PurchaseOrdersService,
    private readonly receiving: PurchaseReceivingService,
    private readonly licenses: PurchaseLicenseService,
    private readonly fromAssets: PurchaseFromAssetsService,
    private readonly extraction: PurchaseExtractionService,
  ) {}

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

  // STATIC route declared BEFORE `:id` so `/purchase-orders/pending-lines` never resolves as an id.
  @Get('pending-lines')
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({
    summary:
      'Lines still waiting for units (the Pending units tab): countable lines with pending > 0 on live purchases that are neither DRAFT nor CANCELLED, oldest purchase first, each with its purchase header.',
  })
  @ApiQuery({ name: 'supplierId', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiOkResponse({ type: PendingPurchaseLinePageDto })
  findPendingLines(
    @Query('supplierId') supplierId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('page') page?: string,
  ) {
    return this.receiving.findPendingLines(
      { supplierId: parseCuidQuery(supplierId, 'supplierId') },
      parsePageQuery({ limit, offset, page }),
    );
  }

  // STATIC route declared BEFORE `:id` (see pending-lines).
  @Get('extraction/status')
  @RequirePermission('purchaseOrder:read')
  @ApiOperation({
    summary:
      'Whether document extraction can be offered to the caller (ADR-0099 §11): available, or the reason it is not (AI_DISABLED, EXTRACTION_DISABLED, PROVIDER_UNSUPPORTED, NOT_PERMITTED), the document types the provider reads, the caps and the disclosure text.',
  })
  @ApiOkResponse({ type: PurchaseExtractionStatusDto })
  extractionStatus(@CurrentPrincipal() principal?: Principal) {
    return this.extraction.status(principal);
  }

  @Post('from-assets')
  @RequirePermission('purchaseOrder:write', 'asset:write')
  @ApiOperation({
    summary:
      'Create a purchase from selected existing assets: one ASSET line per model (assets without a model, per name), quantity = the assets, unit price from them only when all equal in the purchase currency. Links the assets and changes no other asset field. Partial success ({ purchaseOrder, linkedAssetIds, failed[] }); 409 with nothing created when none can be linked.',
  })
  @ApiCreatedResponse({ type: CreatePurchaseFromAssetsResultDto })
  createFromAssets(
    @Body() dto: CreatePurchaseFromAssetsDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.fromAssets.create(dto, principal);
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
      'Remove a line (soft delete) — only while nothing was received on it: no linked asset, no stock moved in (409 otherwise).',
  })
  @ApiOkResponse({ type: PurchaseOrderLineDto })
  removeLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.purchases.removeLine(id, lineId, principal);
  }

  @Post(':id/lines/:lineId/cancel-remaining')
  @RequirePermission('purchaseOrder:write')
  @ApiOperation({
    summary:
      'Cancel units that will not arrive: adds quantity (default every pending unit) to the cancelled count, with an optional reason in the activity log. 409 when nothing is pending; 400 beyond the pending count.',
  })
  @ApiCreatedResponse({ type: PurchaseOrderLineDto })
  cancelRemaining(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: CancelRemainingUnitsDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.purchases.cancelRemaining(id, lineId, dto, principal);
  }

  @Post(':id/lines/:lineId/receive')
  @RequirePermission('purchaseOrder:write', 'asset:write')
  @ApiOperation({
    summary:
      'Receive units of an ASSET line as new assets (the bulk-receive loop: each unit its own transaction and tag-counter commit). Prefilled from the purchase; the body only overrides. 400 when neither the line nor the body names a model. Over-receipt is allowed and flagged (overReceived).',
  })
  @ApiCreatedResponse({ type: ReceiveFromLineResultDto })
  receive(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: ReceiveFromLineDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.receiving.receiveFromLine(id, lineId, dto, principal);
  }

  @Post(':id/lines/:lineId/receive-stock')
  @RequirePermission('purchaseOrder:write', 'consumable:write')
  @ApiOperation({
    summary:
      "Receive units of a CONSUMABLE line into its consumable's stock: one IN movement through the consumables ledger, carrying the line id. 400 when the line is not CONSUMABLE, has no consumable or names an archived one. Over-receipt is allowed and flagged (overReceived).",
  })
  @ApiCreatedResponse({ type: ReceiveStockFromLineResultDto })
  receiveStock(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: ReceiveStockFromLineDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.receiving.receiveStock(id, lineId, dto, principal);
  }

  @Post(':id/attachments/:attachmentId/extract')
  @RequirePermission('purchaseOrder:write', 'ai:use')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Read a document attached to the purchase through the configured AI provider and return a DRAFT for review (ADR-0099 §11). Saves nothing to the purchase; records the token usage and an EXTRACTION_RUN event (no content). Human callers only. Refusals carry a code: 409 unavailable, 422 the document, 429 BUDGET_EXCEEDED, 502 the provider, 504 EXTRACTION_TIMEOUT.',
  })
  @ApiOkResponse({ type: PurchaseExtractionDraftDto })
  extract(
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.extraction.extract(id, attachmentId, principal);
  }

  @Get(':id/lines/:lineId/license-proposal')
  @RequirePermission('purchaseOrder:read', 'application:read')
  @ApiOperation({
    summary:
      "What applying a LICENSE line would do: the application's current seats and renewal, the line's pending seats as the default to add, the count afterwards and the warnings. Writes nothing.",
  })
  @ApiOkResponse({ type: LicenseProposalDto })
  licenseProposal(@Param('id') id: string, @Param('lineId') lineId: string) {
    return this.licenses.proposal(id, lineId);
  }

  @Post(':id/lines/:lineId/apply-license')
  @RequirePermission('purchaseOrder:write', 'application:write')
  @ApiOperation({
    summary:
      "Apply a LICENSE line to its application — explicit, never automatic: adds seatsToAdd to the application's seatsPurchased and/or sets its renewalDate (through the applications write path), and counts the seats as applied on the line. Over-application is allowed and flagged (overApplied). 400 for a line that is not LICENSE, has no application or names an archived one.",
  })
  @ApiCreatedResponse({ type: ApplyLicenseResultDto })
  applyLicense(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: ApplyLicenseDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.licenses.apply(id, lineId, dto, principal);
  }

  @Post(':id/lines/:lineId/link-preview')
  @RequirePermission('purchaseOrder:read', 'asset:read')
  @ApiOperation({
    summary:
      'The confirmation diff of a link (a read with a body): the values the line offers and, per asset, current vs purchase value per field with FILL / REPLACE / SAME / UNAVAILABLE. Writes nothing.',
  })
  @ApiCreatedResponse({ type: PurchaseLinkPreviewDto })
  linkPreview(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: PurchaseLinkPreviewRequestDto,
  ) {
    return this.receiving.linkPreview(id, lineId, dto.assetIds);
  }

  @Post(':id/lines/:lineId/link-assets')
  @RequirePermission('purchaseOrder:write', 'asset:write')
  @ApiOperation({
    summary:
      'Link existing assets to an ASSET line (partial success: { linked, failed[], overReceived, line }). Purchase values are copied only for the fields listed in apply / applyByAsset. An asset on another line moves only with move: true.',
  })
  @ApiCreatedResponse({ type: LinkAssetsResultDto })
  linkAssets(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: LinkAssetsToLineDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.receiving.linkAssets(id, lineId, dto, principal);
  }

  @Post(':id/lines/:lineId/unlink-assets')
  @RequirePermission('purchaseOrder:write', 'asset:write')
  @ApiOperation({
    summary:
      "Unlink assets from a line (one or many, partial success). The assets' purchase values are never cleared.",
  })
  @ApiCreatedResponse({ type: UnlinkAssetsResultDto })
  unlinkAssets(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UnlinkAssetsFromLineDto,
    @CurrentPrincipal() principal?: Principal,
  ) {
    return this.receiving.unlinkAssets(id, lineId, dto.assetIds, principal);
  }
}
