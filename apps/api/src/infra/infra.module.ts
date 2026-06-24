import { Module } from '@nestjs/common';
import { InfraController } from './infra.controller';
import { InfraService } from './infra.service';
import { AssetsModule } from '../assets/assets.module';
import { AssetAssignmentsModule } from '../asset-assignments/asset-assignments.module';
import { ArticlesModule } from '../articles/articles.module';

@Module({
  // The infra topology graph (ADR-0070). Reuses the existing machinery rather than reinventing it:
  //   - AssetsModule → AssetsService: asset-backed node create (default-on) + detach soft-delete (§5).
  //   - AssetAssignmentsModule → owner resolution via the active AssetAssignment (asset-centric, §6).
  //   - ArticlesModule → ArticlesService: the drill-in's KB links (reverse, folder-scoped, §6).
  imports: [AssetsModule, AssetAssignmentsModule, ArticlesModule],
  controllers: [InfraController],
  providers: [InfraService],
  exports: [InfraService],
})
export class InfraModule {}
