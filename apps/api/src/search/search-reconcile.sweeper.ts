import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { SearchBootstrapService } from './search-bootstrap.service';
import { SearchService } from './search.service';

/** Hourly default cadence — matches the retention sweeper; ample for a 5–20-person estate (ADR-0035). */
export const SEARCH_RECONCILE_DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * The interval between drift-reconcile passes, from `SEARCH_RECONCILE_INTERVAL_MS` (ADR-0028/0035),
 * defaulting to {@link SEARCH_RECONCILE_DEFAULT_INTERVAL_MS}. A non-numeric / non-positive value falls
 * back to the default — a typo'd env must never disable the sweep or spin a 0ms tight loop.
 */
export function resolveReconcileIntervalMs(
  raw: string | undefined = process.env.SEARCH_RECONCILE_INTERVAL_MS,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SEARCH_RECONCILE_DEFAULT_INTERVAL_MS;
}

/**
 * The periodic search drift-reconcile sweeper (issue #383, ADR-0035 amendment 2026-06-14). The
 * fire-and-forget index sync ([[0035]] §3) can silently DROP a write when Meili is down/restarting at
 * write time — leaving the index drifted from the DB (a row that exists-but-isn't-indexed, or a ghost
 * that was-deleted-but-stays-indexed) while the DB itself is fine. The boot self-heal
 * ({@link SearchBootstrapService}) only catches a *wholly empty/missing* index, never a *partial* drift,
 * so until now the only repair was a manual `reindex:all`. This sweeper repairs that drift automatically
 * on a timer — a background self-heal, NOT a write-path gate (the fail-soft posture is unchanged).
 *
 * Structured **exactly like** the notifications retention sweeper
 * (`apps/api/src/notifications/notifications-retention.sweeper.ts`): a plain `setInterval` (no
 * `@nestjs/schedule` dependency), `unref`'d so it never holds the process open, a re-entrancy guard so a
 * slow pass never overlaps the next tick, the whole pass try/caught so a transient Meili/DB error never
 * crashes the API (fail-soft), and NOT started under `NODE_ENV=test` (the Jest suite has no real
 * Meili/DB) nor in search-disabled mode (no `MEILI_HOST`) — the same gates as `SearchBootstrapService`.
 *
 * It does NOT re-implement reindex: each pass delegates to {@link SearchBootstrapService.reconcileAll},
 * which loads the live DB set per index and rebuilds it through the SAME zero-downtime
 * `rebuildIndex → reindexIndex` swap that `reindex:all` and the boot self-heal use (soft-deleted
 * excluded; only PUBLISHED articles — draft privacy, ADR-0022/0035). The manual `reindex:all` stays the
 * deterministic full repair / first-deploy backfill; this sweeper handles ongoing drift between deploys.
 */
@Injectable()
export class SearchReconcileSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchReconcileSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly bootstrap: SearchBootstrapService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (!this.search.enabled) {
      // No Meili configured — nothing to reconcile (same gate as the boot self-heal).
      return;
    }
    const intervalMs = resolveReconcileIntervalMs();
    this.timer = setInterval(() => {
      void this.reconcile();
    }, intervalMs);
    // Never keep the event loop alive just for the reconcile sweep.
    this.timer.unref?.();
    this.logger.log(
      `Search drift-reconcile sweeper started (every ${intervalMs}ms).`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One reconcile pass: rebuild every index from the live DB set via
   * {@link SearchBootstrapService.reconcileAll}. Re-entrancy guarded so a slow pass never overlaps the
   * next tick; the whole pass is try/caught so a transient Meili/DB error never aborts the app. Public so
   * a test / operator can trigger it directly.
   */
  async reconcile(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const indexes = await this.bootstrap.reconcileAll();
      this.logger.log(
        `Search drift-reconcile pass complete (rebuilt ${indexes.length} index(es)).`,
      );
    } catch (err) {
      this.logger.error(
        `Search drift-reconcile pass failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      this.running = false;
    }
  }
}
