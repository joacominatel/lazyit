import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { AssetPurchaseProvenanceSchema } from '@lazyit/shared';
import { RequirePermission } from '../auth/require-permission.decorator';
import { PurchaseReceivingService } from './purchase-receiving.service';

class AssetPurchaseProvenanceDto extends createZodDto(
  AssetPurchaseProvenanceSchema,
) {}

/**
 * An asset's purchase provenance (ADR-0099 §8, CEO decision D-A): the asset page's *Purchase* panel —
 * supplier, reference, dates, the line and the purchase's documents. It lives with Purchases, not with the
 * assets controller, because its gate is `purchaseOrder:read` (plus `asset:read`): a principal without it —
 * a VIEWER by default — gets a 403 here, while the asset's own purchase fields stay on `GET /assets/:id`.
 */
@ApiTags('assets')
@Controller('assets')
export class AssetPurchaseController {
  constructor(private readonly receiving: PurchaseReceivingService) {}

  @Get(':id/purchase')
  @RequirePermission('asset:read', 'purchaseOrder:read')
  @ApiOperation({
    summary:
      "An asset's purchase provenance: its line, the purchase header with the supplier's support contact, and the purchase documents. Needs purchaseOrder:read (403 otherwise); 404 when the asset is not linked.",
  })
  @ApiOkResponse({ type: AssetPurchaseProvenanceDto })
  findOne(@Param('id') id: string) {
    return this.receiving.findAssetProvenance(id);
  }
}
