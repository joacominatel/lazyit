import { Module } from '@nestjs/common';
import { AccessRequestsController } from './access-requests.controller';
import { AccessRequestsService } from './access-requests.service';
import { AccessGrantsModule } from '../access-grants/access-grants.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExportModule } from '../common/export';

/**
 * Self-service access requests (ADR-0085) — the request → approve/deny → grant flow that closes the
 * ADR-0023 deferral. Imports:
 *   - AccessGrantsModule — so approve() creates the grant through the EXISTING grant write path
 *     (AccessGrantsService.createWithinApproval), keeping engine provisioning + audit attribution intact.
 *   - NotificationsModule — so create() fires the best-effort post-commit `access_request.created` bell
 *     nudge to the admins who can decide.
 *   - ExportModule — the list's CSV export (ADR-0103).
 * PrismaService + ActorService are global (PrismaModule / CommonModule).
 */
@Module({
  imports: [AccessGrantsModule, NotificationsModule, ExportModule],
  controllers: [AccessRequestsController],
  providers: [AccessRequestsService],
})
export class AccessRequestsModule {}
