import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Read a positive-integer ms env var, falling back to `fallback` when unset/blank/non-numeric. */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Staleness threshold: how long since a node's last report before it is flipped OFFLINE. Default is a
 * small multiple (3×) of the agent's 15-min report cadence (ADR-0074 §4/§7) — a node misses two ticks
 * before it is declared dark, so a single dropped report never trips a false OFFLINE.
 */
export const INFRA_AGENT_STALE_AFTER_MS_DEFAULT = 45 * 60 * 1000; // 45 minutes
/** How often the sweep runs. Once per report cadence is ample for a coarse liveness bit. */
export const INFRA_AGENT_SWEEP_INTERVAL_MS_DEFAULT = 15 * 60 * 1000; // 15 minutes

/**
 * The reporting-agent STALENESS sweeper (ADR-0074 §4). `lastReportedAt` is the heartbeat; this
 * periodic pass flips any AGENT node whose last report is older than the threshold to `status=OFFLINE`.
 * The next report flips it back ONLINE (in `InfraService.ingestReport`). This is the ONE coarse
 * "monitoring-ish" feature — a liveness bit, NOT a metric — and it deliberately drives the existing
 * blast-radius UI (a downed agent ⇒ OFFLINE on the map, ADR-0070 §7).
 *
 * Structured exactly like {@link ImportSessionGcSweeper}: a plain `setInterval` (no `@nestjs/schedule`
 * dependency — it isn't installed), `unref`'d so it never holds the process open, NOT started under
 * `NODE_ENV=test` (the Jest suite mocks Prisma / has no real DB), re-entrancy guarded so a slow pass
 * never overlaps the next tick, and the whole pass try/caught so a transient DB error never crashes
 * the app. Threshold + interval are env-tunable (`INFRA_AGENT_STALE_AFTER_MS` /
 * `INFRA_AGENT_SWEEP_INTERVAL_MS`) with sane defaults.
 *
 * ponytail: the bulk flip is ONE `updateMany`; it does NOT re-index each flipped node into search (that
 * would be an N-query fan-out). The search `status` is cosmetic drift that the node's next report
 * self-heals — add per-row search sync only if a stale-but-searchable OFFLINE ever actually misleads.
 */
@Injectable()
export class InfraAgentStalenessSweeper
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(InfraAgentStalenessSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly staleAfterMs = envMs(
    'INFRA_AGENT_STALE_AFTER_MS',
    INFRA_AGENT_STALE_AFTER_MS_DEFAULT,
  );
  private readonly intervalMs = envMs(
    'INFRA_AGENT_SWEEP_INTERVAL_MS',
    INFRA_AGENT_SWEEP_INTERVAL_MS_DEFAULT,
  );

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
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
   * One sweep: flip every live AGENT node that has not reported within the threshold to OFFLINE. Only
   * touches `source=AGENT` nodes that are not already OFFLINE and are not soft-deleted. Returns how
   * many were flipped (telemetry/tests). Re-entrancy guarded; the whole pass is try/caught so a failing
   * sweep never aborts the app or overlaps the next tick. Public so a test / operator can run it.
   */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    this.running = true;
    try {
      const cutoff = new Date(Date.now() - this.staleAfterMs);
      const { count } = await this.prisma.infraNode.updateMany({
        where: {
          source: 'AGENT',
          status: { not: 'OFFLINE' },
          deletedAt: null,
          lastReportedAt: { lt: cutoff },
        },
        data: { status: 'OFFLINE' },
      });
      if (count > 0) {
        this.logger.log(
          `Flipped ${count} stale agent node(s) to OFFLINE (no report since ${cutoff.toISOString()}).`,
        );
      }
      return count;
    } catch (err) {
      this.logger.error(
        `Infra agent staleness sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }
}
