import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  projectApplication,
  projectArticle,
  projectAsset,
  projectConsumable,
  projectInfraNode,
  projectLocation,
  projectPurchaseOrder,
  projectSupplier,
  projectUser,
  PURCHASE_ORDER_SEARCH_SELECT,
  type SearchDocument,
} from './search.documents';
import {
  SearchService,
  SEARCH_INDEXES,
  type SearchIndex,
} from './search.service';

/**
 * Boot-time search self-heal (issue #370). A freshly-seeded database leaves the five Meili indexes
 * empty (the seed never indexes; `reindex:all` is a manual step), so search silently returns nothing
 * until an operator remembers to reindex. This guard closes that gap WITHOUT making it unsafe on a
 * populated prod DB:
 *
 * - On boot it asks Meili which indexes are **missing or empty** ({@link SearchService.emptyOrMissingIndexes})
 *   and rebuilds only those, in the BACKGROUND. It is a strict **no-op when every index already has
 *   documents** — so on a large prod DB there is nothing to lose and nothing happens.
 * - It runs `onApplicationBootstrap` un-awaited (fire-and-forget), so it NEVER blocks boot/readiness:
 *   the app is serving requests while any rebuild proceeds. A rebuild uses the same zero-downtime
 *   temp-index-swap as `reindex:all` ({@link SearchService.rebuildIndex} → `reindexIndex`).
 * - It first WAITS (bounded, {@link SELF_HEAL_ENGINE_WAIT}) for the engine to answer `/health` (#1216).
 *   There is no api → meilisearch `depends_on` (fail-soft), so on `up -d` the API can finish booting
 *   before Meili is reachable — most visibly right after a server upgrade, which starts Meili on a NEW,
 *   empty data volume (ADR-0035 amendment 2026-09-26). Without the wait, the single boot probe would
 *   fail, be logged, and leave search empty until the hourly reconcile sweeper. If the engine never
 *   answers inside the window, the pass is skipped and the reconcile sweeper remains the backstop.
 * - It is a no-op in search-disabled mode (no `MEILI_HOST`) and under `NODE_ENV=test` (the Jest suite
 *   has no real Meili/DB), and any failure is caught and logged — index-health probing must never
 *   crash the API.
 *
 * The live set mirrors the read-path / `reindex:all` visibility exactly: soft-deleted rows are excluded
 * (`deletedAt: null`) and only PUBLISHED articles are indexed (draft privacy — ADR-0022/0035).
 */
/** How long the boot self-heal waits for the engine to answer `/health` before probing (#1216). */
export interface EngineWait {
  /** Health probes before giving up (the first probe is immediate). */
  attempts: number;
  /** Delay between probes, in milliseconds. */
  intervalMs: number;
}

/**
 * Default engine wait: 30 probes × 10s ≈ 5 minutes. Generous for a container that is still starting,
 * bounded so a Meili that is genuinely down does not keep a background task alive forever (the hourly
 * reconcile sweeper covers that case).
 */
export const SELF_HEAL_ENGINE_WAIT: EngineWait = {
  attempts: 30,
  intervalMs: 10_000,
};

