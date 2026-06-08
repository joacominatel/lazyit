import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { WorkflowStepsSchema } from '@lazyit/shared';
import { WorkflowTriggerService } from './workflow-trigger.service';
import { PrismaService } from '../../prisma/prisma.service';
import { deriveResumeCursor } from './transitions';
import {
  AWAITING_INPUT_SWEEP_AFTER_MS,
  PENDING_RUN_SWEEP_AFTER_MS,
  PENDING_RUN_SWEEP_INTERVAL_MS,
  RUNNING_STALE_AFTER_MS,
} from './workflow-run.constants';

/** What one full sweep pass recovered, per reconciler (returned for telemetry / tests). */
export interface SweepResult {
  /** PENDING runs whose missed enqueue was re-fired. */
  pending: number;
  /** AWAITING_INPUT runs with a resolved task whose lost resume was re-enqueued. */
  resumed: number;
  /** Stranded RUNNING runs (no in-flight job) finalized FAILED (engine-restart). */
  failedStale: number;
}

/**
 * The run-lifecycle RECONCILER — the "Postgres remembers" safety net (ADR-0053 / ADR-0054 §1). A
 * periodic scan that heals runs the happy-path handoff lost, WITHOUT any operator action beyond bringing
 * Valkey back. Three reconcilers, each independent and best-effort:
 *
 *  1. PENDING (the original net): if a grant's post-commit {@link WorkflowTriggerService.enqueue} was
 *     missed (broker down, or the API restarted between the commit and the enqueue), re-enqueue PENDING
 *     runs older than {@link PENDING_RUN_SWEEP_AFTER_MS}.
 *
 *  2. AWAITING_INPUT (CCOR-2): a manual resume is a fire-and-forget handoff (complete() → enqueueResume).
 *     If it is LOST — broker down at completion, a crash between complete() and the enqueue, the
 *     pause-ordering TOCTOU, or a transient DB error in resume()'s status flip — the run sits
 *     AWAITING_INPUT forever even though its latest ManualTask is resolved. This reconciler re-derives
 *     the resume cursor from that resolved task and re-enqueues it (with a NON-colliding jobId so a stale
 *     completed resume job can't dedupe the recovery away).
 *
 *  3. RUNNING staleness (CCOR-4): a hard crash mid-walk leaves a run RUNNING with no worker to finish it
 *     (the stalled re-delivery no-ops on the PENDING guard; `failRunSafely` only fires on a caught
 *     exception). This reconciler finalizes a long-stale RUNNING run with NO in-flight job as FAILED
 *     (operator-visible `engine-restart`); a genuinely backing-off run is protected by its delayed retry
 *     job counting as in-flight.
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
   * One sweep pass: run all three reconcilers. Re-entrancy guarded (a slow pass never overlaps the next
   * tick). Each reconciler is independently try/caught so one failing never aborts the others. Public so
   * a test / operator endpoint can trigger it directly.
   */
  async sweep(): Promise<SweepResult> {
    if (this.running) {
      return { pending: 0, resumed: 0, failedStale: 0 };
    }
    this.running = true;
    try {
      const pending = await this.sweepPending();
      const resumed = await this.reconcileAwaitingInput();
      const failedStale = await this.reconcileRunningStale();
      return { pending, resumed, failedStale };
    } finally {
      this.running = false;
    }
  }

  /** Reconciler 1 — re-enqueue PENDING runs whose enqueue looks missed. */
  async sweepPending(): Promise<number> {
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
    }
  }

  /**
   * Reconciler 2 (CCOR-2) — re-enqueue a LOST manual resume. Selects runs still AWAITING_INPUT whose
   * LATEST ManualTask is resolved (COMPLETED / CANCELLED) and was resolved long enough ago that a healthy
   * in-flight resume would already have flipped the run; re-derives the same resume cursor the live path
   * would and re-enqueues it under a rotating, non-colliding jobId. The orchestrator's `resume` is
   * guarded, so even if the original resume is somehow still in flight only one wins (idempotent).
   */
  async reconcileAwaitingInput(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - AWAITING_INPUT_SWEEP_AFTER_MS);
      // Pre-filter on the run's own updatedAt (the pause time, always ≤ the task's resolution time) to
      // bound the scan; the authoritative staleness check is on the resolved task below.
      const stale = await this.prisma.workflowRun.findMany({
        where: { status: 'AWAITING_INPUT', updatedAt: { lt: cutoff } },
        select: {
          id: true,
          workflowVersion: { select: { steps: true } },
          manualTasks: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, stepKey: true, status: true, updatedAt: true },
          },
        },
        take: 100,
      });
      let resumed = 0;
      for (const run of stale) {
        const task = run.manualTasks[0];
        if (!task) {
          continue; // AWAITING_INPUT but no task — nothing to derive a cursor from; leave for an operator.
        }
        if (task.status !== 'COMPLETED' && task.status !== 'CANCELLED') {
          continue; // latest task still PENDING — the run is genuinely awaiting a human.
        }
        if (task.updatedAt >= cutoff) {
          continue; // resolved very recently — give the live resume a chance before recovering.
        }
        let cursor: string;
        try {
          const steps = WorkflowStepsSchema.parse(run.workflowVersion.steps);
          const index = steps.findIndex((s) => s.key === task.stepKey);
          if (index < 0) {
            continue; // task references an unknown step — can't derive; leave for an operator.
          }
          cursor = deriveResumeCursor(steps, index, task.status);
        } catch {
          continue;
        }
        const ok = await this.trigger.enqueueResume(run.id, cursor, {
          // Rotating, non-colliding jobId: it cannot be deduped away by a stale `resume:<run>:<cursor>`
          // job the live path already produced (and that lingers per `removeOnComplete.age`).
          jobId: `resume:${run.id}:${cursor}:reconcile:${task.id}`,
        });
        if (ok) {
          resumed += 1;
        }
      }
      if (resumed > 0) {
        this.logger.log(
          `Reconciled ${resumed} AWAITING_INPUT run(s) with a resolved task back onto the resume queue.`,
        );
      }
      return resumed;
    } catch (err) {
      this.logger.error(
        `AWAITING_INPUT reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }

  /**
   * Reconciler 3 (CCOR-4) — finalize a STRANDED RUNNING run. Selects runs RUNNING with `updatedAt` older
   * than {@link RUNNING_STALE_AFTER_MS}, cross-checks the broker for an in-flight job (active / waiting /
   * delayed / paused), and finalizes those with NONE as FAILED (`engine-restart`). When the broker state
   * can't be read it SKIPS the whole pass — never failing a possibly-live or backing-off run on
   * incomplete information. The finalize is guarded (status RUNNING + still stale) so a run that got
   * picked up between the scan and the write is never clobbered.
   */
  async reconcileRunningStale(): Promise<number> {
    try {
      const cutoff = new Date(Date.now() - RUNNING_STALE_AFTER_MS);
      const stale = await this.prisma.workflowRun.findMany({
        where: { status: 'RUNNING', updatedAt: { lt: cutoff } },
        select: { id: true },
        take: 100,
      });
      if (stale.length === 0) {
        return 0;
      }
      const inFlight = await this.trigger.inFlightRunIds();
      if (inFlight === null) {
        // Broker state unknown (Valkey down) — do NOT finalize: a backing-off run's delayed job may be
        // intact and unreachable. Try again next pass.
        return 0;
      }
      let failed = 0;
      for (const run of stale) {
        if (inFlight.has(run.id)) {
          continue; // an active / delayed (backing-off) job owns it — not stranded.
        }
        const res = await this.prisma.workflowRun.updateMany({
          where: { id: run.id, status: 'RUNNING', updatedAt: { lt: cutoff } },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            error: {
              errorClass: 'engine-restart',
              reason:
                'run was RUNNING with no in-flight job past the stall threshold',
            },
          },
        });
        if (res.count > 0) {
          failed += 1;
          this.logger.warn(
            `workflow.run_failed run=${run.id} class=engine-restart (stale RUNNING, no in-flight job)`,
          );
        }
      }
      if (failed > 0) {
        this.logger.warn(
          `Finalized ${failed} stranded RUNNING workflow run(s) as FAILED (engine-restart).`,
        );
      }
      return failed;
    } catch (err) {
      this.logger.error(
        `RUNNING-staleness reconcile failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    }
  }
}
