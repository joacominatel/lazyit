import { Module } from '@nestjs/common';
import { AssetTagSchemeController } from './asset-tag-scheme.controller';
import { AssetTagSchemeService } from './asset-tag-scheme.service';

/**
 * AssetTagSchemeModule — lazyit's first instance-config entity (ADR-0063, #363).
 *
 * Provides {@link AssetTagSchemeService} (the config read/upsert + the in-create allocation helper)
 * and the `GET`/`PUT /config/asset-tag-scheme` controller. The service is EXPORTED because
 * AssetsModule injects it to auto-allocate a tag inside the asset-create transaction. Depends only on
 * the @Global PrismaModule.
 */
@Module({
  controllers: [AssetTagSchemeController],
  providers: [AssetTagSchemeService],
  exports: [AssetTagSchemeService],
})
export class AssetTagSchemeModule {}
