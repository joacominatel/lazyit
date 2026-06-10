import { z } from "zod";
import { pageSchema, PageQuerySchema } from "./pagination";

/**
 * RecentActivity — the unified, cross-pillar activity feed the dashboard exposes at
 * `GET /dashboard/activity` (CEO Round 2). It normalizes the FIVE append-only activity sources into
 * one chronologically-ordered stream so the dashboard can show "what happened across the IT estate"
 * without the web stitching five lists together. Single source of truth for `api` (response typing)
 * and `web` (the data layer). See docs/02-domain/entities/recent-activity.md.
 *
 * Backed by a Postgres VIEW (`recent_activity`) that `UNION ALL`s the five sources — Prisma cannot
 * express a UNION view in PSL, so the view lives as raw SQL in a migration and the API reads it with
 * a typed `$queryRaw` (ADR-0043 / ADR-0050). The view is a derived read model, NOT a persisted entity:
 * there is no schema change to any table and nothing writes to it.
 *
 * The five sources and how they map onto a row:
 *   - AssetHistory       → entityType "asset"      · action = the lowercased event (created, …)
 *   - AssetAssignment    → entityType "asset"      · action "assigned" / "released"
 *   - AccessGrant        → entityType "application" · action "granted" / "revoked"
 *   - ConsumableMovement → entityType "consumable"  · action "stock_in" / "stock_out" / "stock_adjustment"
 *   - UserHistory        → entityType "user"        · action "created" / "updated" / "role_changed" /
 *                          "deleted" / "restored" / "password_reset_sent" (DEBT-2, issue #185)
 *
 * Date fields are ISO-8601 strings (wire shape). The list is newest-first and **offset-paginated**
 * per ADR-0030 (default page size 20).
 */

/** The pillars an activity row can come from. The web maps these to an icon + a link target. */
export const ActivityEntityTypeSchema = z.enum([
  "asset",
  "application",
  "consumable",
  // DEBT-2 (issue #185): the User entity now audits its lifecycle into the `recent_activity` view. NOTE
  // for `web`: this widens the enum, so the ENTITY_META / ENTITY_TONE exhaustive maps must add a "user"
  // case (a separate frontend change lands on the same branch).
  "user",
]);

/**
 * One normalized row of the unified activity feed. `actorId` / `actorName` are the user who caused
 * the event, resolved (lightly) from `users` — both null for system/unknown actors, a service-account
 * actor, or a deleted user whose audit FK was set null. `entityId` is the affected entity's id (a cuid
 * for asset/application/consumable, a uuid for user). `summary` is a short, human-readable, server-built
 * sentence for the feed line.
 *
 * SUBJECT enrichment (issue #311): the feed line must name WHICH entity (and, where the event is about
 * a person, WHICH user) it concerns — not just "Access revoked from a user". The view resolves these
 * from the relations that already exist on each source, so the web can build a specific headline
 * ("Access to <App> revoked from <User>") and a click-through to the affected user's detail:
 *   - `subjectName`    — the AFFECTED entity's display name (the Application / Asset / Consumable name,
 *                        or the affected user's "First Last"). null when the relation resolves to no
 *                        name (e.g. a name-less row). Pairs with `entityType` + `entityId` for the
 *                        primary click-through (already the app/asset/consumable/user detail page).
 *   - `targetUserId`   — the user the event is ABOUT (the grant holder / assignment owner / the
 *                        user-history subject), as a uuid. null for events with no person subject
 *                        (asset state changes, consumable movements). Distinct from `actorId` (who did
 *                        it) — enables a SECOND click-through to that person's detail page.
 *   - `targetUserName` — that user's display name ("First Last"), or null when there is no target user.
 *
 * Every subject field is NULLABLE: a source that carries no subject (or a soft-deleted/unresolved
 * relation) yields null, and the web falls back to the generic `summary`. This keeps the row contract
 * backward-compatible — older `summary`-only rendering still works.
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
  // The affected entity's resolved display name (app/asset/consumable/user name). null when unresolved.
  subjectName: z.string().nullable(),
  // The user the event is ABOUT (grant holder / assignment owner / user-history subject) — a uuid.
  targetUserId: z.uuid().nullable(),
  // That target user's display name ("First Last"), or null when the event has no person subject.
  targetUserName: z.string().nullable(),
});

/**
 * Paginated `GET /dashboard/activity` envelope: `{ items: RecentActivityItem[], total, limit, offset }`.
 * Offset pagination per ADR-0030. `total` is the count over the whole view.
 */
export const RecentActivityPageSchema = pageSchema(RecentActivityItemSchema);

export type ActivityEntityType = z.infer<typeof ActivityEntityTypeSchema>;
export type RecentActivityItem = z.infer<typeof RecentActivityItemSchema>;
export type RecentActivityPage = z.infer<typeof RecentActivityPageSchema>;

/* ──────────────────────────────────────────────────────────────────────────────────────────────
 * Filterable feed query (issue #181 / DEBT-1) — the optional server-side filters layered on top of
 * the ADR-0030 pagination contract. Backward-compatible: with no filter the feed behaves exactly as
 * before. The API applies these as parameterized WHERE clauses over the `recent_activity` view, and
 * the `total` reflects the SAME filtered count as the returned page.
 * ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The CLOSED set of `action` verbs a `recent_activity` row can carry — the single source of truth for
 * the `action` filter's allowlist (an unknown verb is a 400, never a silent no-match). Derived 1:1
 * from the view (`docs/02-domain/entities/recent-activity.md`):
 *   - AssetHistory (lowercased `AssetHistoryEventType`): created · status_changed · assigned ·
 *     released · location_changed · model_changed · specs_changed · deleted · restored
 *   - AssetAssignment branch: assigned · released (already covered above)
 *   - AccessGrant: granted · revoked
 *   - ConsumableMovement: stock_in · stock_out · stock_adjustment
 *   - UserHistory (lowercased `UserHistoryEventType`, DEBT-2 / issue #185): created · updated ·
 *     role_changed · deleted · restored · password_reset_sent. `created` / `deleted` / `restored` are
 *     already in the list (shared with AssetHistory); only the user-specific verbs are added below.
 * Keep this in sync with the view if a new source verb is added.
 */
