import { Module } from '@nestjs/common';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

/**
 * Purchases (ADR-0099): purchase orders with their lines and activity log, and suppliers — one permission
 * domain (`purchaseOrder:*`), one module. ActorService and PrismaService come from global modules.
 */
@Module({
  controllers: [PurchaseOrdersController, SuppliersController],
  providers: [PurchaseOrdersService, SuppliersService],
})
export class PurchaseOrdersModule {}
