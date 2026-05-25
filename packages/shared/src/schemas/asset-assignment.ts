import { z } from "zod";

/**
 * AssetAssignment — the timestamped join recording who owns an asset over time
 * (asset-centric ownership; see docs/03-decisions/0004-asset-centric-design.md). It is
 * append-only with a release marker: rows are never deleted, only "closed" by setting
 * `releasedAt`. Single source of truth for `api` (DTOs) and `web` (forms).
 * See docs/02-domain/entities/asset-assignment.md and
 * docs/03-decisions/0019-asset-assignment-integrity.md.
 *
 * ID note: `assetId` references Asset (`cuid`), while `userId` / `assignedById` /
 * `releasedById` reference User (`uuid`, @db.Uuid). See docs/03-decisions/0005-id-strategy.md.
 *
 * Actor note: `assignedById` / `releasedById` are recorded by the API from the optional
 * `X-User-Id` shim (the caller → a JWT later), **never** from the request body — so the
 * create/release payloads below do not carry them. See docs/03-decisions/0024-asset-assignment-actor-shim.md.
 */

/**
 * The full AssetAssignment as returned by the API. Date fields are ISO-8601 strings (wire
 * shape) — see docs/03-decisions/0018-api-documentation-swagger.md.
 */
export const AssetAssignmentSchema = z.object({
  id: z.cuid(),
  assetId: z.cuid(),
  userId: z.uuid(),
  assignedAt: z.iso.datetime(),
  // null while active; set when released. Lifecycle field, not a soft delete (ADR-0006).
  releasedAt: z.iso.datetime().nullable(),
  // Optional audit FKs — who assigned / released. null when the system acted or it's unknown.
  assignedById: z.uuid().nullable(),
  releasedById: z.uuid().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * Payload to open an assignment. `assetId` + `userId` are required. `assignedAt` is optional
 * and defaults to `now()` in the DB — pass it only to backdate an imported/historical record.
 * A duplicate *active* `(assetId, userId)` pair is rejected (409) by the partial unique index.
 * The actor (`assignedById`) is NOT in the body — it comes from the `X-User-Id` shim.
 */
export const CreateAssetAssignmentSchema = z.strictObject({
  assetId: z.cuid(),
  userId: z.uuid(),
  assignedAt: z.iso.datetime().optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});

/**
 * Payload to release an active assignment (`PATCH /asset-assignments/:id/release`). Sets
 * `releasedAt = now()`. Only `notes` (optional) — if given it replaces the note. The actor
 * (`releasedById`) is NOT in the body — it comes from the `X-User-Id` shim.
 */
export const ReleaseAssetAssignmentSchema = z.strictObject({
  notes: z.string().trim().min(1).max(2000).optional(),
});

/**
 * Payload for the dedicated notes endpoint (`PATCH /asset-assignments/:id/notes`). `null`
 * clears the note. The rest of an assignment (asset, user, assignedAt) is immutable.
 */
export const UpdateAssetAssignmentNotesSchema = z.strictObject({
  notes: z.string().trim().min(1).max(2000).nullable(),
});

export type AssetAssignment = z.infer<typeof AssetAssignmentSchema>;
export type CreateAssetAssignment = z.infer<typeof CreateAssetAssignmentSchema>;
export type ReleaseAssetAssignment = z.infer<typeof ReleaseAssetAssignmentSchema>;
export type UpdateAssetAssignmentNotes = z.infer<
  typeof UpdateAssetAssignmentNotesSchema
>;
