import { z } from "zod";
import { pageSchema } from "./pagination";

/**
 * RecentActivity — the unified, cross-pillar activity feed the dashboard exposes at
 * `GET /dashboard/activity` (CEO Round 2). It normalizes the four append-only activity sources into
 * one chronologically-ordered stream so the dashboard can show "what happened across the IT estate"
 * without the web stitching four lists together. Single source of truth for `api` (response typing)
 * and `web` (the data layer). See docs/02-domain/entities/recent-activity.md.
 *
 * Backed by a Postgres VIEW (`recent_activity`) that `UNION ALL`s the four sources — Prisma cannot
 * express a UNION view in PSL, so the view lives as raw SQL in a migration and the API reads it with
 * a typed `$queryRaw` (ADR-0043). The view is a derived read model, NOT a persisted entity: there is
 * no schema change to any table and nothing writes to it.
 *
 * The four sources and how they map onto a row:
 *   - AssetHistory       → entityType "asset"      · action = the lowercased event (created, …)
 *   - AssetAssignment    → entityType "asset"      · action "assigned" / "released"
 *   - AccessGrant        → entityType "application" · action "granted" / "revoked"
 *   - ConsumableMovement → entityType "consumable"  · action "stock_in" / "stock_out" / "stock_adjustment"
 *
 * Date fields are ISO-8601 strings (wire shape). The list is newest-first and **offset-paginated**
 * per ADR-0030 (default page size 20).
 */

/** The pillars an activity row can come from. The web maps these to an icon + a link target. */
export const ActivityEntityTypeSchema = z.enum([
  "asset",
  "application",
  "consumable",
]);

/**
 * One normalized row of the unified activity feed. `actorId` / `actorName` are the user who caused
 * the event, resolved (lightly) from `users` — both null for system/unknown actors or a deleted user
 * whose audit FK was set null. `entityId` is the affected entity's id (a cuid for asset/application/
 * consumable). `summary` is a short, human-readable, server-built sentence for the feed line.
 */
export const RecentActivityItemSchema = z.object({
  // ISO-8601 timestamp the event occurred at. The feed is ordered by this, newest first.
  occurredAt: z.iso.datetime(),
  // The acting user's id (uuid), or null for system/unknown / a deleted actor.
  actorId: z.uuid().nullable(),
  // The acting user's display name ("First Last"), or null when there is no resolvable actor.
  actorName: z.string().nullable(),
  // Which pillar the affected entity belongs to.
  entityType: ActivityEntityTypeSchema,
  // The affected entity's id (asset / application / consumable cuid).
  entityId: z.string(),
  // A stable, machine-friendly verb for the event (e.g. "created", "assigned", "stock_in").
  action: z.string(),
  // A short human-readable description of the event, built server-side.
  summary: z.string(),
});

/**
 * Paginated `GET /dashboard/activity` envelope: `{ items: RecentActivityItem[], total, limit, offset }`.
 * Offset pagination per ADR-0030. `total` is the count over the whole view.
 */
export const RecentActivityPageSchema = pageSchema(RecentActivityItemSchema);

export type ActivityEntityType = z.infer<typeof ActivityEntityTypeSchema>;
export type RecentActivityItem = z.infer<typeof RecentActivityItemSchema>;
export type RecentActivityPage = z.infer<typeof RecentActivityPageSchema>;
