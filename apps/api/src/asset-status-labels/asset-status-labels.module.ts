import { Module } from '@nestjs/common';
import { AssetStatusLabelsController } from './asset-status-labels.controller';
import { AssetStatusLabelsService } from './asset-status-labels.service';
import { AssetHistoryModule } from '../asset-history/asset-history.module';

/**
 * Custom asset statuses (ADR-0101, #1524). AssetHistoryModule provides the writer for the STATUS_CHANGED
 * events a delete-with-reassign records; ActorService and SearchService come from global modules.
 */
@Module({
  imports: [AssetHistoryModule],
  controllers: [AssetStatusLabelsController],
  providers: [AssetStatusLabelsService],
  exports: [AssetStatusLabelsService],
})
export class AssetStatusLabelsModule {}
