import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { WorkflowTrigger } from '@lazyit/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { isQueueUnavailableError } from '../../queue/redis-connection';
import type { ActorAttribution } from '../../common/actor.service';
import {
  WORKFLOW_RUN_QUEUE,
  WORKFLOW_RUN_RESUME_JOB,
  WORKFLOW_RUN_RETRY_JOB,
  WORKFLOW_RUN_START_JOB,
  workflowJobId,
} from './workflow-run.constants';
import type { WorkflowRunJobData } from './workflow-run.types';

/**
 * The matching enabled workflow for a grant event + the version to pin — the result of {@link
 * WorkflowTriggerService.planForTrigger}. `null` means "no workflow fires" (behave EXACTLY as today —
 * no run row written).
 */
export interface TriggerPlan {
  workflowId: string;
  workflowVersionId: number;
  applicationId: string;
  trigger: WorkflowTrigger;
  /** The engine SA the run executes AS (pinned onto the run; may be null if never configured). */
  executedAsServiceAccountId: string | null;
  /** Multi-grant deprovision policy (only meaningful for ACCESS_REVOKED). */
  deprovisionPolicy: 'LAST_ACTIVE_GRANT' | 'EACH_GRANT';
}

/**
 * The AccessGrant → workflow TRANSACTIONAL OUTBOX (ADR-0053 "Postgres remembers" / ADR-0054 §1, the
 * INV-5 inverse). The grant service calls:
 *
 *  1. {@link planForTrigger} (a READ, BEFORE the write tx, best-effort) — does an enabled workflow with
 *     a version exist for this (app, trigger)? If not, nothing else happens (today's behaviour).
 *  2. {@link buildRunData} INSIDE the grant tx — a PENDING `WorkflowRun` committed ATOMICALLY with the
 *     grant, keyed by the unique `idempotencyKey` (`<trigger>:<accessGrantId>`). The only in-tx engine
 *     write, and one that cannot realistically fail (the key is unique per fresh grant event).
 *  3. {@link enqueue} AFTER commit — best-effort. A broker-down enqueue is swallowed (the run stays
 *     PENDING and the sweeper recovers it); it NEVER rolls back or blocks the grant.
 *
 * ABSOLUTE INVARIANT: no failure on this path ever touches the AccessGrant tx. The lookup + enqueue are
 * caller-wrapped in try/catch; the in-tx row write is a determined-safe insert.
 */
