import { Module } from '@nestjs/common';
import { AssetTagSchemeController } from './asset-tag-scheme.controller';
import { AssetTagSchemeService } from './asset-tag-scheme.service';
import { AssetHistoryModule } from '../asset-history/asset-history.module';

/**
 * AssetTagSchemeModule — lazyit's first instance-config entity (ADR-0063, #363) + its existing-estate
 * awareness (ADR-0068, #547).
 *
 * Provides {@link AssetTagSchemeService} (the config read/upsert, the in-create skip-existing
 * allocation helper, and the seed-suggestion + backfill preview/apply surfaces) and the
 * `/config/asset-tag-scheme` controller. The service is EXPORTED because AssetsModule injects it to
 * auto-allocate a tag inside the asset-create transaction. Imports AssetHistoryModule because the
 * backfill writes one `AssetHistory` row per retag (ADR-0068 §3); ActorService comes from the @Global
 * CommonModule. Otherwise depends only on the @Global PrismaModule.
 */
@Module({
  imports: [AssetHistoryModule],
  controllers: [AssetTagSchemeController],
  providers: [AssetTagSchemeService],
  exports: [AssetTagSchemeService],
})
export class AssetTagSchemeModule {}
