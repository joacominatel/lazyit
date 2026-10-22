import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  AGENT_POLICY_STALE_MIN_SECONDS,
  isAlertsSnoozed,
} from '@lazyit/shared';
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
 * FALLBACK staleness threshold: how long since a node's last report before it is flipped OFFLINE, for
 * a node that has not been served one of its own. Default is a small multiple (3×) of the agent's
 * 15-min report cadence (ADR-0074 §4/§7) — a node misses two ticks before it is declared dark, so a
 * single dropped report never trips a false OFFLINE.
 *
 * It is no longer the ONLY threshold (#1140). A node the policy channel has reached carries the
 * staleness it was served in `policyStaleAfterSeconds` and is judged against THAT; this env var
 * covers manual nodes, agents that predate the policy channel, and any tick whose resolution failed.
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
 * the app. The sweep INTERVAL and the FALLBACK threshold are env-tunable
 * (`INFRA_AGENT_SWEEP_INTERVAL_MS` / `INFRA_AGENT_STALE_AFTER_MS`) with sane defaults.
 *
 * The THRESHOLD is now per node (#1140), not one global value: each node is judged against the
 * staleness its own resolved policy served it (`policyStaleAfterSeconds`), falling back to the env
 * default when it has none. That is what makes heterogeneous cadences possible at all — under one
 * global cutoff, a host the operator moved to a daily report sat OFFLINE 23 hours out of 24.
 *
 * BOOT GRACE (#1674, split from #1146 item 8): for one staleness window after THIS process booted, a
 * node is not flipped OFFLINE. While the API was down nobody was listening, so every agent's
 * `lastReportedAt` is old for a reason that says nothing about the host; without the grace the first
 * sweeps after any restart flip the whole estate OFFLINE and broadcast one `infra.agent_offline` lie per
 * node, and the next report flips each straight back. The grace is per node and reuses the node's own
 * window — the sweep measures silence from `max(lastReportedAt, bootedAtMs)` instead of from
 * `lastReportedAt`, so every node gets one full window of ITS threshold, counted from boot, to check in.
 * An agent retries on its next tick after a failed report (its due-ness keys on its last SUCCESS), so a
 * live host lands well inside that window. Nothing else is suppressed: reports are ingested normally
 * during the grace, and a node already OFFLINE stays OFFLINE until it reports. Per process, which is the
 * right scope: one API container per instance (single-host Compose, ADR-0015), and any replica that
 * stayed up while another restarted was still receiving reports, so its own sweep is not fooled.
 *
 * RETIRED NODES ARE SKIPPED (#1701, epic #1146 Q11). A retired node is gone, not silent: it is never
 * selected, so it is never flipped OFFLINE and never announced. Its status stays whatever it was when
 * it was retired. The skip is in BOTH the candidate read and the conditional flip, so a node retired
 * between the two is not flipped either.
 *
 * SNOOZED NODES ARE FLIPPED BUT NOT ANNOUNCED (#1701, epic #1146 Q15). While `alertsSnoozedUntil` is in
 * the future the node still goes OFFLINE — the map must stay true — but no `infra.agent_offline` nudge
 * (bell or email) is emitted for that transition. The nudge is per TRANSITION, so an outage that began
 * inside the window is not re-announced when the window ends: the node is already OFFLINE and is no
 * longer a candidate. A node that recovers and goes silent again after the window is announced normally.
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

  /** The clock (tests move it). */
  now: () => number = Date.now;
  /**
   * When this process booted, for the boot grace (tests move it). Captured when Nest constructs the
   * provider during `NestFactory.create` — seconds before the HTTP listener opens, which is noise against
   * a window of at least five minutes.
   */
  bootedAtMs: number = this.now();

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
      const now = this.now();
      // The WIDEST cutoff any node could use: the env default or the policy floor, whichever admits
      // more rows. It is only a cheap pre-filter — the per-node decision happens below — so it must
      // never exclude a node that its OWN threshold would have caught.
      const candidateCutoff = new Date(
        now -
          Math.min(this.staleAfterMs, AGENT_POLICY_STALE_MIN_SECONDS * 1000),
      );
      const where = {
        source: 'AGENT',
        status: { not: 'OFFLINE' },
        deletedAt: null,
        // Retired = gone, not silent (#1701): never flipped, never announced.
        retiredAt: null,
        lastReportedAt: { lt: candidateCutoff },
      } as const;
      // Snapshot the nodes about to transition INTO OFFLINE — the `status != OFFLINE` filter guarantees
      // these are genuine transitions, so we get the transition set the bulk `updateMany` can't return.
      const candidates = await this.prisma.infraNode.findMany({
        where,
        select: {
          id: true,
          label: true,
          lastReportedAt: true,
          policyStaleAfterSeconds: true,
          alertsSnoozedUntil: true,
        },
      });
      // PER-NODE, not one global cutoff (#1140). The threshold used to be a single env var, which made
      // heterogeneous cadences structurally impossible: a host the operator moved to a daily report sat
      // OFFLINE 23 hours out of 24 and nudged the bell every day. Each node is now judged against the
      // staleness it was actually SERVED, and a node that has never been served one (a manual row, a
      // pre-#1140 agent, a policy resolution that failed) falls back to the env default — i.e. exactly
      // the previous behaviour.
      //
      // Filtering in memory rather than in SQL is deliberate and bounded: lazyit is a 5–20-person,
      // few-dozen-host product, the candidate set is only the agent nodes that are already past the
      // SHORTEST possible threshold, and the alternative is hand-written SQL with an interval
      // expression that Prisma cannot type. Revisit it if an estate ever makes this the slow part.
      //
      // The boot grace (#1674) lives here too: silence is measured from the later of the node's last
      // report and this process's boot, so for one window of the node's OWN threshold after a restart
      // nothing it could not have reported to is held against it. Same strict `<` as before: a node
      // exactly one window past boot is still inside, one millisecond later it is not.
      let heldByBootGrace = 0;
      const transitioning = candidates.filter((node) => {
        const perNodeMs =
          node.policyStaleAfterSeconds !== null &&
          node.policyStaleAfterSeconds !== undefined
            ? node.policyStaleAfterSeconds * 1000
            : this.staleAfterMs;
        // `lastReportedAt` is never null here: the query's `lt` comparison already excludes NULLs,
        // exactly as it did before this change. The `?? 0` is a type narrowing, not a policy.
        const lastMs = node.lastReportedAt?.getTime() ?? 0;
        const cutoffMs = now - perNodeMs;
        if (lastMs >= cutoffMs) return false;
        if (this.bootedAtMs >= cutoffMs) {
          heldByBootGrace += 1;
          return false;
        }
        return true;
      });
      if (heldByBootGrace > 0) {
        this.logger.log(
          `Boot grace: ${heldByBootGrace} silent agent node(s) not flipped OFFLINE — the API booted less than one staleness window ago.`,
        );
      }
      if (transitioning.length === 0) return 0;
      // Conditional on the snapshot's own report instant (AUD-058): a node that checked in after the
      // read carries a newer `lastReportedAt` and is neither flipped nor announced.
      const flipped = await this.prisma.infraNode.updateManyAndReturn({
        where: {
          status: { not: 'OFFLINE' },
          deletedAt: null,
          retiredAt: null,
          OR: transitioning.map((n) => ({
            id: n.id,
            lastReportedAt: n.lastReportedAt,
          })),
        },
        data: { status: 'OFFLINE' },
        select: { id: true },
      });
      const count = flipped.length;
      if (count > 0) {
        this.logger.log(
          `Flipped ${count} stale agent node(s) to OFFLINE, each judged against the staleness threshold it was last served (default ${this.staleAfterMs}ms).`,
        );
      }
      // One broadcast nudge per OFFLINE transition (ADR-0056 amendment / #852), POST-flip + best-effort
      // (emit never throws — a failed nudge must not abort the sweep). Deduped on the node's last-report
      // instant, so a node stuck OFFLINE across many sweeps is not re-selected (status is now OFFLINE)
      // and a genuinely NEW outage (a fresh lastReportedAt) yields a fresh key ⇒ a fresh nudge.
      const flippedIds = new Set(flipped.map((row) => row.id));
      let snoozed = 0;
      for (const node of transitioning) {
        if (!flippedIds.has(node.id)) continue;
        // A snoozed node (#1701) still flipped above; only its announcement is suppressed.
        if (isAlertsSnoozed(node.alertsSnoozedUntil, now)) {
          snoozed += 1;
          continue;
        }
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
      if (snoozed > 0) {
        this.logger.log(
          `${snoozed} of them had offline alerts snoozed — flipped OFFLINE without a notification.`,
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
