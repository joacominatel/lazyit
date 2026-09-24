import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { describeError } from '../runtime/runtime.constants';
import {
  AiConversationPurgeService,
  retentionCutoff,
} from './ai-conversation-purge.service';

/** How often the retention pass runs. Hourly bounds the offboarding purge's latency; each pass is cheap. */
export const AI_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** What one pass deleted (counts only — for tests and the log line). */
export interface AiRetentionSweepResult {
  /** The retention window applied, or `null` when the pass was skipped (settings unreadable, re-entry). */
  retentionDays: number | null;
  /** Conversations whose `lastActivityAt` fell past retention. */
  expired: number;
  /** Conversations of offboarded (soft-deleted) users. */
  offboarded: number;
  /** Conversation-less (MCP) tool invocations past retention. */
  mcpInvocations: number;
}

const SKIPPED: AiRetentionSweepResult = {
  retentionDays: null,
  expired: 0,
  offboarded: 0,
  mcpInvocations: 0,
};

/**
 * THE AI RETENTION SWEEPER (ADR-0097 decision 11; provider-and-runtime.md §7 "Retention"; tools §11). A
 * periodic pass that hard-deletes, through {@link AiConversationPurgeService}:
 *
 *  1. conversations whose `lastActivityAt` is older than `AiSettings.retentionDays` (7–3650, default 90),
 *     with their messages and tool invocations by cascade;
 *  2. conversations of offboarded users (`User.deletedAt` set) — the offboarding purge (§14 item 2). The
 *     soft delete is the durable offboarding signal, so no hook in the users module is needed; the purge
 *     lands within one pass. Only `deletedAt` triggers it: a deactivation or a directory soft-offboard
 *     (`isActive = false` + `directoryOffboardedAt`) follows normal retention (CEO decision 2026-09-24);
 *  3. conversation-less MCP invocations older than the window and no longer in flight.
 *
 * A conversation with an active run (QUEUED, RUNNING, AWAITING_APPROVAL or AWAITING_INPUT), or an in-flight tool invocation, is skipped and retried next pass. It runs
 * whether or not the assistant is enabled (frontend.md §11 item 4: turning AI off keeps conversations
 * dormant and retention keeps running); with no settings row the default window applies. A failed settings
 * read skips the whole pass rather than guess a window. `AiRun`, `AiUsage` and `AiActionLog` are never
 * deleted.
 *
 * The notifications-retention / workflow-run sweeper shape: a plain `unref`'d interval, not started under
 * `NODE_ENV=test`, re-entrancy guarded, every step try/caught, and the log line carries counts only.
 */
@Injectable()
export class AiRetentionSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiRetentionSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly purge: AiConversationPurgeService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, AI_RETENTION_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One pass. Public so a test (or an operator) can run it directly. */
  async sweep(now: Date = new Date()): Promise<AiRetentionSweepResult> {
    if (this.running) {
      return { ...SKIPPED };
    }
    this.running = true;
    try {
      let retentionDays: number;
      try {
        retentionDays = await this.purge.retentionDays();
      } catch (err) {
        this.logger.error(
          `AI retention pass skipped: the settings could not be read (${describeError(err)})`,
        );
        return { ...SKIPPED };
      }
      const cutoff = retentionCutoff(retentionDays, now);
      const result: AiRetentionSweepResult = {
        retentionDays,
        expired: await this.step('expired', () =>
          this.purge
            .purgeWhere({ lastActivityAt: { lt: cutoff } })
            .then((o) => o.deleted),
        ),
        offboarded: await this.step('offboarded', () =>
          this.purge
            .purgeWhere({ user: { is: { deletedAt: { not: null } } } })
            .then((o) => o.deleted),
        ),
        mcpInvocations: await this.step('mcp', () =>
          this.purge.pruneMcpInvocations(cutoff),
        ),
      };
      if (result.expired + result.offboarded + result.mcpInvocations > 0) {
        this.logger.log(
          `AI retention (${retentionDays} days): deleted ${result.expired} expired and ${result.offboarded} offboarded conversation(s), ${result.mcpInvocations} MCP invocation(s)`,
        );
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /** One independent step: a failure is logged by class and code (never a message) and counts as 0. */
  private async step(name: string, run: () => Promise<number>) {
    try {
      return await run();
    } catch (err) {
      this.logger.error(
        `AI retention step "${name}" failed: ${describeError(err)}`,
      );
      return 0;
    }
  }
}
