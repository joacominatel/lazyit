import { Module } from '@nestjs/common';
import { AssetHistoryModule } from '../asset-history/asset-history.module';
import { AssetsModule } from '../assets/assets.module';
import { AssetPurchaseController } from './asset-purchase.controller';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseReceivingService } from './purchase-receiving.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * Purchases (ADR-0099): purchase orders with their lines and activity log, suppliers, and the flows that
 * move units — receiving from a line (through the assets bulk-receive loop), linking assets, pending units
 * and an asset's provenance. One permission domain (`purchaseOrder:*`), one module. ActorService and
 * PrismaService come from global modules; a purchase's documents are served by the attachments module.
 */
@Module({
  imports: [AssetsModule, AssetHistoryModule],
  controllers: [
    PurchaseOrdersController,
    SuppliersController,
    AssetPurchaseController,
  ],
  providers: [
    PurchaseOrdersService,
    SuppliersService,
    PurchaseReceivingService,
  ],
})
export class PurchaseOrdersModule {}
