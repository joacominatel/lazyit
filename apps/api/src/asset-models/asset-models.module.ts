import { Module } from '@nestjs/common';
import { AssetModelsController } from './asset-models.controller';
import { AssetModelsService } from './asset-models.service';
import { AssetHistoryModule } from '../asset-history/asset-history.module';

@Module({
  imports: [AssetHistoryModule],
  controllers: [AssetModelsController],
  providers: [AssetModelsService],
  exports: [AssetModelsService],
})
export class AssetModelsModule {}
