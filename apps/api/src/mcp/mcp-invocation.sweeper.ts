import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AiToolService } from '../ai/core/ai-tool.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  MCP_EXECUTING_STALE_AFTER_MS,
  MCP_SWEEP_BATCH,
  MCP_SWEEP_INTERVAL_MS,
} from './mcp.constants';

/**
 * Crash recovery for MCP writes (tools-and-execution.md §9; the W2-0 follow-up). An MCP `tools/call` of a
 * write records its invocation `EXECUTING` write-ahead and finalizes it when the handler returns; if the
 * process dies in between, the row would stay `EXECUTING` forever. The runtime's sweeper only reconciles
 * invocations that belong to a run (chat, headless) — MCP invocations have none.
 *
 * This pass marks every MCP invocation still `EXECUTING` {@link MCP_EXECUTING_STALE_AFTER_MS} after its
 * last update `OUTCOME_UNKNOWN` through {@link AiToolService.markOutcomeUnknown}: the ledger records
 * `FAILED` / `UNKNOWN_OUTCOME`, and it is NEVER retried (the `aiInvocationId` stamp on history rows lets
 * an operator check whether the change committed). The threshold is far longer than any HTTP request, so
 * a call still in flight on another replica is not touched.
 *
 * The `OAuthSweeper` shape: an unref'd interval, not started under `NODE_ENV=test`, re-entrancy guarded,
 * a failing pass logged and never crashing the app.
 */
@Injectable()
export class McpInvocationSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpInvocationSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tools: AiToolService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, MCP_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass; returns how many invocations it marked `OUTCOME_UNKNOWN`. */
  async sweep(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const cutoff = new Date(now.getTime() - MCP_EXECUTING_STALE_AFTER_MS);
      const stuck = await this.prisma.aiToolInvocation.findMany({
        where: {
          channel: 'MCP',
          status: 'EXECUTING',
          runId: null,
          updatedAt: { lt: cutoff },
        },
        select: { id: true },
        orderBy: { updatedAt: 'asc' },
        take: MCP_SWEEP_BATCH,
      });
      let marked = 0;
      for (const { id } of stuck) {
        try {
          if (await this.tools.markOutcomeUnknown(id)) marked += 1;
        } catch (err) {
          this.logger.error(
            `Could not mark MCP invocation ${id} OUTCOME_UNKNOWN: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      if (marked > 0) {
        this.logger.warn({ event: 'ai.mcp.sweep', outcomeUnknown: marked });
      }
      return marked;
    } catch (err) {
      this.logger.error(
        `MCP invocation sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