export const RECENT_ACTIVITY_ACTIONS = [
  "created",
  "status_changed",
  "assigned",
  "released",
  "location_changed",
  "model_changed",
  "specs_changed",
  "deleted",
  "restored",
  "granted",
  "revoked",
  "stock_in",
  "stock_out",
  "stock_adjustment",
  // UserHistory-specific verbs (DEBT-2, issue #185). `created`/`deleted`/`restored` already appear above.
  "updated",
  "role_changed",
  "password_reset_sent",
] as const;

/** A single known activity verb. The `action` filter validates against this enum (→ 400 otherwise). */
export const RecentActivityActionSchema = z.enum(RECENT_ACTIVITY_ACTIONS);
export type RecentActivityAction = z.infer<typeof RecentActivityActionSchema>;

/** The literal `"me"` — the self-referential actor token resolved to the caller's id SERVER-SIDE. */
export const ACTIVITY_ACTOR_ME = "me";

/**
 * The `actorId` filter accepts EITHER a concrete user uuid OR the literal `"me"`. `"me"` is a
 * self-reference the SERVER resolves to the authenticated principal's id — the API never trusts a
 * client-supplied actor for "my activity"; it substitutes the JWT/shim subject. A malformed value
 * (neither a uuid nor `"me"`) is rejected (→ 400).
 */
export const RecentActivityActorFilterSchema = z.union([
  z.uuid(),
  z.literal(ACTIVITY_ACTOR_ME),
]);
export type RecentActivityActorFilter = z.infer<
  typeof RecentActivityActorFilterSchema
>;

/** Max length of the free-text `q` filter — a sane cap so a runaway ILIKE pattern can't be sent. */
export const RECENT_ACTIVITY_Q_MAX = 200;

/**
 * The OPTIONAL, additive activity filters (issue #181 / DEBT-1) as they arrive on the wire — the
 * filterable surface that composes WITH the shared pagination contract ({@link PageQuerySchema}).
 * Every field is optional, so an empty query parses to `{}` and the feed behaves exactly as before.
 * `q` is trimmed and capped here; `entityId` is trimmed to a non-empty string; `from`/`to` are
 * ISO-8601 datetimes (a closed-open `[from, to)` window over `occurredAt`); `action` is validated
 * against the closed {@link RECENT_ACTIVITY_ACTIONS} allowlist (unknown → 400). The API applies each
 * as a PARAMETERIZED WHERE clause and counts the SAME filtered set for `total`.
 */
export const RecentActivityFiltersSchema = z.object({
  // Restrict to one pillar (asset | application | consumable).
  entityType: ActivityEntityTypeSchema.optional(),
  // Restrict to one affected entity's id (exact match; pairs naturally with `entityType`).
  entityId: z.string().trim().min(1).optional(),
  // A concrete user uuid, or the literal `"me"` (resolved to the caller SERVER-SIDE, never trusted).
  actorId: RecentActivityActorFilterSchema.optional(),
  // One known activity verb; an unknown verb is rejected (→ 400) by the enum.
  action: RecentActivityActionSchema.optional(),
  // Inclusive lower bound of the `occurredAt` window (closed-open `[from, to)`).
  from: z.iso.datetime().optional(),
  // Exclusive upper bound of the `occurredAt` window (closed-open `[from, to)`).
  to: z.iso.datetime().optional(),
  // Free text matched case-insensitively against `summary` + the resolved actor name. Trimmed/capped.
  q: z.string().trim().min(1).max(RECENT_ACTIVITY_Q_MAX).optional(),
});
export type RecentActivityFilters = z.infer<typeof RecentActivityFiltersSchema>;

/**
 * The full filterable `GET /dashboard/activity` query (issue #181 / DEBT-1): the OPTIONAL activity
 * filters COMPOSED with the shared pagination contract (ADR-0030 `limit`/`offset`/`page`).
 *
 * {@link PageQuerySchema} carries a `.transform()` (it normalizes `page`/`offset` → a canonical
 * window), so this composes by INTERSECTION rather than `.extend()`: the parsed output is the
 * normalized {@link PageQuery} window AND the parsed {@link RecentActivityFilters}. Omit every filter
 * and the result is exactly the historical page query — fully backward-compatible.
 *
 *   - `entityType` — restrict to one pillar (asset | application | consumable).
 *   - `entityId`   — restrict to one affected entity's id (exact match).
 *   - `actorId`    — a user uuid, or `"me"` (resolved to the caller server-side — never trusted).
 *   - `action`     — one known verb from {@link RECENT_ACTIVITY_ACTIONS}; an unknown verb is a 400.
 *   - `from` / `to`— a closed-open `[from, to)` window over `occurredAt` (ISO-8601 datetimes).
 *   - `q`          — free text over `summary` + actor name, trimmed and capped at {@link RECENT_ACTIVITY_Q_MAX}.
 *
 * `sort`/`dir`/`deleted` are inherited from the page schema but unused by this newest-first feed.
 */
export const RecentActivityQuerySchema = z.intersection(
  PageQuerySchema,
  RecentActivityFiltersSchema,
);
export type RecentActivityQuery = z.infer<typeof RecentActivityQuerySchema>;