/** An `unref`'d sleep, so a pending wait never holds the process open during shutdown. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

@Injectable()
export class SearchBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SearchBootstrapService.name);

  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (!this.search.enabled) {
      return;
    }
    // Fire-and-forget: do NOT await — boot/readiness must not wait on a (potentially large) rebuild.
    void this.selfHeal();
  }

  /**
   * One self-heal pass: find the missing/empty indexes and rebuild each from the live DB set. Public so
   * a test or operator can trigger it directly. The whole pass is try/caught so a transient Meili/DB
   * error never escapes the background task. Returns the indexes it (attempted to) rebuild.
   */
  async selfHeal(
    wait: EngineWait = SELF_HEAL_ENGINE_WAIT,
  ): Promise<SearchIndex[]> {
    try {
      if (!(await this.waitForEngine(wait))) {
        this.logger.warn(
          `Search self-heal skipped: Meilisearch did not answer /health after ${wait.attempts} attempt(s). ` +
            'The drift-reconcile sweeper will rebuild the indexes once it is reachable.',
        );
        return [];
      }
      const stale = await this.search.emptyOrMissingIndexes();
      if (stale.length === 0) {
        // Every index already has documents — nothing to do (the safe, common prod path).
        return [];
      }
      this.logger.log(
        `Search self-heal: ${stale.length} empty/missing index(es) [${stale.join(', ')}] — rebuilding in the background.`,
      );
      for (const index of stale) {
        await this.rebuild(index, 'self-heal');
      }
      return stale;
    } catch (err) {
      this.logger.error(
        `Search self-heal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * Poll the engine's health until it answers or the bounded window runs out (#1216). Returns whether
   * the engine became reachable. The first probe is immediate, so a healthy engine costs one call.
   */
  private async waitForEngine(wait: EngineWait): Promise<boolean> {
    const attempts = Math.max(1, wait.attempts);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (await this.search.isHealthy()) {
        return true;
      }
      if (attempt < attempts) {
        await sleep(wait.intervalMs);
      }
    }
    return false;
  }

  /**
   * One drift-reconcile pass (issue #383, ADR-0035 amendment 2026-06-14): rebuild **every** index from
   * its live DB set, reusing the exact `loadDocs → rebuildIndex → reindexIndex` seam the boot self-heal
   * and `reindex:all` use. Unlike {@link selfHeal} (which only touches empty/missing indexes), this runs
   * unconditionally so a *partial* drift — a single dropped fire-and-forget `upsert`/`remove` while the
   * DB stayed up — is repaired without a manual `reindex:all`. Each index is rebuilt zero-downtime via
   * the temp-index-swap; a per-index failure is logged and the pass continues to the next index. Public
   * so the {@link SearchReconcileSweeper} (and a test/operator) can trigger it directly. Sequential, to
   * never run five concurrent rebuilds against a possibly-recovering engine.
   */
  async reconcileAll(): Promise<SearchIndex[]> {
    for (const index of SEARCH_INDEXES) {
      await this.rebuild(index, 'reconcile');
    }
    return [...SEARCH_INDEXES];
  }

  /**
   * Load the live set for one index and rebuild it (zero-downtime). `label` only tags the log line
   * (`self-heal` vs `reconcile`) so the two callers read distinctly in the logs. Errors are logged,
   * not thrown — a single index's failure never aborts the surrounding pass.
   */
  private async rebuild(
    index: SearchIndex,
    label: 'self-heal' | 'reconcile',
  ): Promise<void> {
    try {
      const docs = await this.loadDocs(index);
      await this.search.rebuildIndex(index, docs);
      this.logger.log(
        `Search ${label}: rebuilt '${index}' with ${docs.length} document(s).`,
      );
    } catch (err) {
      this.logger.error(
        `Search ${label}: failed to rebuild '${index}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The live, indexable document set for one index — same visibility the read path and `reindex:all`
   * enforce (soft-deleted excluded; only PUBLISHED articles).
   */
  private async loadDocs(index: SearchIndex): Promise<SearchDocument[]> {
    switch (index) {
      case 'assets': {
        const rows = await this.prisma.asset.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectAsset);
      }
      case 'articles': {
        // Draft privacy (ADR-0022/0035): only PUBLISHED articles are searchable.
        const rows = await this.prisma.article.findMany({
          where: { deletedAt: null, status: 'PUBLISHED' },
        });
        return rows.map(projectArticle);
      }
      case 'users': {
        const rows = await this.prisma.user.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectUser);
      }
      case 'locations': {
        const rows = await this.prisma.location.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectLocation);
      }
      case 'applications': {
        const rows = await this.prisma.application.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectApplication);
      }
      case 'infra': {
        // Soft-deleted nodes are off the map (ADR-0070) — excluded, like every other index. Join the
        // linked Asset's `name` for the searchable `assetName` (null when graph-only).
        const rows = await this.prisma.infraNode.findMany({
          where: { deletedAt: null },
          select: {
            id: true,
            label: true,
            kind: true,
            status: true,
            state: true,
            ipAddress: true,
            asset: { select: { name: true } },
          },
        });
        return rows.map(projectInfraNode);
      }
      case 'consumables': {
        // #873: soft-deleted consumables are excluded like every other index. Flat, no joins.
        const rows = await this.prisma.consumable.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectConsumable);
      }
      case 'purchases': {
        // #1499: archived purchases excluded; the supplier name and live line descriptions joined.
        const rows = await this.prisma.purchaseOrder.findMany({
          where: { deletedAt: null },
          select: PURCHASE_ORDER_SEARCH_SELECT,
        });
        return rows.map(projectPurchaseOrder);
      }
      case 'suppliers': {
        const rows = await this.prisma.supplier.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectSupplier);
      }
    }
  }
}
