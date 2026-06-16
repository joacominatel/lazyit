import { Module } from '@nestjs/common';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetAssignmentsModule } from '../asset-assignments/asset-assignments.module';
import { AssetHistoryModule } from '../asset-history/asset-history.module';
import { ArticlesModule } from '../articles/articles.module';
import { AssetTagSchemeModule } from '../asset-tag-scheme/asset-tag-scheme.module';

@Module({
  // ArticlesModule provides ArticlesService for the reverse GET /assets/:id/articles (ADR-0042).
  // AssetTagSchemeModule provides AssetTagSchemeService for in-create auto-tag allocation (ADR-0063).
  imports: [
    AssetAssignmentsModule,
    AssetHistoryModule,
    ArticlesModule,
    AssetTagSchemeModule,
  ],
  controllers: [AssetsController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
