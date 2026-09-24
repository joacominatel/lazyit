import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AI_RUN_WAITING_STATUSES,
  type AiConversationChannel,
} from '@lazyit/shared';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PrismaService } from '../../prisma/prisma.service';
import { AiToolService } from '../core/ai-tool.service';
import { errorResult } from '../core/result-shaper';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from '../core/ports/ai-settings.port';
import { AgentLoop } from './agent-loop';
import { AiInputRequests } from './input-requests';
import { INPUT_EXPIRED } from './input.service';
import { AiRunPrincipals } from './principal-context';
import { AiRunLifecycle } from './run-lifecycle';
import { AiRunQueue } from './run-queue';
import { AI_MESSAGE_FORMAT_RUN, readRunRecord } from './run-records';
import {
  AI_AWAITING_SWEEP_AFTER_MS,
  AI_EXECUTING_STALE_AFTER_MS,
  AI_QUEUED_SWEEP_AFTER_MS,
  AI_RUNNING_STALE_AFTER_MS,
  AI_RUN_SWEEP_INTERVAL_MS,
  AI_SWEEP_BATCH,
  aiRunJobId,
  describeError,
} from './runtime.constants';

/** What one sweep pass did, per reconciler (for tests and logs). */
export interface AiRunSweepResult {
  /** Approvals and input requests past their TTL expired (and their runs finalized EXPIRED). */
  expired: number;
  /** Invocations interrupted while EXECUTING, marked OUTCOME_UNKNOWN (never retried). */
  outcomeUnknown: number;
  /** Waiting runs whose decided step was re-enqueued (lost resumes). */
  resumed: number;
  /** Waiting runs cancelled because AI was turned off or the principal lost `ai:use`. */
  cancelled: number;
  /** QUEUED runs whose lost job was re-enqueued. */
  requeued: number;
  /** RUNNING runs with no job, finalized FAILED (`ENGINE_RESTART`). */
  failedStale: number;
}

const EMPTY: AiRunSweepResult = {
  expired: 0,
  outcomeUnknown: 0,
  resumed: 0,
  cancelled: 0,
  requeued: 0,
  failedStale: 0,
};

/**
 * THE RUN RECONCILER — "Postgres remembers" (ADR-0053; provider-and-runtime.md §8 invariant 7; the
 * workflow-run sweeper precedent). A periodic pass that heals what the happy path lost, each reconciler
 * independent and best-effort:
 *
 *  1. Expiry: `expireDue` marks pending approvals past their TTL EXPIRED, and input requests (#1388)
 *     past theirs are expired the same way; each affected run ends EXPIRED with every call answered.
 *  2. Interrupted executions: an approved write still EXECUTING long after its claim (the process died
 *     mid-`approve`) becomes OUTCOME_UNKNOWN — never retried.
 *  3. AWAITING_APPROVAL | AWAITING_INPUT: a run is cancelled when AI was turned off or its principal lost
 *     `ai:use`; a run whose calls are all decided but that was never resumed is re-enqueued (a rotating
 *     job id).
 *  4. QUEUED with no job on the queue: re-enqueued.
 *  5. RUNNING with no job on the queue past the stall threshold: its EXECUTING writes become
 *     OUTCOME_UNKNOWN and the run ends FAILED `ENGINE_RESTART`. It is NEVER resumed — a restarted step
 *     could execute a write twice.
 *
 * When the broker cannot be read, 4 and 5 skip the pass. A plain `unref`'d interval, not started under
 * `NODE_ENV=test`.
 */
