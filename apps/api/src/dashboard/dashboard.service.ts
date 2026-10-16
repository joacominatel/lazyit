import { Injectable } from '@nestjs/common';
import type {
  DashboardActivityItem,
  DashboardSummary,
  Page,
  RecentActivityAction,
  RecentActivityFilterOptions,
  RecentActivityFilters,
  RecentActivityItem,
  RecentActivityQuery,
} from '@lazyit/shared';
import {
  offsetOf,
  pageOf,
  RECENT_ACTIVITY_ACTIONS,
  WARRANTY_EXPIRING_WITHIN_DAYS,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import {
  LIKE_ESCAPE_CHAR,
  escapeLikePattern,
} from '../common/escape-like-pattern';
import type { ExportColumn, KeysetCursor } from '../common/export';
import { PrismaService } from '../prisma/prisma.service';
import { ACTIVITY_EXPORT_COLUMNS } from './activity-export-columns';

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
 * The shared `recent_activity` read projection + source (view + actor LEFT JOIN), factored out so the
 * page read, the count, AND the bulk export (issue #840) all read identical columns from the identical
 * source — they can never drift. Composed via nested `Prisma.sql` (parameterized, never concatenated).
 */
const ACTIVITY_SELECT_COLUMNS = Prisma.sql`
  ra."occurredAt",
  ra."actorId",
  CASE WHEN u."id" IS NULL THEN NULL
       ELSE u."firstName" || ' ' || u."lastName" END AS "actorName",
  ra."entityType",
  ra."entityId",
  ra."action",
  ra."summary",
  ra."subjectName",
  ra."targetUserId",
  ra."targetUserName"
`;
const ACTIVITY_FROM = Prisma.sql`
  FROM "recent_activity" ra
  LEFT JOIN "users" u ON u."id" = ra."actorId"
`;

/**
 * Newest first, then a fixed order over the columns that tell rows apart (AUD-032). A batch operation
 * stamps one `occurredAt` on many rows (an offboarding revokes every grant at the same instant), and
 * Postgres orders ties arbitrarily, so OFFSET pages could repeat or drop rows at a boundary. The export
 * pages by keyset on the view's `sourceKey` instead ({@link DashboardService.activityExport}). The view has no source row id; every other output column (`actorName`, `subjectName`,
 * `targetUserName`) is derived from these keys, so rows still tied are byte-identical and their order
 * cannot change what a page or the CSV shows.
 */
const ACTIVITY_ORDER_BY = Prisma.sql`
  ORDER BY ra."occurredAt" DESC, ra."entityType", ra."entityId", ra."action",
    ra."targetUserId", ra."actorId", ra."summary"
`;

/** The filtered count over the feed's own source; the page read and the export both use it. */
const activityCountSql = (where: Prisma.Sql) => Prisma.sql`
  SELECT COUNT(*)::bigint AS count
  ${ACTIVITY_FROM}
  ${where}
`;

/**
 * Read-only dashboard aggregation (CTO Round 1). Composes cheap counts/groupBys across the three
 * pillars into a single typed {@link DashboardSummary}. No persisted "dashboard" entity, no schema
 * change — every figure is derived from existing tables.
 *
 * Soft delete (ADR-0032): top-level reads on Asset, Application and Article are auto-scoped to
 * `deletedAt: null` by the Prisma extension. Consumable is deliberately outside the extension, so its
 * reads filter `deletedAt: null` explicitly. The lifecycle joins (AssetAssignment, AccessGrant) and the
 * append-only AssetHistory are not soft-deletable: archiving the parent leaves their rows in place, and
 * the extension never scopes a relation filter, so they filter their close markers (`releasedAt` /
 * `revokedAt`) AND the parent's `deletedAt: null` explicitly (SEC-071).
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
    const expiryCutoff = new Date(
      now.getTime() + expiringWithinDays * MS_PER_DAY,
    );
    // Warranty look-ahead window (#955): its own fixed horizon (WARRANTY_EXPIRING_WITHIN_DAYS),
    // independent of the tunable access-grant window above.
    const warrantyCutoff = new Date(
      now.getTime() + WARRANTY_EXPIRING_WITHIN_DAYS * MS_PER_DAY,
    );

    const [
      assetTotal,
      warrantiesExpiringSoon,
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
      // Live assets whose warranty ends within the next window and hasn't lapsed (now < warrantyEnd
      // <= now + N days) — mirrors the access-grant expiringSoon window (#955). Soft-deleted assets
      // are auto-excluded by the ADR-0032 extension; assets with no warrantyEnd never match.
      this.prisma.asset.count({
        where: { warrantyEnd: { gt: now, lte: warrantyCutoff } },
      }),
      this.prisma.asset.groupBy({ by: ['status'], _count: { _all: true } }),
      // Distinct live assets holding >=1 active assignment. groupBy collapses multi-owner assets to one
      // row each, so its length is the distinct-asset count.
      this.prisma.assetAssignment
        .groupBy({
          by: ['assetId'],
          where: { releasedAt: null, asset: { is: { deletedAt: null } } },
        })
        .then((rows) => rows.length),

      // --- Access ------------------------------------------------------------
      this.prisma.accessGrant.count({
        where: { revokedAt: null, application: { is: { deletedAt: null } } },
      }),
      this.prisma.accessGrant.count({
        where: {
          revokedAt: null,
          expiresAt: { gt: now, lte: expiryCutoff },
          application: { is: { deletedAt: null } },
        },
      }),
      this.prisma.accessGrant.count({
        where: {
          revokedAt: null,
          application: { is: { isCritical: true, deletedAt: null } },
        },
      }),

      // --- Consumables -------------------------------------------------------
      this.prisma.consumable.count({ where: { deletedAt: null } }),
      // currentStock <= minStock, only for consumables that declare a minStock. Prisma can't compare
      // two columns, so we filter `minStock != null` and post-filter the rows; the set is small
      // (a low-stock alert list) so selecting the two ints and comparing in-process is cheap.
      this.prisma.consumable
        .findMany({
          where: { deletedAt: null, minStock: { not: null } },
          select: { currentStock: true, minStock: true },
        })
        .then(
          (rows) =>
            rows.filter(
              (c) => c.minStock !== null && c.currentStock <= c.minStock,
            ).length,
        ),

      // --- Knowledge ---------------------------------------------------------
      this.prisma.article.count(),
      this.prisma.article.count({ where: { status: 'PUBLISHED' } }),

      // --- Recent activity ---------------------------------------------------
      this.prisma.assetHistory.findMany({
        where: { asset: { is: { deletedAt: null } } },
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

    const recentActivity: DashboardActivityItem[] = recentHistory.map(
      (row) => ({
        id: row.id,
        assetId: row.assetId,
        eventType: row.eventType,
        payload: (row.payload as Record<string, unknown> | null) ?? null,
        performedById: row.performedById,
        createdAt: row.createdAt.toISOString(),
      }),
    );

    return {
      assets: {
        total: assetTotal,
        byStatus: byStatus,
        assigned: assignedAssets,
        warrantiesExpiringSoon,
        warrantyExpiringWithinDays: WARRANTY_EXPIRING_WITHIN_DAYS,
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

  /**
   * Recent activity feed (CEO Round 2, ADR-0043; filterable per issue #181 / DEBT-1; user source added
   * by DEBT-2 / ADR-0050) — the unified, cross-pillar stream, newest first and offset-paginated
   * (ADR-0030). Reads the `recent_activity` Postgres VIEW (a `UNION ALL` over AssetHistory,
   * AssetAssignment, AccessGrant, ConsumableMovement and UserHistory; Prisma cannot express a UNION
   * view, so it lives as raw SQL in a migration and is read here with a typed `$queryRaw`). The view
   * already drops rows whose parent entity is soft-deleted.
   *
   * The actor display name is resolved with a LEFT JOIN to `users` (lightly — just first/last name);
   * `actorId`/`actorName` are null for system/unknown actors or a deleted actor whose audit FK was
   * set null. The page slice and the `count` run over the SAME view + the SAME WHERE inside one
   * `$transaction`, so the `total` reflects the FILTERED set and cannot drift from the page under
   * concurrent writes to any source.
   *
   * SUBJECT enrichment (issue #311): the row also carries `subjectName` (the affected entity's resolved
   * display name) and `targetUserId`/`targetUserName` (the user the event is ABOUT — the grant holder /
   * assignment owner / user-history subject, distinct from the actor). The view resolves these from each
   * source's existing relations (so no widened access — the feed is already gated on logs:read), and a
   * soft-deleted target user resolves to null. The web turns them into a specific headline
   * ("Access to <App> revoked from <User>") and a click-through to that person's detail.
   *
   * Filters (issue #181) are OPTIONAL and additive — `entityType`, `entityId`, `actorId`, `action`,
   * a closed-open `[from, to)` window over `occurredAt`, and a free-text `q` over `summary` + the
   * resolved actor name. Each is a PARAMETERIZED `Prisma.sql` fragment (never string concatenation),
   * so the values can never break out of their bind slot (injection guard). `actorId` is already
   * resolved to a concrete uuid by the controller (`"me"` → the caller's subject); the service never
   * sees `"me"`.
   */
  async getActivity(
    query: RecentActivityQuery,
  ): Promise<Page<RecentActivityItem>> {
    const { take, skip } = offsetOf(query);
    const where = this.buildActivityWhere(query);

    const [rows, totalRows] = await this.prisma.$transaction([
      // Subject enrichment (issue #311) rides in ACTIVITY_SELECT_COLUMNS: the view resolves the
      // affected entity's name + the target user the event concerns from each source's existing
      // relations, so the web renders a specific, click-through headline.
      this.prisma.$queryRaw<RecentActivityRow[]>(Prisma.sql`
        SELECT ${ACTIVITY_SELECT_COLUMNS}
        ${ACTIVITY_FROM}
        ${where}
        ${ACTIVITY_ORDER_BY}
        LIMIT ${take} OFFSET ${skip}
      `),
      // The COUNT carries the SAME LEFT JOIN + WHERE so a `q` over the actor name counts identically
      // to what the page returns — `total` is the FILTERED count, never the whole view.
      this.prisma.$queryRaw<[{ count: bigint }]>(activityCountSql(where)),
    ]);

    const total = Number(totalRows[0]?.count ?? 0);
    const items: RecentActivityItem[] = rows.map(rowToActivityItem);

    return pageOf(items, total, query);
  }

  /**
   * The activity export's pieces for the engine (ADR-0103): the feed's own filters over the same view
   * and actor join, newest first by keyset on `(occurredAt, sourceKey)` — an event recorded mid-export
   * sorts ahead of the cursor and is never sent twice. The on-screen feed keeps its OFFSET pages.
   */
  activityExport(query: RecentActivityFilters): ActivityExport {
    const conditions = this.activityConditions(query);
    return {
      columns: ACTIVITY_EXPORT_COLUMNS,
      count: async () => {
        const [row] = await this.prisma.$queryRaw<[{ count: bigint }]>(
          activityCountSql(whereOf(conditions)),
        );
        return Number(row?.count ?? 0);
      },
      fetchBatch: async (after, take) => {
        // The Date itself, not an ISO string: the adapter writes it back as the wall-clock it read.
        const keyset = after
          ? [
              Prisma.sql`(ra."occurredAt", ra."sourceKey") < (${after.createdAt}::timestamptz, ${String(after.id)})`,
            ]
          : [];
        const rows = await this.prisma.$queryRaw<
          (RecentActivityRow & { sourceKey: string })[]
        >(Prisma.sql`
          SELECT ${ACTIVITY_SELECT_COLUMNS}, ra."sourceKey"
          ${ACTIVITY_FROM}
          ${whereOf([...conditions, ...keyset])}
          ORDER BY ra."occurredAt" DESC, ra."sourceKey" DESC
          LIMIT ${take}
        `);
        return rows.map((row) => ({
          ...row,
          createdAt: row.occurredAt,
          id: row.sourceKey,
        }));
      },
    };
  }

  /**
   * Distinct filter MENUS for the Reports actor/action selects (issue #718) — what to OFFER, not the
   * validation allowlist. The selects previously listed the whole user directory + every verb in
   * {@link RECENT_ACTIVITY_ACTIONS}; instead they should offer only the actors/actions that actually
   * produced an activity row. Reads the SAME `recent_activity` view + actor LEFT JOIN as
   * {@link getActivity} — no schema change, no migration.
   *
   * `actors` = the DISTINCT non-null `actorId`s with a resolved display name (system/unknown rows,
   * whose `actorId` is null, are dropped — there's nothing to filter by), ordered by name for a stable
   * menu. `actions` = the DISTINCT `action` verbs present, intersected with the allowlist (an unknown
   * verb in the view would be a data bug, not a filter option). Both run in one `$transaction` for a
   * single consistent snapshot. Gated on `logs:read` at the controller, same as the feed itself.
   */
  async getActivityFilterOptions(): Promise<RecentActivityFilterOptions> {
    const [actorRows, actionRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
        SELECT DISTINCT
          ra."actorId" AS id,
          u."firstName" || ' ' || u."lastName" AS name
        FROM "recent_activity" ra
        JOIN "users" u ON u."id" = ra."actorId"
        ORDER BY name ASC
      `),
      this.prisma.$queryRaw<{ action: string }[]>(Prisma.sql`
        SELECT DISTINCT ra."action" AS action
        FROM "recent_activity" ra
        ORDER BY action ASC
      `),
    ]);

    // Keep only verbs in the shared allowlist so the wire type holds; the view should only emit known
    // verbs, but defending here means a stray value never breaks the typed response.
    const allowed = new Set<string>(RECENT_ACTIVITY_ACTIONS);
    return {
      actors: actorRows.map((row) => ({ id: row.id, name: row.name })),
      actions: actionRows
        .map((row) => row.action)
        .filter((action): action is RecentActivityAction =>
          allowed.has(action),
        ),
    };
  }

  /**
   * Compose the OPTIONAL activity filters (issue #181) into a single parameterized `WHERE` fragment
   * shared by the page read and the count. Every value is bound via a `Prisma.sql` interpolation
   * (`${value}`) — NEVER string-concatenated — so a hostile filter value can only ever be a bind
   * parameter, not SQL (injection guard). No filter present → {@link Prisma.empty} (no WHERE clause),
   * which keeps the unfiltered behaviour byte-identical to before.
   *
   * `q` is matched case-insensitively (`ILIKE`) against the row summary and the resolved actor display
   * name; the wildcards wrap the bound value, so the user text stays a parameter (no LIKE-metachar
   * injection into the query structure). LIKE metachars in `q` are escaped + paired with `ESCAPE '\'`
   * so a literal `%`/`_`/`\` matches literally (issue #593). The `[from, to)` window is closed-open.
   */
  private buildActivityWhere(query: RecentActivityFilters): Prisma.Sql {
    return whereOf(this.activityConditions(query));
  }

  /** The filter predicates of {@link buildActivityWhere}, before they are joined into a WHERE. */
  private activityConditions(query: RecentActivityFilters): Prisma.Sql[] {
    const conditions: Prisma.Sql[] = [];

    if (query.entityType !== undefined) {
      conditions.push(Prisma.sql`ra."entityType" = ${query.entityType}`);
    }
    if (query.entityId !== undefined) {
      conditions.push(Prisma.sql`ra."entityId" = ${query.entityId}`);
    }
    if (query.actorId !== undefined) {
      // Cast the bound text to uuid so it matches the view's uuid `actorId` column.
      conditions.push(Prisma.sql`ra."actorId" = ${query.actorId}::uuid`);
    }
    if (query.action !== undefined) {
      conditions.push(Prisma.sql`ra."action" = ${query.action}`);
    }
    if (query.from !== undefined) {
      conditions.push(
        Prisma.sql`ra."occurredAt" >= ${new Date(query.from)}::timestamptz`,
      );
    }
    if (query.to !== undefined) {
      // Closed-open: `to` is exclusive, so an end-of-day boundary never double-counts.
      conditions.push(
        Prisma.sql`ra."occurredAt" < ${new Date(query.to)}::timestamptz`,
      );
    }
    if (query.q !== undefined) {
      // Escape LIKE metachars (`%`, `_`, `\`) in the user text so they match literally, then pair
      // the bound pattern with `ESCAPE '\'` (issue #593). Without this, `q="50%"` matches every row.
      const pattern = `%${escapeLikePattern(query.q)}%`;
      conditions.push(
        Prisma.sql`(ra."summary" ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE_CHAR} OR (u."firstName" || ' ' || u."lastName") ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE_CHAR})`,
      );
    }

    return conditions;
  }
}

/** `WHERE a AND b …`, or nothing when no predicate is given. */
function whereOf(conditions: Prisma.Sql[]): Prisma.Sql {
  if (conditions.length === 0) return Prisma.empty;
  return Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`;
}

/**
 * Narrow a raw view row to the {@link RecentActivityItem} wire shape (ISO timestamp; nullable fields
 * surfaced as-is). Shared by the page read and the bulk CSV export so both serialize identically.
 */
function rowToActivityItem(row: RecentActivityRow): RecentActivityItem {
  return {
    occurredAt: row.occurredAt.toISOString(),
    actorId: row.actorId,
    actorName: row.actorName,
    entityType: row.entityType,
    entityId: row.entityId,
    action: row.action,
    summary: row.summary,
    // Subject enrichment (issue #311) — surfaced straight from the view (all nullable).
    subjectName: row.subjectName,
    targetUserId: row.targetUserId,
    targetUserName: row.targetUserName,
  };
}

/**
 * Raw row shape returned by the `recent_activity` view read (the pg driver maps `timestamptz` to a JS
 * `Date`; `actorId`/`actorName` are nullable). Narrowed to the {@link RecentActivityItem} wire shape
 * (ISO timestamp) in {@link rowToActivityItem}.
 */
export interface RecentActivityRow {
  occurredAt: Date;
  actorId: string | null;
  actorName: string | null;
  entityType: RecentActivityItem['entityType'];
  entityId: string;
  action: string;
  summary: string;
  // Subject enrichment (issue #311): the affected entity's resolved name + the target user the event
  // concerns (the grant holder / assignment owner / user-history subject). All nullable — a source
  // with no subject, or a soft-deleted/unresolved relation, yields null.
  subjectName: string | null;
  targetUserId: string | null;
  targetUserName: string | null;
}

/** One exported event: the feed row plus its keyset position, `(occurredAt, sourceKey)`. */
export type ActivityExportRow = RecentActivityRow & {
  sourceKey: string;
  createdAt: Date;
  id: string;
};

/** What `GET /dashboard/activity/export` hands the export engine. */
export interface ActivityExport {
  columns: readonly ExportColumn<ActivityExportRow>[];
  count: () => Promise<number>;
  fetchBatch: (
    after: KeysetCursor | null,
    take: number,
  ) => Promise<ActivityExportRow[]>;
}
