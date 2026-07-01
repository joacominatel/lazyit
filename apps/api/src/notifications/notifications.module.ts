import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsRetentionSweeper } from './notifications-retention.sweeper';
import { VaultSetupNudgeService } from './vault-setup-nudge.service';
import { SmtpModule } from '../smtp/smtp.module';

/**
 * NotificationsModule — the in-app notification bell (ADR-0056). Hosts the four POLL endpoints
 * (`GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read`,
 * `PATCH /notifications/read-all`), the 90-day retention sweeper, the login-time vault-setup nudge
 * ({@link VaultSetupNudgeService}, ADR-0056 amendment #453), and EXPORTS {@link NotificationsService}
 * so the post-commit emitters in `access-grants`, `consumables` and the workflow engine can fire
 * best-effort nudges through it.
 *
 * Read-path authZ (ADR-0056 amendment): the four endpoints are NO LONGER gated by
 * `@RequirePermission('notification:read')` — they are open to any authenticated human, and
 * {@link NotificationsService} SCOPES every read to the caller's visible set (own targeted rows always,
 * broadcast set only with `notification:read`). The service resolves that permission via the global
 * {@link PermissionResolverService}, so the scope is enforced in one place.
 *
 * PrismaService and PermissionResolverService come from the global PrismaModule / AuthModule, so this
 * module needs no extra `imports`. {@link VaultSetupNudgeService} is exported for the `/users/me`
 * post-login seam in UsersModule.
 */
@Module({
  // SmtpModule provides the NotificationEmailRelay (the email channel producer) that
  // NotificationsService.emit() calls behind the bell (ADR-0079). No cycle: SmtpModule never imports this.
  imports: [SmtpModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsRetentionSweeper,
    VaultSetupNudgeService,
  ],
  exports: [NotificationsService, VaultSetupNudgeService],
})
export class NotificationsModule {}
