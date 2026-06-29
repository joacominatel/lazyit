import { Module } from '@nestjs/common';
import { AccessGrantsController } from './access-grants.controller';
import { AccessGrantsService } from './access-grants.service';
import { AccessGrantExpirySweeper } from './access-grant-expiry.sweeper';
import { WorkflowEngineModule } from '../workflow-engine/workflow-engine.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  // Imports the engine so the grant tx can fire the workflow transactional outbox
  // (WorkflowTriggerService, exported by WorkflowEngineModule) — the INV-5-inverse decoupling.
  // Imports NotificationsModule so create() can fire best-effort post-commit bell nudges
  // (critical_app_access / admin_granted) through the exported NotificationsService (ADR-0056 §3).
  imports: [WorkflowEngineModule, NotificationsModule],
  controllers: [AccessGrantsController],
  // AccessGrantExpirySweeper auto-revokes grants past their expiresAt through the service's revoke()
  // path (deprovision workflow + system attribution fire); a plain setInterval, like the other sweepers.
  providers: [AccessGrantsService, AccessGrantExpirySweeper],
  // Exported so UsersModule and ApplicationsModule can expose nested /access-grants endpoints.
  exports: [AccessGrantsService],
})
export class AccessGrantsModule {}
