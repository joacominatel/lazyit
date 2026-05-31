import { z } from "zod";
import { pageSchema } from "./pagination";

/**
 * AccessGrant — the timestamped join recording that a User has access to an Application, over time
 * (see docs/03-decisions/0023-access-management-design.md). Append-only with a revoke marker: rows
 * are never deleted, only "closed" by setting `revokedAt`. Multi-grant: a user may hold several
 * active grants on one app at different `accessLevel`s — there is no uniqueness constraint.
 * Single source of truth for `api` (DTOs) and `web` (forms).
 * See docs/02-domain/entities/access-grant.md.
 *
 * Actor note: `grantedById` (create) and `revokedById` (revoke) come from the `X-User-Id` shim
 * (the caller header → a JWT later), never the request body ([[0022]], [[0023]]). They are absent
 * from the Create/Revoke payloads below on purpose.
 *
 * ID note: `userId` / `grantedById` / `revokedById` reference User (`uuid`, @db.Uuid) while
 * `applicationId` references Application (`cuid`). See docs/03-decisions/0005-id-strategy.md.
 */

/** The full AccessGrant as returned by the API (wire shape; dates are ISO-8601 strings). */
export const AccessGrantSchema = z.object({
  id: z.cuid(),
  userId: z.uuid(),
  applicationId: z.cuid(),
  // Free-form, app-defined (e.g. "admin", "developer", "viewer"). null when unspecified.
  accessLevel: z.string().nullable(),
  grantedAt: z.iso.datetime(),
  // null while active; set when revoked. Lifecycle field, not a soft delete (ADR-0006).
  revokedAt: z.iso.datetime().nullable(),
  // Informative only — no scheduler auto-revokes at expiry (ADR-0023). null => no expiry.
  expiresAt: z.iso.datetime().nullable(),
  // Optional audit FKs — who granted / revoked. null when the system acted or it's unknown.
  grantedById: z.uuid().nullable(),
  revokedById: z.uuid().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * Payload to open a grant. `userId` + `applicationId` are required; both must reference live
 * (non-soft-deleted) rows (the service enforces this → 400). `grantedAt` is optional and defaults
 * to `now()` in the DB — pass it only to backdate an imported/historical record. `grantedById` is
 * NOT here: it comes from the `X-User-Id` header ([[0023]]).
 */
export const CreateAccessGrantSchema = z.strictObject({
  userId: z.uuid(),
  applicationId: z.cuid(),
  accessLevel: z.string().trim().min(1).max(100).optional(),
  expiresAt: z.iso.datetime().optional(),
  grantedAt: z.iso.datetime().optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});

/**
 * Payload to revoke an active grant (`PATCH /access-grants/:id/revoke`). Sets `revokedAt = now()`.
 * Only `notes` is accepted; the actor (`revokedById`) comes from the `X-User-Id` header ([[0023]]).
 */
export const RevokeAccessGrantSchema = z.strictObject({
  notes: z.string().trim().min(1).max(2000).optional(),
});

/**
 * Payload for the dedicated notes endpoint (`PATCH /access-grants/:id/notes`). `null` clears the
 * note. Identity (user, application, grantedAt) is immutable; this is a metadata edit (no actor).
 */
export const UpdateAccessGrantNotesSchema = z.strictObject({
  notes: z.string().trim().min(1).max(2000).nullable(),
});

/**
 * Payload to change the expiry (`PATCH /access-grants/:id/expiry`) — extend, shorten, or clear it.
 * `null` removes the expiry (makes the grant permanent). Metadata edit, no actor. Note: `expiresAt`
 * is informative; changing it never revokes or reactivates the grant (ADR-0023).
 */
export const UpdateAccessGrantExpirySchema = z.strictObject({
  expiresAt: z.iso.datetime().nullable(),
});

/**
 * The paginated `GET /access-grants` response envelope (ADR-0030): a page of grants plus `total`
 * and the effective `limit`/`offset`. The nested `/users/:id/access-grants` and
 * `/applications/:id/access-grants` lists stay unpaginated arrays (already user/app-scoped).
 */
export const AccessGrantPageSchema = pageSchema(AccessGrantSchema);

export type AccessGrant = z.infer<typeof AccessGrantSchema>;
export type AccessGrantPage = z.infer<typeof AccessGrantPageSchema>;
export type CreateAccessGrant = z.infer<typeof CreateAccessGrantSchema>;
export type RevokeAccessGrant = z.infer<typeof RevokeAccessGrantSchema>;
export type UpdateAccessGrantNotes = z.infer<
  typeof UpdateAccessGrantNotesSchema
>;
export type UpdateAccessGrantExpiry = z.infer<
  typeof UpdateAccessGrantExpirySchema
>;
