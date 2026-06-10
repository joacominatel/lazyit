import { Module } from '@nestjs/common';
import { ConsumablesController } from './consumables.controller';
import { ConsumablesService } from './consumables.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // Imports NotificationsModule so createMovement() can fire the best-effort post-commit `low_stock`
  // bell nudge through the exported NotificationsService (ADR-0056 §3).
  imports: [NotificationsModule],
  controllers: [ConsumablesController],
  providers: [ConsumablesService],
  exports: [ConsumablesService],
})
export class ConsumablesModule {}
