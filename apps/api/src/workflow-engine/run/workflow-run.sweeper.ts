import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { WorkflowTriggerService } from './workflow-trigger.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PENDING_RUN_SWEEP_AFTER_MS,
  PENDING_RUN_SWEEP_INTERVAL_MS,
} from './workflow-run.constants';

/**
 * The PENDING-run sweeper — the "Postgres remembers" safety net (ADR-0053 / ADR-0054 §1). If a grant's
 * post-commit {@link WorkflowTriggerService.enqueue} was missed (the broker was down, or the API
 * restarted between the commit and the enqueue), the run sits `PENDING` with no job in flight. This
 * periodic scan re-enqueues PENDING runs older than {@link PENDING_RUN_SWEEP_AFTER_MS}, so the engine is
 * self-healing without any operator action beyond bringing Valkey back.
 *
 * It runs on a plain interval (no `@nestjs/schedule` dependency). The interval is `unref`'d so it never
 * holds the process open, and it is NOT started under `NODE_ENV=test` so the Jest suite (which mocks
 * Prisma and never connects to a broker) is unaffected.
 */
@Injectable()
export class WorkflowRunSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowRunSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly trigger: WorkflowTriggerService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, PENDING_RUN_SWEEP_INTERVAL_MS);
    // Never keep the event loop alive just for the sweep.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep pass: re-enqueue PENDING runs whose enqueue looks missed. Re-entrancy guarded (a slow
   * pass never overlaps the next tick). Each enqueue is best-effort — a still-down broker just leaves
   * the run PENDING for the next pass. Public so a test / operator endpoint can trigger it directly.
   */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - PENDING_RUN_SWEEP_AFTER_MS);
      const stale = await this.prisma.workflowRun.findMany({
        where: { status: 'PENDING', createdAt: { lt: cutoff } },
        select: { id: true },
        take: 100,
      });
      let enqueued = 0;
      for (const run of stale) {
        const ok = await this.trigger.enqueue(run.id);
        if (ok) {
          enqueued += 1;
        }
      }
      if (enqueued > 0) {
        this.logger.log(
          `Swept ${enqueued} stale PENDING workflow run(s) back onto the queue.`,
        );
      }
      return enqueued;
    } catch (err) {
      this.logger.error(
        `PENDING-run sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
