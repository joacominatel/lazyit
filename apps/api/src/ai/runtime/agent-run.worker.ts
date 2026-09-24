import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import {
  AI_RUN_JOB_RESUME,
  AI_RUN_JOB_START,
  AI_RUN_QUEUE,
} from '../ai.constants';
import { AgentLoop } from './agent-loop';
import type { AiRunJobData } from './run-queue';
import { aiWorkerConcurrency, describeError } from './runtime.constants';

/**
 * The IN-PROCESS `ai-run` worker (ADR-0053; provider-and-runtime.md Fork B). In-process like the
 * workflow-run worker: the loop needs Nest DI (Prisma, the tool core, the provider port) and its only
 * outbound calls go through the egress guard. `AI_WORKER_CONCURRENCY` (default 4) is the global ceiling on
 * concurrent runs.
 *
 * A job carries only `{ runId }`. `start` and `resume` both claim the run QUEUED → RUNNING and drive the
 * loop; a duplicate or stale job (a BullMQ stalled re-delivery after a crash) finds the run in another
 * status and does nothing. Faults never propagate: a rethrow could make BullMQ retry, and a retried step
 * could execute a write twice.
 */
@Processor(AI_RUN_QUEUE, { concurrency: aiWorkerConcurrency() })
export class AgentRunWorker extends WorkerHost {
  private readonly logger = new Logger(AgentRunWorker.name);

  constructor(private readonly loop: AgentLoop) {
    super();
  }

  async process(job: Job<AiRunJobData>): Promise<void> {
    const runId = job.data?.runId;
    if (typeof runId !== 'string' || runId.length === 0) {
      this.logger.warn(`ai-run job ${job.name} without a run id; ignored`);
      return;
    }
    if (job.name !== AI_RUN_JOB_START && job.name !== AI_RUN_JOB_RESUME) {
      this.logger.warn(`Unknown ai-run job "${job.name}" for run ${runId}`);
      return;
    }
    try {
      await this.loop.advance(runId);
    } catch (err) {
      // `advance` finalizes its own faults; this is a last resort (e.g. the database is unreachable).
      // The sweeper finalizes a run left RUNNING. Never rethrown.
      this.logger.error(
        `ai-run job ${job.name} for run ${runId} threw: ${describeError(err)}`,
      );
    }
  }
}
