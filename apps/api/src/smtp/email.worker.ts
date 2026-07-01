import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { EMAIL_QUEUE, type NotificationEmailJob } from './email.constants';
import { EmailDispatchService } from './email-dispatch.service';

/**
 * The IN-PROCESS BullMQ worker for the `email-dispatch` queue (issue #615, ADR-0079 · ADR-0053). Sending
 * needs full Nest DI (Prisma + the permission resolver + the SMTP config store), so it is an in-process
 * `@Processor`/`WorkerHost` (like the workflow-run / import-commit workers), NOT a sandboxed fork — there
 * is no untrusted-input surface here (the payload is server-built, redacted notification data).
 *
 * FAIL-SOFT (ADR-0079 fork #4): a send failure is logged and RE-THROWN so BullMQ applies its bounded
 * retry (transient relay hiccup), but this is fully decoupled from the notification/domain write — the
 * bell row already exists and the originating request already returned. After the attempts are exhausted
 * BullMQ drops the job; email is best-effort, never a system-of-record.
 *
 * Concurrency 5: sends are I/O-bound and light; a small pool drains a burst without hammering the relay.
 */
@Processor(EMAIL_QUEUE, { concurrency: 5 })
export class EmailWorker extends WorkerHost {
  private readonly logger = new Logger(EmailWorker.name);

  constructor(private readonly dispatch: EmailDispatchService) {
    super();
  }

  async process(job: Job<NotificationEmailJob>): Promise<void> {
    try {
      await this.dispatch.dispatch(job.data);
    } catch (err) {
      this.logger.warn(
        `email job ${job.id} (type=${job.data.type}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err; // let BullMQ retry within its bounded attempts; still decoupled from the domain write.
    }
  }
}
