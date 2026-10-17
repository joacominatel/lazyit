import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { AccessGrantsModule } from '../access-grants/access-grants.module';
import { ArticlesModule } from '../articles/articles.module';
import { ExportModule } from '../common/export';

@Module({
  // AccessGrantsModule → nested /applications/:id/access-grants; ArticlesModule → ArticlesService for
  // the reverse GET /applications/:id/articles (ADR-0042).
  imports: [AccessGrantsModule, ArticlesModule, ExportModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
