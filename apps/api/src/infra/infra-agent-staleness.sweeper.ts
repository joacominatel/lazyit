import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

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
      const where = {
        source: 'AGENT',
        status: { not: 'OFFLINE' },
        deletedAt: null,
        lastReportedAt: { lt: cutoff },
      } as const;
      // Snapshot the nodes about to transition INTO OFFLINE — the `status != OFFLINE` filter guarantees
      // these are genuine transitions, so we get the transition set the bulk `updateMany` can't return.
      const transitioning = await this.prisma.infraNode.findMany({
        where,
        select: { id: true, label: true, lastReportedAt: true },
      });
      const { count } = await this.prisma.infraNode.updateMany({
        where,
        data: { status: 'OFFLINE' },
      });
      if (count > 0) {
        this.logger.log(
          `Flipped ${count} stale agent node(s) to OFFLINE (no report since ${cutoff.toISOString()}).`,
        );
      }
      // One broadcast nudge per OFFLINE transition (ADR-0056 amendment / #852), POST-flip + best-effort
      // (emit never throws — a failed nudge must not abort the sweep). Deduped on the node's last-report
      // instant, so a node stuck OFFLINE across many sweeps is not re-selected (status is now OFFLINE)
      // and a genuinely NEW outage (a fresh lastReportedAt) yields a fresh key ⇒ a fresh nudge.
      // ponytail: emitting for the SNAPSHOT set, not the exact rows updateMany flipped — a node that
      // reports in between the two queries is excluded from the flip (its lastReportedAt is fresh) yet
      // may still get one nudge. Accepted: a two-query race window, deduped, on a small agent cohort.
      // Ceiling: the exact flipped set would need a RETURNING clause (raw SQL) or a per-node update.
      for (const node of transitioning) {
        await this.notifications.emit({
          type: 'infra.agent_offline',
          dedupeKey: `infra.agent_offline:${node.id}:${node.lastReportedAt?.toISOString() ?? 'never'}`,
          severity: 'warning',
          title: `Agent offline: ${node.label}`,
          summary: node.lastReportedAt
            ? `No report from ${node.label} since ${node.lastReportedAt.toISOString()}. It may be down or disconnected.`
            : `${node.label} has stopped reporting. It may be down or disconnected.`,
          // No entityType — the bell deep-links this type to the topology map.
          metadata: {
            nodeId: node.id,
            label: node.label,
            lastReportedAt: node.lastReportedAt?.toISOString() ?? null,
          },
        });
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
