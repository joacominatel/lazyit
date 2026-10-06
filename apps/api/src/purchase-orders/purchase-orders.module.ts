import { Module } from '@nestjs/common';
import { AssetHistoryModule } from '../asset-history/asset-history.module';
import { AssetsModule } from '../assets/assets.module';
import { ConsumablesModule } from '../consumables/consumables.module';
import { ApplicationsModule } from '../applications/applications.module';
import { AiProvidersModule } from '../ai/providers/ai-providers.module';
import { AiSettingsModule } from '../ai/settings/ai-settings.module';
import { AiRunLimits } from '../ai/runtime/limits';
import { PurchaseExtractionService } from './extraction/purchase-extraction.service';
import { PurchaseFromAssetsService } from './purchase-from-assets.service';
import { PurchaseLicenseService } from './purchase-license.service';
import { AssetPurchaseController } from './asset-purchase.controller';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseReceivingService } from './purchase-receiving.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * Purchases (ADR-0099): purchase orders with their lines and activity log, suppliers, and the flows that
 * move units — receiving from a line (through the assets bulk-receive loop, or into stock through the
 * consumables ledger for a CONSUMABLE line), linking assets, pending units and an asset's provenance. One permission domain (`purchaseOrder:*`), one module. ActorService and
 * PrismaService come from global modules; a purchase's documents are served by the attachments module.
 *
 * Phase 2 (#1477): LICENSE lines applied through `ApplicationsService` (ApplicationsModule), a purchase
 * created from selected assets, and document extraction — through the AI settings reader (AiSettingsModule)
 * and the structured-extraction port (AiProvidersModule). `AiRunLimits` is provided here for its persisted
 * token-budget read only (a stateless sum over `ai_usage`); its in-memory rate buckets are not used.
 */
@Module({
  imports: [
    AssetsModule,
    AssetHistoryModule,
    ConsumablesModule,
    ApplicationsModule,
    AiSettingsModule,
    AiProvidersModule,
  ],
  controllers: [
    PurchaseOrdersController,
    SuppliersController,
    AssetPurchaseController,
  ],
  providers: [
    PurchaseOrdersService,
    SuppliersService,
    PurchaseReceivingService,
    PurchaseLicenseService,
    PurchaseFromAssetsService,
    PurchaseExtractionService,
    AiRunLimits,
  ],
})
export class PurchaseOrdersModule {}
