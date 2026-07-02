import { z } from "zod";
import { optionalText } from "./primitives";

/**
 * AccessRequest — a user's self-service request to be GRANTED access to an Application, moving through
 * an approval lifecycle (see docs/03-decisions/0085-access-request-flow.md). It closes the deferral of
 * [[0023-access-management-design]] (which shipped Applications + AccessGrant with grants created
 * DIRECTLY and the approval workflow explicitly deferred). Single source of truth for `api` (DTOs) and
 * `web` (forms). See docs/02-domain/entities/access-request.md.
 *
 * Lifecycle, not soft-delete: a request is `PENDING` until an approver decides it, then `APPROVED` or
 * `DENIED`. Rows are NEVER deleted — the decision closes them (the append-only-family posture, ADR-0006:
 * `createdAt` only, no `updatedAt`/`deletedAt`; `decidedAt` stamps the one allowed transition). Approval
 * produces an AccessGrant (`grantId`) through the EXISTING grant write path, so provisioning + audit
 * attribution keep working unchanged (ADR-0054 fires AFTER the grant commits).
 *
 * One OPEN request per (requester, application): a partial unique index `WHERE status = 'PENDING'`
 * (raw SQL in the migration, the [[0019]]/[[0041]] pattern) rejects a second create with 409. A decided
 * request frees the pair so the user can request again later.
 *
 * ID note: `id` / `grantId` are `cuid` (AccessRequest, AccessGrant); `requesterId` / `decidedById`
 * reference User (`uuid`, @db.Uuid); `applicationId` references Application (`cuid`). See
 * docs/03-decisions/0005-id-strategy.md.
 */

/** The lifecycle status of a request. `PENDING` → decided into `APPROVED` (grant created) or `DENIED`. */
export const ACCESS_REQUEST_STATUSES = [
  "PENDING",
  "APPROVED",
  "DENIED",
] as const;
export const AccessRequestStatusSchema = z.enum(ACCESS_REQUEST_STATUSES);
export type AccessRequestStatus = z.infer<typeof AccessRequestStatusSchema>;

/** The full AccessRequest as returned by the API (wire shape; dates are ISO-8601 strings). */
export const AccessRequestSchema = z.object({
  id: z.cuid(),
  requesterId: z.uuid(),
  applicationId: z.cuid(),
  // The access level the requester asked for — free-form, app-defined (e.g. "admin", "developer").
  // null when unspecified. On approval it becomes the created grant's `accessLevel` verbatim.
  accessLevel: z.string().nullable(),
  // Why the requester needs access — optional free text captured at request time.
  justification: z.string().nullable(),
  status: AccessRequestStatusSchema,
  // Who decided (approved/denied). null while PENDING or when the decider was later hard-deleted
  // (SetNull). A decision is HUMAN-attributed — there is no service-account decider column.
  decidedById: z.uuid().nullable(),
  // When the decision was made. null while PENDING. Doubles as the "closed at" timestamp.
  decidedAt: z.iso.datetime().nullable(),
  // The reason a request was DENIED (required at deny time). null while PENDING or when APPROVED.
  deniedReason: z.string().nullable(),
  // The AccessGrant produced on approval. null while PENDING or when DENIED. SetNull if the grant is
  // ever hard-deleted (grants are append-only, so this is only a safety net).
  grantId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type AccessRequest = z.infer<typeof AccessRequestSchema>;

/**
 * Payload to raise a request (`POST /access-requests`). `applicationId` is required and must reference
 * a live application (the service enforces → 400). `requesterId` is NOT here — the requester is the
 * authenticated caller (a human; ADR-0085). `accessLevel` mirrors the grant's constraint (free-form,
 * 1–100 chars) so the approved grant inherits exactly what was asked for. A second PENDING request for
 * the same (requester, application) is rejected with 409.
 */
export const CreateAccessRequestSchema = z.strictObject({
  applicationId: z.cuid(),
  accessLevel: z.string().trim().min(1).max(100).optional(),
  justification: optionalText(2000),
});
export type CreateAccessRequest = z.infer<typeof CreateAccessRequestSchema>;

/**
 * Payload to DENY a request (`POST /access-requests/:id/deny`). A reason is REQUIRED — a denial must
 * always record why (stored in `deniedReason`). Approve carries no body (the created grant inherits the
 * request's `accessLevel`).
 */
export const DenyAccessRequestSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000),
});
export type DenyAccessRequest = z.infer<typeof DenyAccessRequestSchema>;
