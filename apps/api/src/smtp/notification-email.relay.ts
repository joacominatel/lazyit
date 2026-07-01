import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  EMAIL_JOB_NAME,
  EMAIL_QUEUE,
  isEmailableNotificationType,
  type NotificationEmailJob,
} from './email.constants';

/**
 * NotificationEmailRelay — the PRODUCER seam between the notification bell and the email channel (issue
 * #615, ADR-0079). {@link NotificationsService.emit} calls {@link enqueue} right after it writes a NEW
 * (non-deduped) notification; this checks the curated allowlist and, if the type is emailable, enqueues
 * one job onto the BullMQ email queue. Everything the worker needs rides the payload (no re-read).
 *
 * FAIL-SOFT (ADR-0079 fork #4): enqueue is wrapped so a broker hiccup NEVER propagates to emit() — a
 * failed enqueue is logged and swallowed, so the in-app notification and the originating domain write are
 * untouched. Email is a best-effort side channel.
 */
@Injectable()
export class NotificationEmailRelay {
  private readonly logger = new Logger(NotificationEmailRelay.name);

  constructor(
    @InjectQueue(EMAIL_QUEUE)
    private readonly queue: Queue<NotificationEmailJob>,
  ) {}

  /**
   * Enqueue an email for a newly-created notification IF its type is on the curated allowlist. Best-effort:
   * never throws. Retries are bounded (3 attempts, exponential backoff) so a transient relay/broker blip
   * self-heals without piling up.
   */
  async enqueue(job: NotificationEmailJob): Promise<void> {
    if (!isEmailableNotificationType(job.type)) {
      return; // bell-only type — not routed to email.
    }
    try {
      await this.queue.add(EMAIL_JOB_NAME, job, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      });
    } catch (err) {
      // A broker outage must never break emit() — log and swallow (the bell row already exists).
      this.logger.warn(
        `email enqueue failed (type=${job.type} notification=${job.notificationId ?? '?'}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
