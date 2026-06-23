import { z } from "zod";
import { RoleSchema, UserSchema } from "./user";
import { pageSchema } from "./pagination";

/**
 * The `GET /users` list ITEM (ADR-0030 envelope, ADR-0058 fields, issue #386). It is the full {@link
 * UserSchema} — id/email/role/status, the resolved `manager` descriptor, `legajo` and `username` (all
 * already on UserSchema, ADR-0058) — PLUS two derived, list-only activity counts:
 *
 *   - `assetsInPossession` — how many assets the user currently holds: active AssetAssignments
 *     (`releasedAt IS NULL`, ADR-0019). See docs/02-domain/entities/asset-assignment.md.
 *   - `appAccesses` — how many application grants the user currently holds: active AccessGrants
 *     (`revokedAt IS NULL`, ADR-0023). See docs/02-domain/entities/access-grant.md.
 *
 * Both are OPTIONAL + additive: the single-user reads (`GET /users/:id`, `/me`, create/update) return
 * the bare {@link UserSchema} and DON'T carry them, so existing consumers don't break. They are batched
 * per page server-side (one `groupBy` each over the page's user ids — never N+1), so they ride only on
 * the LIST row. The frontend column picker (the #386 follow-up) reads them by these names. `0` means
 * "none"; an ABSENT field means "this response doesn't compute them" (a single-user read).
 */
export const UserListItemSchema = UserSchema.extend({
  assetsInPossession: z.number().int().nonnegative().optional(),
  appAccesses: z.number().int().nonnegative().optional(),
});
export type UserListItem = z.infer<typeof UserListItemSchema>;

/**
 * Paginated `GET /users` envelope (ADR-0030). The User row is small (no blobs), so the list item is the
 * full {@link UserSchema} extended with the optional #386 activity counts ({@link UserListItemSchema}).
 * Migrated off the raw-array contract so `q` search and sort run server-side and authoritatively (no
 * client-side filtering past the backend window, which silently missed matches once a team grows past
 * one page).
 */
export const UserListPageSchema = pageSchema(UserListItemSchema);

export type UserListPage = z.infer<typeof UserListPageSchema>;

/**
 * Per-role LIVE user counts (`GET /users/role-counts`, issue #693). One count per RBAC {@link
 * RoleSchema} role over the active (not soft-deleted) directory — the authoritative numbers the
 * Settings → Roles cards show, computed server-side by a single Prisma `groupBy` so they stay
 * correct at any team size (the old client-side count truncated past the list window). A role with
 * no holders is `0`, never absent — the keys are exhaustive. The cards deep-link into the Users list
 * (`/users?role=…`) for the actual membership browser; this endpoint only supplies the headline count.
 */
export const RoleCountsSchema = z.object(
  Object.fromEntries(
    RoleSchema.options.map((role) => [role, z.number().int().nonnegative()]),
  ) as Record<(typeof RoleSchema.options)[number], z.ZodNumber>,
);
export type RoleCounts = z.infer<typeof RoleCountsSchema>;
