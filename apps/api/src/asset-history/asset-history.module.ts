import { Module } from '@nestjs/common';
import { AssetHistoryService } from './asset-history.service';

/**
 * Provides the {@link AssetHistoryService}. Imported by the Assets and AssetAssignments modules,
 * which emit asset events; the read endpoint (`GET /assets/:id/history`) lives on AssetsController.
 */
@Module({
  providers: [AssetHistoryService],
  exports: [AssetHistoryService],
})
export class AssetHistoryModule {}
