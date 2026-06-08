import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { WorkflowRunOrchestrator } from './workflow-run.orchestrator';
import {
  WORKFLOW_RUN_QUEUE,
  WORKFLOW_RUN_RESUME_JOB,
  WORKFLOW_RUN_RETRY_JOB,
  WORKFLOW_RUN_START_JOB,
} from './workflow-run.constants';
import type { WorkflowRunJobData } from './workflow-run.types';

/**
 * The IN-PROCESS BullMQ worker for the `workflow-run` queue (ADR-0053). In-process (not a sandboxed
 * child like the article import) because the orchestrator needs Nest DI — Prisma, the ConnectorRegistry,
 * the SecretService — and the work is trusted lazyit code whose only outbound calls go THROUGH the
 * egress guard. Concurrency is bounded so a burst of grant events can't exhaust the pool.
 *
 * It dispatches a job to the orchestrator's `start` / `resume`. An UNEXPECTED engine error (not an
 * expected step failure — those the orchestrator records as FAILED runs) is caught and finalizes the run
 * as FAILED with a redacted summary, so a crashed walk never leaves a run stuck RUNNING.
 */
@Processor(WORKFLOW_RUN_QUEUE, { concurrency: 5 })
export class WorkflowRunWorker extends WorkerHost {
  private readonly logger = new Logger(WorkflowRunWorker.name);

  constructor(
    private readonly orchestrator: WorkflowRunOrchestrator,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<WorkflowRunJobData>): Promise<void> {
    const { runId, resumeCursor, retryStepKey, retryAttempt } = job.data;
    try {
      switch (job.name) {
        case WORKFLOW_RUN_START_JOB:
          await this.orchestrator.start(runId);
          return;
        case WORKFLOW_RUN_RESUME_JOB:
          if (!resumeCursor) {
            throw new Error(`resume job for run ${runId} has no resumeCursor`);
          }
          await this.orchestrator.resume(runId, resumeCursor);
          return;
        case WORKFLOW_RUN_RETRY_JOB:
          if (!retryStepKey || retryAttempt == null) {
            throw new Error(
              `retry job for run ${runId} is missing its retry cursor`,
            );
          }
          await this.orchestrator.retryStep(runId, retryStepKey, retryAttempt);
          return;
        default:
          this.logger.warn(
            `Unknown workflow-run job "${job.name}" for run ${runId}`,
          );
          return;
      }
    } catch (err) {
      // Unexpected engine fault — never leave the run hanging RUNNING. Mark it FAILED (redacted).
      this.logger.error(
        `workflow-run job ${job.name} for run ${runId} threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.failRunSafely(runId);
      // Do NOT rethrow: a blind BullMQ retry could double-execute steps (the run is the idempotency
      // unit). The run is already finalized FAILED; the operator inspects the ledger.
    }
  }

  private async failRunSafely(runId: string): Promise<void> {
    try {
      await this.prisma.workflowRun.updateMany({
        where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          error: { errorClass: 'engine-error' },
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to finalize run ${runId} after an engine error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
