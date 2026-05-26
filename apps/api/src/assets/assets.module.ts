import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetAssignmentsModule } from '../asset-assignments/asset-assignments.module';
import { AssetHistoryModule } from '../asset-history/asset-history.module';

@Module({
  imports: [AssetAssignmentsModule, AssetHistoryModule],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
