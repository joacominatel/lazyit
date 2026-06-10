import { Module } from '@nestjs/common';
import { AccessGrantsController } from './access-grants.controller';
import { AccessGrantsService } from './access-grants.service';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // Imports the engine so the grant tx can fire the workflow transactional outbox
  // (WorkflowTriggerService, exported by WorkflowEngineModule) — the INV-5-inverse decoupling.
  // Imports NotificationsModule so create() can fire best-effort post-commit bell nudges
  // (critical_app_access / admin_granted) through the exported NotificationsService (ADR-0056 §3).
  imports: [WorkflowEngineModule, NotificationsModule],
  controllers: [AccessGrantsController],
  providers: [AccessGrantsService],
  // Exported so UsersModule and ApplicationsModule can expose nested /access-grants endpoints.
  exports: [AccessGrantsService],
})
export class AccessGrantsModule {}
