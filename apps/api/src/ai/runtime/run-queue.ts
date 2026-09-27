import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { isQueueUnavailableError } from '../../queue/redis-connection';
import {
  AI_RUN_JOB_RESUME,
  AI_RUN_JOB_START,
  AI_RUN_QUEUE,
} from '../ai.constants';
import { aiRunJobId, describeError } from './runtime.constants';

/** The payload of every `ai-run` job: the run id and nothing else (ADR-0097 decision 5). */
export interface AiRunJobData {
  runId: string;
}

const JOB_OPTIONS = {
  // Never retried by BullMQ: a blind retry could re-run a step (§6.4). A failed run is finalized instead.
  attempts: 1,
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600, count: 1000 },
};

/**
 * The producer side of the `ai-run` queue (ADR-0053; provider-and-runtime.md §6.1). Postgres is the system
 * of record and the queue is transport: an enqueue that fails (Valkey down — `enableOfflineQueue: false`
 * fails fast) leaves the run QUEUED for the sweeper, and never throws into the caller.
 */
@Injectable()
export class AiRunQueue {
  private readonly logger = new Logger(AiRunQueue.name);

  constructor(
    @InjectQueue(AI_RUN_QUEUE) private readonly queue: Queue<AiRunJobData>,
  ) {}

  /** The start job of a new run (`start-<runId>`, one per run). */
  enqueueStart(runId: string, jobId?: string): Promise<boolean> {
    return this.add(
      AI_RUN_JOB_START,
      runId,
      jobId ?? aiRunJobId('start', runId),
    );
  }

  /**
   * The resume job after a step's approvals are decided. `resume-<runId>-<stepCount>` dedupes a double
   * decision; the sweeper passes a rotating id so a lingering completed job cannot swallow a recovery.
   */
  enqueueResume(
    runId: string,
    stepCount: number,
    jobId?: string,
  ): Promise<boolean> {
    return this.add(
      AI_RUN_JOB_RESUME,
      runId,
      jobId ?? aiRunJobId('resume', runId, stepCount),
    );
  }

  /**
   * The run ids with a job not yet finished (active, waiting, delayed), or `null` when the broker
   * cannot be read — the sweeper then finalizes nothing on incomplete information. BullMQ 6 reports
   * the jobs of a paused queue as `waiting`; there is no separate `paused` state to scan.
   */
  async inFlightRunIds(): Promise<Set<string> | null> {
    try {
      const jobs = await this.queue.getJobs(['active', 'waiting', 'delayed']);
      const ids = new Set<string>();
      for (const job of jobs) {
        const runId = (job?.data as AiRunJobData | undefined)?.runId;
        if (typeof runId === 'string') ids.add(runId);
      }
      return ids;
    } catch (err) {
      this.logger.warn(
        `ai-run in-flight scan failed; skipping this pass: ${describeError(err)}`,
      );
      return null;
    }
  }

  private async add(
    name: string,
    runId: string,
    jobId: string,
  ): Promise<boolean> {
    try {
      await this.queue.add(name, { runId }, { ...JOB_OPTIONS, jobId });
      return true;
    } catch (err) {
      if (isQueueUnavailableError(err)) {
        this.logger.warn(
          `ai-run ${name} enqueue degraded (broker unavailable) for run ${runId}; the sweeper recovers it.`,
        );
      } else {
        this.logger.error(
          `ai-run ${name} enqueue failed for run ${runId}: ${describeError(err)}; the sweeper recovers it.`,
        );
      }
      return false;
    }
  }
}
