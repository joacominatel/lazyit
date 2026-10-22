import { z } from "zod";
import { optionalText } from "./primitives";

/**
 * AccessGrant — the timestamped join recording that a User has access to an Application, over time
 * (see docs/03-decisions/0023-access-management-design.md). Append-only with a revoke marker: rows
 * are never deleted, only "closed" by setting `revokedAt`. Multi-grant: a user may hold several
 * active grants on one app at different `accessLevel`s — there is no uniqueness constraint.
 * Single source of truth for `api` (DTOs) and `web` (forms).
 * See docs/02-domain/entities/access-grant.md.
 *
 * Actor note: the API records the actor from the authenticated principal, **never** from the
 * request body — a human in `grantedById` / `revokedById`, a service account in `grantedBySaId` /
 * `revokedBySaId` (ADR-0048). They are absent from the Create/Revoke payloads below on purpose.
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
  // A periodic sweeper revokes the grant once this passes, through the normal revoke path (ADR-0023,
  // amended). null => no expiry.
  expiresAt: z.iso.datetime().nullable(),
  // Optional audit FKs — who granted / revoked. null when the system acted or it's unknown.
  grantedById: z.uuid().nullable(),
  revokedById: z.uuid().nullable(),
  // The service-account actor, set instead of the human one (ADR-0048). `.nullish()`: added later.
  grantedBySaId: z.cuid().nullish(),
  revokedBySaId: z.cuid().nullish(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * The COARSE provisioning status a requester sees on their OWN grant (#1700, CEO decision Q2 on
 * #1344). Derived on read — no column — from the latest `ACCESS_GRANTED` workflow run linked to the
 * grant; the exact mapping lives in docs/02-domain/entities/access-grant.md ("Provisioning status").
 *
 *   - `NONE`          — no automation: no provisioning run was ever linked to the grant.
 *   - `IN_PROGRESS`   — the run is queued or working.
 *   - `DONE`          — the run completed.
 *   - `WAITING_ON_IT` — the run is waiting on a manual step, or it failed: IT has to act.
 *
 * Deliberately carries NO workflow name, step or error: run history stays admin-only
 * (`workflow:read`). Only the self-scope `/mine` reads return it.
 */
export const GRANT_PROVISIONING_STATUSES = [
  "NONE",
  "IN_PROGRESS",
  "DONE",
  "WAITING_ON_IT",
] as const;
export const GrantProvisioningSchema = z.enum(GRANT_PROVISIONING_STATUSES);
export type GrantProvisioning = z.infer<typeof GrantProvisioningSchema>;

/**
 * A grant as the self-scope `GET /access-grants/mine` returns it: the full {@link AccessGrantSchema}
 * plus the coarse `provisioning` status. Tolerant on read: absent from an API that predates it, and a
 * value a newer API adds reads as absent (`.catch`) instead of failing the whole list.
 */
export const MyAccessGrantSchema = AccessGrantSchema.extend({
  provisioning: GrantProvisioningSchema.optional().catch(undefined),
});
export type MyAccessGrant = z.infer<typeof MyAccessGrantSchema>;

/**
 * Payload to open a grant. `userId` + `applicationId` are required; both must reference live
 * (non-soft-deleted) rows (the service enforces this → 400). `grantedAt` is optional and defaults
 * to `now()` in the DB — pass it only to backdate an imported/historical record. The actor is NOT
 * here: it comes from the authenticated principal ([[0023]]). An `expiresAt` already in the past is
 * revoked by the next expiry sweep.
 */
export const CreateAccessGrantSchema = z
  .strictObject({
    userId: z.uuid(),
    applicationId: z.cuid(),
    accessLevel: z.string().trim().min(1).max(100).optional(),
    expiresAt: z.iso.datetime().optional(),
    grantedAt: z.iso.datetime().optional(),
    notes: optionalText(2000),
  })
  // Cross-field: a grant can't expire before it starts. Only checked when BOTH are supplied — an
  // omitted grantedAt defaults to now() in the DB, so there's nothing to compare against here.
  // ISO-8601 strings sort chronologically as strings, but parse to Date to be timezone-correct.
  .refine(
    (data) =>
      data.expiresAt === undefined ||
      data.grantedAt === undefined ||
      new Date(data.expiresAt).getTime() >= new Date(data.grantedAt).getTime(),
    {
      error: "expiresAt must be on or after grantedAt",
      path: ["expiresAt"],
    },
  );

/**
 * Payload to revoke an active grant (`PATCH /access-grants/:id/revoke`). Sets `revokedAt = now()`.
 * Only `notes` is accepted; the actor comes from the authenticated principal ([[0023]]).
 */
export const RevokeAccessGrantSchema = z.strictObject({
  notes: optionalText(2000),
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
 * `null` removes the expiry (makes the grant permanent). Metadata edit, no actor. The edit itself
 * revokes nothing, but an `expiresAt` in the past is revoked by the next expiry sweep (ADR-0023,
 * amended); a revoked grant is never reactivated.
 */
export const UpdateAccessGrantExpirySchema = z.strictObject({
  expiresAt: z.iso.datetime().nullable(),
});

export type AccessGrant = z.infer<typeof AccessGrantSchema>;
export type CreateAccessGrant = z.infer<typeof CreateAccessGrantSchema>;
export type RevokeAccessGrant = z.infer<typeof RevokeAccessGrantSchema>;
export type UpdateAccessGrantNotes = z.infer<
  typeof UpdateAccessGrantNotesSchema
>;
export type UpdateAccessGrantExpiry = z.infer<
  typeof UpdateAccessGrantExpirySchema
>;
