import { Module } from '@nestjs/common';
import { AccessGrantsController } from './access-grants.controller';
import { AccessGrantsService } from './access-grants.service';

@Module({
  controllers: [AccessGrantsController],
  providers: [AccessGrantsService],
  // Exported so UsersModule and ApplicationsModule can expose nested /access-grants endpoints.
  exports: [AccessGrantsService],
})
export class AccessGrantsModule {}
