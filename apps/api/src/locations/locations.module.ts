import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { AssetHistoryModule } from '../asset-history/asset-history.module';
import { ExportModule } from '../common/export';

@Module({
  imports: [AssetHistoryModule, ExportModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
