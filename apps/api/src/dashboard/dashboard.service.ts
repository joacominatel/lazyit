import { Injectable } from '@nestjs/common';
import type {
  DashboardActivityItem,
  DashboardSummary,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';

/** AssetStatus enum values, in schema order — used to zero-fill the `byStatus` buckets. */
const ASSET_STATUSES = [
  'OPERATIONAL',
  'IN_MAINTENANCE',
  'IN_STORAGE',
  'RETIRED',
  'LOST',
  'UNKNOWN',
] as const;

/** Default look-ahead window (days) for "grants expiring soon". */
const DEFAULT_EXPIRING_WITHIN_DAYS = 30;

/** How many recent AssetHistory rows the activity slice returns. */
const RECENT_ACTIVITY_LIMIT = 10;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Read-only dashboard aggregation (CTO Round 1). Composes cheap counts/groupBys across the three
 * pillars into a single typed {@link DashboardSummary}. No persisted "dashboard" entity, no schema
 * change — every figure is derived from existing tables.
 *
 * Soft delete (ADR-0032): reads on soft-deletable models (Asset, Application, Consumable, Article)
 * are auto-scoped to `deletedAt: null` by the Prisma extension, so `count`/`groupBy` here already
 * exclude soft-deleted rows. The lifecycle joins (AssetAssignment, AccessGrant) are NOT
 * soft-deletable, so their close markers (`releasedAt` / `revokedAt`) are filtered explicitly.
 *
 * The queries are independent, so they run concurrently in one `Promise.all` round-trip-ish batch.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** Compute the dashboard snapshot. `expiringWithinDays` tunes the "expiring soon" window. */
  async getSummary(
    expiringWithinDays = DEFAULT_EXPIRING_WITHIN_DAYS,
  ): Promise<DashboardSummary> {
    const now = new Date();
    const expiryCutoff = new Date(now.getTime() + expiringWithinDays * MS_PER_DAY);

    const [
      assetTotal,
      assetsByStatusGroups,
      assignedAssets,
      activeGrants,
      expiringSoon,
      onCriticalApps,
      consumableTotal,
      lowStock,
      articleTotal,
      publishedArticles,
      recentHistory,
    ] = await Promise.all([
      // --- Inventory ---------------------------------------------------------
      this.prisma.asset.count(),
      this.prisma.asset.groupBy({ by: ['status'], _count: { _all: true } }),
      // Distinct assets holding >=1 active assignment. groupBy collapses multi-owner assets to one
      // row each, so its length is the distinct-asset count.
      this.prisma.assetAssignment
        .groupBy({ by: ['assetId'], where: { releasedAt: null } })
        .then((rows) => rows.length),

      // --- Access ------------------------------------------------------------
      this.prisma.accessGrant.count({ where: { revokedAt: null } }),
      this.prisma.accessGrant.count({
        where: {
          revokedAt: null,
          expiresAt: { gt: now, lte: expiryCutoff },
        },
      }),
      // Active grants on critical apps. `application` is a relation filter; the related Application
      // is auto-soft-delete-filtered, so grants whose app is soft-deleted are excluded.
      this.prisma.accessGrant.count({
        where: { revokedAt: null, application: { is: { isCritical: true } } },
      }),

      // --- Consumables -------------------------------------------------------
      this.prisma.consumable.count(),
      // currentStock <= minStock, only for consumables that declare a minStock. Prisma can't compare
      // two columns, so we filter `minStock != null` and post-filter the rows; the set is small
      // (a low-stock alert list) so selecting the two ints and comparing in-process is cheap.
      this.prisma.consumable
        .findMany({
          where: { minStock: { not: null } },
          select: { currentStock: true, minStock: true },
        })
        .then(
          (rows) =>
            rows.filter((c) => c.minStock !== null && c.currentStock <= c.minStock)
              .length,
        ),

      // --- Knowledge ---------------------------------------------------------
      this.prisma.article.count(),
      this.prisma.article.count({ where: { status: 'PUBLISHED' } }),

      // --- Recent activity ---------------------------------------------------
      this.prisma.assetHistory.findMany({
        orderBy: { id: 'desc' },
        take: RECENT_ACTIVITY_LIMIT,
        select: {
          id: true,
          assetId: true,
          eventType: true,
          payload: true,
          performedById: true,
          createdAt: true,
        },
      }),
    ]);

    const byStatus = ASSET_STATUSES.reduce<Record<string, number>>(
      (acc, status) => {
        acc[status] = 0;
        return acc;
      },
      {},
    );
    for (const group of assetsByStatusGroups) {
      byStatus[group.status] = group._count._all;
    }

    const recentActivity: DashboardActivityItem[] = recentHistory.map((row) => ({
      id: row.id,
      assetId: row.assetId,
      eventType: row.eventType,
      payload: (row.payload as Record<string, unknown> | null) ?? null,
      performedById: row.performedById,
      createdAt: row.createdAt.toISOString(),
    }));

    return {
      assets: {
        total: assetTotal,
        byStatus: byStatus as DashboardSummary['assets']['byStatus'],
        assigned: assignedAssets,
      },
      access: {
        activeGrants,
        expiringSoon,
        expiringWithinDays,
        onCriticalApps,
      },
      consumables: {
        total: consumableTotal,
        lowStock,
      },
      articles: {
        total: articleTotal,
        published: publishedArticles,
        draft: articleTotal - publishedArticles,
      },
      recentActivity,
      generatedAt: now.toISOString(),
    };
  }
}
