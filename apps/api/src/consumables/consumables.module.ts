import { Module } from '@nestjs/common';
import { ConsumablesController } from './consumables.controller';
import { ConsumablesService } from './consumables.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssetHistoryModule } from '../asset-history/asset-history.module';

@Module({
  // Imports NotificationsModule so createMovement() can fire the best-effort post-commit `low_stock`
  // bell nudge through the exported NotificationsService (ADR-0056 §3).
  // AssetHistoryModule: a delivery to / return from an ASSET appends CONSUMABLE_DELIVERED /
  // CONSUMABLE_RETURNED to its timeline in the movement's transaction (ADR-0098).
  imports: [NotificationsModule, AssetHistoryModule],
  controllers: [ConsumablesController],
  providers: [ConsumablesService],
  exports: [ConsumablesService],
})
export class ConsumablesModule {}
