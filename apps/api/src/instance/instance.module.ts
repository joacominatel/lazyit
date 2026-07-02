import { Module } from '@nestjs/common';
import { InstanceController } from './instance.controller';
import { UpdateController } from './update.controller';
import { UpdateService } from './update.service';
import { UpdateCheckSweeper } from './update-check.sweeper';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Instance module — the running build's identity (ADR-0083) PLUS update awareness & the guided update
 * (ADR-0084, #904).
 *
 * ADR-0083: `GET /instance/version` reads the build-time env directly (no service, no persistence).
 *
 * ADR-0084: the consumption half. {@link UpdateController} exposes the "Version & updates" card read,
 * the opt-in toggle, and the ENQUEUE-ONLY `POST /instance/update` (records an UpdateRun; executes
 * nothing). {@link UpdateService} owns the check cache, the enqueue contract and boot reconciliation;
 * {@link UpdateCheckSweeper} runs the opt-in weekly GitHub check on the sweep mold. NotificationsModule
 * is imported for the `update.available` weekly email (via NotificationsService.emit → ADR-0079 SMTP).
 * PrismaService/PermissionResolverService come from the global PrismaModule/AuthModule.
 */
@Module({
  imports: [NotificationsModule],
  controllers: [InstanceController, UpdateController],
  providers: [UpdateService, UpdateCheckSweeper],
})
export class InstanceModule {}
