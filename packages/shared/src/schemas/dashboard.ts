import { z } from "zod";
import { AssetStatusSchema } from "./asset";
import { AssetHistoryEventTypeSchema } from "./asset-history";

/**
 * DashboardSummary — the read-only aggregation the API exposes at `GET /dashboard/summary`.
 * It composes cheap counts/groupBys across the three product pillars (Inventory, Access,
 * Knowledge) plus a small recent-activity slice, so the (separately-owned) web dashboard has a
 * single typed contract to consume. Single source of truth for `api` (response typing) and `web`.
 *
 * Read-only and derived — there is NO persisted "dashboard" entity, no schema change. Every number
 * here comes from a `prisma.count()` / `groupBy()` / `findMany()` over existing tables, scoped to
 * live rows: soft-deletable models (Asset, Application, Consumable, Article) are auto-filtered to
 * `deletedAt: null` by the soft-delete extension (ADR-0032); lifecycle joins (AssetAssignment,
 * AccessGrant) are filtered explicitly on their close markers (`releasedAt` / `revokedAt`).
 *
 * `generatedAt` (ISO-8601) stamps when the snapshot was computed — these figures are a point-in-time
 * view, never a live subscription.
 */

/** Inventory pillar — assets by lifecycle status and the count of currently-held assets. */
export const DashboardAssetsSchema = z.object({
  // Total live (non-soft-deleted) assets.
  total: z.number().int().nonnegative(),
  // Count per AssetStatus. Every enum value is present (zero-filled), so the UI can render a
  // stable set of buckets without guarding for missing keys.
  byStatus: z.record(AssetStatusSchema, z.number().int().nonnegative()),
  // Distinct assets with at least one active assignment (`releasedAt = null`). An asset may hold
  // several active assignments (multi-owner); this counts the asset once.
  assigned: z.number().int().nonnegative(),
});

/** Access pillar — active grants, the soon-to-expire subset, and grants on critical apps. */
export const DashboardAccessSchema = z.object({
  // Active grants: `revokedAt = null`. `expiresAt` never affects activeness (ADR-0023).
  activeGrants: z.number().int().nonnegative(),
  // Active grants whose `expiresAt` falls within the next `expiringWithinDays` window
  // (now < expiresAt <= now + N days). Informative only — nothing auto-revokes (ADR-0023).
  expiringSoon: z.number().int().nonnegative(),
  // The look-ahead window (in days) used to compute `expiringSoon`. Echoed so the UI can label it.
  expiringWithinDays: z.number().int().positive(),
  // Active grants on applications flagged `isCritical` (production infra, finance, …).
  onCriticalApps: z.number().int().nonnegative(),
});

/** Consumables pillar slice — items at or below their reorder threshold. */
export const DashboardConsumablesSchema = z.object({
  // Total live consumables.
  total: z.number().int().nonnegative(),
  // Live consumables that declare a `minStock` and whose `currentStock <= minStock` — the
  // reorder/low-stock alert (ADR-0034). Consumables without a `minStock` are never counted.
  lowStock: z.number().int().nonnegative(),
});

/** Knowledge pillar — articles by publication state. */
export const DashboardArticlesSchema = z.object({
  total: z.number().int().nonnegative(),
  published: z.number().int().nonnegative(),
  draft: z.number().int().nonnegative(),
});

/**
 * One recent AssetHistory row, flattened for the activity feed. Mirrors the indexed fields the UI
 * needs (no relations): the event, which asset, the optional payload and actor, and when. `id` is
 * the numeric autoincrement log id.
 */
export const DashboardActivityItemSchema = z.object({
  id: z.number().int(),
  assetId: z.cuid(),
  eventType: AssetHistoryEventTypeSchema,
  payload: z.record(z.string(), z.unknown()).nullable(),
  performedById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

/** The full `GET /dashboard/summary` response. */
export const DashboardSummarySchema = z.object({
  assets: DashboardAssetsSchema,
  access: DashboardAccessSchema,
  consumables: DashboardConsumablesSchema,
  articles: DashboardArticlesSchema,
  // Latest AssetHistory rows, newest first. A small fixed-size slice (not paginated here).
  recentActivity: z.array(DashboardActivityItemSchema),
  // When this snapshot was computed (ISO-8601). The figures are point-in-time.
  generatedAt: z.iso.datetime(),
});

export type DashboardAssets = z.infer<typeof DashboardAssetsSchema>;
export type DashboardAccess = z.infer<typeof DashboardAccessSchema>;
export type DashboardConsumables = z.infer<typeof DashboardConsumablesSchema>;
export type DashboardArticles = z.infer<typeof DashboardArticlesSchema>;
export type DashboardActivityItem = z.infer<typeof DashboardActivityItemSchema>;
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;
