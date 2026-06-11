import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AssetAssignmentsModule } from '../asset-assignments/asset-assignments.module';
import { AssetHistoryModule } from '../asset-history/asset-history.module';
import { AccessGrantsModule } from '../access-grants/access-grants.module';
import { UserHistoryModule } from '../user-history/user-history.module';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';

@Module({
  // UserHistoryModule (DEBT-2, issue #185) provides the append-only User lifecycle log the service
  // emits on every write-path, alongside the asset/access modules used by offboarding. ADR-0058 adds:
  //  - AssetHistoryModule — the clone emits an ASSIGNED asset-history row per cloned assignment;
  //  - WorkflowEngineModule — the clone's engine toggle fires ACCESS_GRANTED via WorkflowTriggerService.
  imports: [
    AssetAssignmentsModule,
    AssetHistoryModule,
    AccessGrantsModule,
    UserHistoryModule,
    WorkflowEngineModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
