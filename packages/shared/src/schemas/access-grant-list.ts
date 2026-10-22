import { z } from "zod";
import { AccessGrantSchema } from "./access-grant";
import { pageSchema } from "./pagination";

/**
 * Paginated `GET /access-grants` envelope: `{ items: AccessGrant[], total, limit, offset }`. The
 * grant rows are already lean (no relations are inlined on this list), so the item is the full
 * {@link AccessGrantSchema} — only the page envelope is added.
 *
 * `GET /access-grants` is the most sensitive unbounded list (it can dump every user↔application
 * grant), so it is paginated first per ADR-0030. The nested
 * `GET /users/:id/access-grants` and `GET /applications/:id/access-grants` lists are inherently
 * scoped and stay unpaginated for now.
 */
export const AccessGrantListPageSchema = pageSchema(AccessGrantSchema);

export type AccessGrantListPage = z.infer<typeof AccessGrantListPageSchema>;

/**
 * The "expiring soon" look-ahead for an access grant, in days (#1660). The same 30 the dashboard's
 * `expiringWithinDays` defaults to, so "expiring" means one thing on the dashboard tile, the person page
 * and an application's Access tab.
 */
export const GRANT_EXPIRING_WITHIN_DAYS = 30;

/**
 * The status view of an application's grant list (`GET /applications/:id/access-grants/page`, #1660):
 *
 *   - `active`   — not revoked (`revokedAt IS NULL`), whatever the expiry.
 *   - `expiring` — not revoked and `expiresAt <= now + GRANT_EXPIRING_WITHIN_DAYS`. It INCLUDES grants
 *                  already past their expiry: they stay active until the expiry sweep revokes them.
 *   - `revoked`  — revoked (`revokedAt IS NOT NULL`).
 *   - `all`      — every grant.
 */
export const ApplicationGrantStatusSchema = z.enum([
  "active",
  "expiring",
  "revoked",
  "all",
]);
export type ApplicationGrantStatus = z.infer<typeof ApplicationGrantStatusSchema>;

/**
 * The headline numbers of an application's grants (`GET /applications/:id/access-grants/summary`,
 * #1660) — what the Access tab's status switch, level picker and "needs attention" items show, without
 * reading every grant. Computed over ALL the application's grants, independent of any list filter.
 *
 *   - `counts` — one per {@link ApplicationGrantStatusSchema} view, plus `expired` (not revoked and
 *     `expiresAt <= now`, a subset of `expiring`).
 *   - `levels` — each distinct `accessLevel` with its grant count (active and revoked), alphabetical,
 *     `null` (no level) last.
 *   - `offboardedHolders` — distinct people who still hold an active grant here but have been
 *     offboarded (soft-deleted); `null` when the caller lacks `user:read`, because it tells who left.
 *   - `expiringWithinDays` — the window `expiring` used ({@link GRANT_EXPIRING_WITHIN_DAYS}).
 */
export const ApplicationGrantSummarySchema = z.object({
  counts: z.object({
    active: z.number().int().nonnegative(),
    expiring: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
    all: z.number().int().nonnegative(),
  }),
  levels: z.array(
    z.object({
      accessLevel: z.string().nullable(),
      count: z.number().int().nonnegative(),
    }),
  ),
  offboardedHolders: z.number().int().nonnegative().nullable(),
  expiringWithinDays: z.number().int().positive(),
});
export type ApplicationGrantSummary = z.infer<typeof ApplicationGrantSummarySchema>;
