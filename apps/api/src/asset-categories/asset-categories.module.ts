import { Module } from '@nestjs/common';
import { AssetCategoriesController } from './asset-categories.controller';
import { AssetCategoriesService } from './asset-categories.service';

@Module({
  controllers: [AssetCategoriesController],
  providers: [AssetCategoriesService],
  exports: [AssetCategoriesService],
})
export class AssetCategoriesModule {}
