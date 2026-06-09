import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsRetentionSweeper } from './notifications-retention.sweeper';

/**
 * NotificationsModule — the in-app notification bell (ADR-0056). Hosts the four POLL endpoints
 * (`GET /notifications`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read`,
 * `PATCH /notifications/read-all`, all gated `notification:read`), the 90-day retention sweeper, and
 * EXPORTS {@link NotificationsService} so the post-commit emitters in `access-grants`, `consumables`
 * and the workflow engine can fire best-effort nudges through it.
 *
 * PrismaService comes from the global PrismaModule; the service needs no other module dependency.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsRetentionSweeper],
  exports: [NotificationsService],
})
export class NotificationsModule {}
