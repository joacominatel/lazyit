import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  AttachmentsGcService,
  type GcSweepResult,
} from './attachments-gc.service';
import { ATTACHMENTS_GC_QUEUE } from './attachments.constants';

/**
 * The IN-PROCESS BullMQ worker for the daily attachments GC (ADR-0082 §6 pin 4). In-process (not a
 * sandboxed child, the WorkflowRunWorker rationale): the sweep is trusted lazyit code needing Nest
 * DI (the soft-delete-aware PrismaService) and does light DB reads + unlinks — no untrusted parsing,
 * no memory hazard. The repeatable schedule is upserted by {@link AttachmentsGcService.onModuleInit}.
 * A failing sweep logs and waits for the next daily tick — it never crashes anything.
 */
@Processor(ATTACHMENTS_GC_QUEUE, { concurrency: 1 })
export class AttachmentsGcWorker extends WorkerHost {
  private readonly logger = new Logger(AttachmentsGcWorker.name);

  constructor(private readonly gc: AttachmentsGcService) {
    super();
  }

  // The job payload is empty (the schedule IS the trigger), so the Job param is omitted.
  async process(): Promise<GcSweepResult> {
    try {
      return await this.gc.sweep();
    } catch (err) {
      this.logger.error(
        `Attachments GC sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}