@Injectable()
export class AgentRunSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRunSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: AiToolService,
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
    private readonly principals: AiRunPrincipals,
    private readonly lifecycle: AiRunLifecycle,
    private readonly queue: AiRunQueue,
    private readonly loop: AgentLoop,
    private readonly inputs: AiInputRequests,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, AI_RUN_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass of every reconciler. Re-entrancy guarded. */
  async sweep(now: Date = new Date()): Promise<AiRunSweepResult> {
    if (this.running) return { ...EMPTY };
    this.running = true;
    try {
      const expiredApprovals = await this.guarded('expiry', () =>
        this.expireApprovals(now),
      );
      const expiredInputs = await this.guarded('input-expiry', () =>
        this.expireInputs(now),
      );
      const expired = expiredApprovals + expiredInputs;
      const outcomeUnknown = await this.guarded('executing', () =>
        this.interruptedExecutions(now),
      );
      const awaiting = await this.guarded('awaiting', () =>
        this.reconcileAwaiting(now),
      );
      const inFlight = await this.queue.inFlightRunIds();
      const requeued = inFlight
        ? await this.guarded('queued', () => this.requeueLost(now, inFlight))
        : 0;
      const failedStale = inFlight
        ? await this.guarded('running', () => this.failStale(now, inFlight))
        : 0;
      const result: AiRunSweepResult = {
        expired,
        outcomeUnknown,
        resumed: typeof awaiting === 'number' ? 0 : awaiting.resumed,
        cancelled: typeof awaiting === 'number' ? 0 : awaiting.cancelled,
        requeued,
        failedStale,
      };
      if (Object.values(result).some((count) => count > 0)) {
        this.logger.log({ event: 'ai.run.sweep', ...result });
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** 1 — pending approvals past their TTL; their runs end EXPIRED. */
  async expireApprovals(now: Date): Promise<number> {
    const expired = await this.tools.expireDue(AI_SWEEP_BATCH, now);
    const runs = new Set<string>();
    for (const action of expired) {
      if (action.runId && action.toolUseId) {
        this.lifecycle.emitResolved(action.runId, action.toolUseId, 'expired');
      }
      if (action.runId) runs.add(action.runId);
    }
    for (const runId of runs) {
      await this.lifecycle.finalize(runId, 'EXPIRED', {
        from: ['AWAITING_APPROVAL'],
        finishReason: 'approval_expired',
        fallback: {
          code: 'EXPIRED',
          message: 'The approval window for this action has passed',
        },
      });
    }
    return expired.length;
  }

  /** 1b — input requests past their TTL (#1388); their runs end EXPIRED like an expired approval. */
  async expireInputs(now: Date): Promise<number> {
    const due = await this.inputs.due(AI_SWEEP_BATCH, now);
    const runs = new Set<string>();
    let expired = 0;
    for (const row of due) {
      const closed = await this.inputs.close(
        row.id,
        'EXPIRED',
        errorResult('navigate', INPUT_EXPIRED),
      );
      if (!closed) continue;
      expired += 1;
      if (row.runId && row.toolUseId) {
        this.lifecycle.emitInputResolved(row.runId, row.toolUseId, 'expired');
      }
      if (row.runId) runs.add(row.runId);
    }
    for (const runId of runs) {
      await this.lifecycle.finalize(runId, 'EXPIRED', {
        from: ['AWAITING_INPUT'],
        finishReason: 'input_expired',
        fallback: INPUT_EXPIRED,
      });
    }
    return expired;
  }

  /** 2 — approved writes interrupted mid-execution (their run is still waiting on them). */
  async interruptedExecutions(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - AI_EXECUTING_STALE_AFTER_MS);
    const stuck = await this.prisma.aiToolInvocation.findMany({
      where: {
        status: 'EXECUTING',
        runId: { not: null },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, runId: true },
      take: AI_SWEEP_BATCH,
    });
    let marked = 0;
    for (const row of stuck) {
      const run = await this.prisma.aiRun.findUnique({
        where: { id: row.runId! },
        select: { status: true },
      });
      // A RUNNING run's executions are reconciler 5's (only once its job is gone).
      if (run?.status === 'RUNNING' || this.loop.isRunning(row.runId!))
        continue;
      if (await this.tools.markOutcomeUnknown(row.id)) marked += 1;
    }
    return marked;
  }

  /** 3 — waiting runs: cancel when AI is off or the principal lost `ai:use`; resume lost ones. */
  async reconcileAwaiting(
    now: Date,
  ): Promise<{ resumed: number; cancelled: number }> {
    const cutoff = new Date(now.getTime() - AI_AWAITING_SWEEP_AFTER_MS);
    const runs = await this.prisma.aiRun.findMany({
      where: {
        status: { in: [...AI_RUN_WAITING_STATUSES] },
        updatedAt: { lt: cutoff },
      },
      take: AI_SWEEP_BATCH,
    });
    if (runs.length === 0) return { resumed: 0, cancelled: 0 };
    const enabled = (await this.settings.resolveProviderConfig()) !== null;
    let resumed = 0;
    let cancelled = 0;
    for (const run of runs) {
      const refusal = enabled
        ? await this.principalRefusal(run)
        : { code: 'AI_DISABLED', message: 'The AI assistant is turned off.' };
      if (refusal) {
        const done = await this.lifecycle.finalize(run.id, 'CANCELLED', {
          from: [...AI_RUN_WAITING_STATUSES],
          finishReason: 'cancelled',
          error: refusal,
          fallback: {
            code: 'NOT_AVAILABLE',
            message: 'The run was cancelled; nothing was executed',
          },
        });
        if (done) cancelled += 1;
        continue;
      }
      const status = await this.lifecycle.resumeIfDecided(
        run.id,
        aiRunJobId('resume', run.id, 'sweep', now.getTime()),
      );
      if (status === 'QUEUED') resumed += 1;
    }
    return { resumed, cancelled };
  }

  /** 4 — QUEUED runs whose job never reached the queue. */
  async requeueLost(now: Date, inFlight: Set<string>): Promise<number> {
    const cutoff = new Date(now.getTime() - AI_QUEUED_SWEEP_AFTER_MS);
    const runs = await this.prisma.aiRun.findMany({
      where: { status: 'QUEUED', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: AI_SWEEP_BATCH,
    });
    let requeued = 0;
    for (const run of runs) {
      if (inFlight.has(run.id)) continue;
      const ok = await this.queue.enqueueStart(
        run.id,
        aiRunJobId('start', run.id, 'sweep', now.getTime()),
      );
      if (ok) requeued += 1;
    }
    return requeued;
  }

  /** 5 — RUNNING runs with no job: interrupted writes OUTCOME_UNKNOWN, the run FAILED `ENGINE_RESTART`. */
  async failStale(now: Date, inFlight: Set<string>): Promise<number> {
    const cutoff = new Date(now.getTime() - AI_RUNNING_STALE_AFTER_MS);
    const runs = await this.prisma.aiRun.findMany({
      where: { status: 'RUNNING', updatedAt: { lt: cutoff } },
      select: { id: true },
      take: AI_SWEEP_BATCH,
    });
    let failed = 0;
    for (const run of runs) {
      // A job still owns it, or this very process is driving it (a long model step): not stranded.
      if (inFlight.has(run.id) || this.loop.isRunning(run.id)) continue;
      const executing = await this.prisma.aiToolInvocation.findMany({
        where: { runId: run.id, status: 'EXECUTING' },
        select: { id: true },
      });
      for (const row of executing) {
        await this.tools.markOutcomeUnknown(row.id);
      }
      const done = await this.lifecycle.finalize(run.id, 'FAILED', {
        from: ['RUNNING'],
        finishReason: 'engine_restart',
        error: {
          code: 'ENGINE_RESTART',
          message:
            'The run was interrupted by a restart; interrupted actions were not retried.',
        },
        fallback: {
          code: 'UNKNOWN_OUTCOME',
          message: 'The run was interrupted; this call was not completed',
        },
      });
      if (done) {
        failed += 1;
        this.logger.warn(
          `ai.run.failed run=${run.id} class=engine_restart (stale RUNNING, no in-flight job)`,
        );
      }
    }
    return failed;
  }

  /** Why the run's principal may no longer continue, or null. */
  private async principalRefusal(run: {
    id: string;
    channel: string;
    conversationId: string | null;
    userId: string | null;
    serviceAccountId: string | null;
  }): Promise<{ code: string; message: string } | null> {
    let identity: DelegatedIdentity;
    if (run.userId) {
      const record = run.conversationId
        ? await this.prisma.aiMessage.findFirst({
            where: {
              conversationId: run.conversationId,
              runId: run.id,
              format: AI_MESSAGE_FORMAT_RUN,
            },
          })
        : null;
      const epoch = record ? readRunRecord(record.content)?.sessionEpoch : null;
      if (epoch === null || epoch === undefined) {
        return { code: 'FORBIDDEN', message: 'The run has no valid session.' };
      }
      identity = { kind: 'human', userId: run.userId, sessionEpoch: epoch };
    } else if (run.serviceAccountId) {
      identity = { kind: 'service', serviceAccountId: run.serviceAccountId };
    } else {
      return { code: 'FORBIDDEN', message: 'The run has no acting principal.' };
    }
    const who = await this.principals.resolve(
      identity,
      run.channel as AiConversationChannel,
    );
    return who.ok ? null : who.refusal;
  }

  private async guarded<T>(name: string, fn: () => Promise<T>): Promise<T | 0> {
    try {
      return await fn();
    } catch (err) {
      this.logger.error(`ai-run sweep (${name}) failed: ${describeError(err)}`);
      return 0;
    }
  }
}
