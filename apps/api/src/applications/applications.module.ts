import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { AccessGrantsModule } from '../access-grants/access-grants.module';

@Module({
  // Imports AccessGrantsModule for the nested /applications/:id/access-grants endpoint.
  imports: [AccessGrantsModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService],
  exports: [ApplicationsService],
})
export class ApplicationsModule {}
