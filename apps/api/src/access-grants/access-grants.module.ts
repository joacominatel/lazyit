import { Module } from '@nestjs/common';
import { AccessGrantsController } from './access-grants.controller';
import { AccessGrantsService } from './access-grants.service';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';

@Module({
  // Imports the engine so the grant tx can fire the workflow transactional outbox
  // (WorkflowTriggerService, exported by WorkflowEngineModule) — the INV-5-inverse decoupling.
  imports: [WorkflowEngineModule],
  controllers: [AccessGrantsController],
  providers: [AccessGrantsService],
  // Exported so UsersModule and ApplicationsModule can expose nested /access-grants endpoints.
  exports: [AccessGrantsService],
})
export class AccessGrantsModule {}
