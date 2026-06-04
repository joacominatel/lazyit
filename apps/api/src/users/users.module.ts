import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AssetAssignmentsModule } from '../asset-assignments/asset-assignments.module';
import { AccessGrantsModule } from '../access-grants/access-grants.module';
import { UserHistoryModule } from '../user-history/user-history.module';

@Module({
  // UserHistoryModule (DEBT-2, issue #185) provides the append-only User lifecycle log the service
  // emits on every write-path, alongside the asset/access modules used by offboarding.
  imports: [AssetAssignmentsModule, AccessGrantsModule, UserHistoryModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
