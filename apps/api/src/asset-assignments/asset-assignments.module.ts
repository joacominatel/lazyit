import { Module } from '@nestjs/common';
import { AssetAssignmentsController } from './asset-assignments.controller';
import { AssetAssignmentsService } from './asset-assignments.service';
import { AssetHistoryModule } from '../asset-history/asset-history.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // NotificationsModule exports NotificationsService — the post-commit targeted nudge on acknowledgement
  // (ADR-0089 Part B, #1029). No cycle: NotificationsModule never imports this module.
  imports: [AssetHistoryModule, NotificationsModule],
  controllers: [AssetAssignmentsController],
  providers: [AssetAssignmentsService],
  // Exported so AssetsModule and UsersModule can expose nested /assignments endpoints.
  exports: [AssetAssignmentsService],
})
export class AssetAssignmentsModule {}
