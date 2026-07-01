import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EMAIL_QUEUE } from './email.constants';
import { SmtpController } from './smtp.controller';
import { SmtpService } from './smtp.service';
import { EmailDispatchService } from './email-dispatch.service';
import { EmailWorker } from './email.worker';
import { NotificationEmailRelay } from './notification-email.relay';

/**
 * SmtpModule — instance SMTP settings + the outbound-email channel (issue #615, ADR-0079). Hosts the
 * `/config/smtp` surface (`GET`/`PUT`/`POST test`), the BullMQ email queue + its in-process worker
 * (ADR-0053), and EXPORTS {@link NotificationEmailRelay} so `NotificationsModule` can enqueue an email
 * for an emailable notification behind `NotificationsService.emit()` (one seam, no scattered sends).
 *
 * PrismaService (global PrismaModule) and PermissionResolverService (global AuthModule) inject without an
 * explicit import. The queue is registered here (the single owner); `NotificationsModule` imports this
 * module for the relay, NOT the other way round, so there is no cycle.
 */
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE })],
  controllers: [SmtpController],
  providers: [
    SmtpService,
    EmailDispatchService,
    EmailWorker,
    NotificationEmailRelay,
  ],
  exports: [NotificationEmailRelay, SmtpService],
})
export class SmtpModule {}