@Injectable()
export class WorkflowTriggerService {
  private readonly logger = new Logger(WorkflowTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WORKFLOW_RUN_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Find the enabled, non-deleted workflow for (applicationId, trigger) and its LATEST version. Returns
   * `null` when none exists or it has no authored version (an empty definition has nothing to run).
   * A pure read — the caller wraps it so a lookup failure can never affect the grant.
   */
  async planForTrigger(
    trigger: WorkflowTrigger,
    applicationId: string,
  ): Promise<TriggerPlan | null> {
    const workflow = await this.prisma.applicationWorkflow.findFirst({
      where: { applicationId, trigger, enabled: true, deletedAt: null },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (!workflow) {
      return null;
    }
    const latest = workflow.versions[0];
    if (!latest) {
      return null;
    }
    return {
      workflowId: workflow.id,
      workflowVersionId: latest.id,
      applicationId,
      trigger,
      executedAsServiceAccountId: workflow.executedAsServiceAccountId,
      deprovisionPolicy: workflow.deprovisionPolicy,
    };
  }

  /**
   * Build the PENDING `WorkflowRun` create input — call INSIDE the grant tx with the freshly-created /
   * revoked grant's id. The actor (the human XOR SA who granted/revoked) is inherited as the run's
   * trigger cause (ADR-0048); the engine SA is pinned as the principal it executes AS.
   */
  buildRunData(
    plan: TriggerPlan,
    accessGrantId: string,
    actor: ActorAttribution,
  ): Prisma.WorkflowRunUncheckedCreateInput {
    return {
      workflowId: plan.workflowId,
      workflowVersionId: plan.workflowVersionId,
      applicationId: plan.applicationId,
      trigger: plan.trigger,
      accessGrantId,
      idempotencyKey: `${plan.trigger}:${accessGrantId}`,
      status: 'PENDING',
      ...(actor.userId != null ? { triggeredById: actor.userId } : {}),
      ...(actor.serviceAccountId != null
        ? { triggeredBySaId: actor.serviceAccountId }
        : {}),
      ...(plan.executedAsServiceAccountId != null
        ? { executedAsServiceAccountId: plan.executedAsServiceAccountId }
        : {}),
    };
  }

  /**
   * Enqueue a start job for a committed PENDING run — AFTER the grant tx. Best-effort: a broker-down
   * enqueue (issue #257 `enableOfflineQueue:false` rejects immediately) is swallowed so the grant is
   * never blocked; the run stays PENDING and the sweeper / operator-restart recovers it ("Postgres
   * remembers"). Returns whether the enqueue succeeded (for the caller's telemetry; never throws).
   */
  async enqueue(runId: string): Promise<boolean> {
    try {
      await this.queue.add(
        WORKFLOW_RUN_START_JOB,
        { runId },
        {
          // `start-<runId>` — one per run (BullMQ-safe: no `:`, which it forbids in a custom id).
          jobId: workflowJobId('start', runId),
          attempts: 1,
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 24 * 3600, count: 1000 },
        },
      );
      return true;
    } catch (err) {
      if (isQueueUnavailableError(err)) {
        this.logger.warn(
          `workflow-run enqueue degraded (broker unavailable) for run ${runId}; left PENDING for the sweeper.`,
        );
      } else {
        this.logger.error(
          `workflow-run enqueue failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}; left PENDING for the sweeper.`,
        );
      }
      return false;
    }
  }

  /**
   * Enqueue a RESUME job after a manual task resolved (best-effort, same degrade posture as {@link
   * enqueue}). `cursor` is the resolved next target (a step key or a terminal token). The orchestrator's
   * `resume` flips AWAITING_INPUT→RUNNING guarded, so a duplicate resume job is a no-op (idempotent).
   *
   * `opts.jobId` overrides the default `resume-<runId>-<cursor>` dedupe key. The sweeper's AWAITING_INPUT
   * reconciler (CCOR-2) passes a NON-colliding, rotating jobId so a re-enqueue is never swallowed by a
   * STALE same-cursor resume job that the live path already produced and that still lingers in the queue
   * (`removeOnComplete.age` keeps a completed — possibly no-op — resume around for up to an hour).
   */
  async enqueueResume(
    runId: string,
    cursor: string,
    opts?: { jobId?: string },
  ): Promise<boolean> {
    try {
      await this.queue.add(
        WORKFLOW_RUN_RESUME_JOB,
        { runId, resumeCursor: cursor },
        {
          // `resume-<runId>-<cursor>` — one per run+cursor (BullMQ-safe: no `:`).
          jobId: opts?.jobId ?? workflowJobId('resume', runId, cursor),
          attempts: 1,
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 24 * 3600, count: 1000 },
        },
      );
      return true;
    } catch (err) {
      this.logger.error(
        `workflow-run resume enqueue failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Enqueue a DELAYED retry job (CCOR-3) so a step's per-attempt backoff runs OFF the worker — the slot
   * is freed for the backoff window (up to 1h) and the delay is durable in Valkey across restarts. The
   * deterministic `retry-<runId>-<stepKey>-<attempt>` jobId dedupes a double-scheduled attempt; the
   * orchestrator's `retryStep` re-entry is itself idempotent (it no-ops if the attempt was already run).
   * Best-effort: a broker-down enqueue returns `false`, and the orchestrator falls back to a SHORT,
   * lock-bounded in-process backoff so the run still makes progress while Valkey is unreachable.
   */
  async enqueueRetry(
    runId: string,
    stepKey: string,
    attempt: number,
    delayMs: number,
  ): Promise<boolean> {
    try {
      await this.queue.add(
        WORKFLOW_RUN_RETRY_JOB,
        { runId, retryStepKey: stepKey, retryAttempt: attempt },
        {
          // `retry-<runId>-<stepKey>-<attempt>` — one per run+step+attempt (BullMQ-safe: no `:`).
          jobId: workflowJobId('retry', runId, stepKey, attempt),
          delay: delayMs,
          attempts: 1,
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 24 * 3600, count: 1000 },
        },
      );
      return true;
    } catch (err) {
      if (isQueueUnavailableError(err)) {
        this.logger.warn(
          `workflow-run retry enqueue degraded (broker unavailable) for run ${runId} step ${stepKey} attempt ${attempt}; falling back to an in-process backoff.`,
        );
      } else {
        this.logger.error(
          `workflow-run retry enqueue failed for run ${runId} step ${stepKey} attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return false;
    }
  }

  /**
   * The set of run ids that currently have a job NOT-yet-finished on the queue (active / waiting /
   * delayed / paused). Used by the sweeper's RUNNING-staleness reconciler (CCOR-4) to AVOID failing a
   * run that is legitimately in-flight or backing off (its delayed retry job counts as in-flight).
   * Returns `null` when the broker state cannot be read (e.g. Valkey down) so the reconciler can SKIP —
   * never finalize a possibly-live run as failed on incomplete information.
   */
  async inFlightRunIds(): Promise<Set<string> | null> {
    try {
      const jobs = await this.queue.getJobs([
        'active',
        'waiting',
        'delayed',
        'paused',
      ]);
      const ids = new Set<string>();
      for (const job of jobs) {
        const runId = (job?.data as WorkflowRunJobData | undefined)?.runId;
        if (runId) {
          ids.add(runId);
        }
      }
      return ids;
    } catch (err) {
      this.logger.warn(
        `workflow-run in-flight scan failed (broker unavailable?); skipping RUNNING-staleness reconcile this pass: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
