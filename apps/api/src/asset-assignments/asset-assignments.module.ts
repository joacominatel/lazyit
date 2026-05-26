import { Module } from '@nestjs/common';
import { AssetAssignmentsController } from './asset-assignments.controller';
import { AssetAssignmentsService } from './asset-assignments.service';
import { AssetHistoryModule } from '../asset-history/asset-history.module';

@Module({
  imports: [AssetHistoryModule],
  controllers: [AssetAssignmentsController],
  providers: [AssetAssignmentsService],
  // Exported so AssetsModule and UsersModule can expose nested /assignments endpoints.
  exports: [AssetAssignmentsService],
})
export class AssetAssignmentsModule {}
