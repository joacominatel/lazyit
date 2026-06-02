import { z } from "zod";
import { AssetStatusSchema } from "./asset";

/**
 * Batch (bulk) mutation contracts for multi-select actions (ADR-0030 amendment, 2026-06-01). Each
 * batch is ADMIN-gated and runs in ONE transaction, but auditability stays PER-ENTITY: one
 * AssetHistory / per-grant write per item, never one entry for the whole batch — so per-entity
 * history is preserved exactly as a single-item action would record it (a batch is a convenience, not
 * a different audit event). The response reports the per-id outcome so a partial set can be surfaced.
 *
 * `ids` is a non-empty, de-duplicated list bounded by {@link MAX_BATCH_IDS} so one request can't be
 * an unbounded write (mirrors the page hard-cap rationale of ADR-0030). Single source of truth for
 * api and web.
 */

/** Hard maximum number of ids in a single batch request (bounds the per-request write fan-out). */
export const MAX_BATCH_IDS = 200;

/** A non-empty, de-duplicated, bounded list of cuid ids — the target set of an asset batch. */
const CuidBatchIdsSchema = z
  .array(z.cuid())
  .min(1)
  .max(MAX_BATCH_IDS)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "ids must be unique (no duplicates)",
  });

/** A non-empty, de-duplicated, bounded list of cuid ids — for the access-grant batch revoke. */
const CuidBatchIdsSchemaGrants = CuidBatchIdsSchema;

/** Bulk soft-delete / bulk restore payload: just the target ids. */
export const BatchIdsSchema = z.strictObject({
  ids: CuidBatchIdsSchema,
});

/** Bulk asset status-change payload: the target ids plus the new status to set on each. */
export const BatchAssetStatusSchema = z.strictObject({
  ids: CuidBatchIdsSchema,
  status: AssetStatusSchema,
});

/** Bulk access-grant revoke payload: the grant ids plus an optional shared revoke note. */
export const BatchRevokeGrantsSchema = z.strictObject({
  ids: CuidBatchIdsSchemaGrants,
  notes: z.string().trim().min(1).max(2000).nullish(),
});

/**
 * The per-item outcome of a batch. `succeeded` are the ids that were mutated; `skipped` are ids that
 * matched nothing actionable (already in the target state, already deleted/revoked, or not found) —
 * paired with a short reason so the UI can explain a partial result. The whole batch still commits
 * atomically; "skipped" is a no-op within the transaction, never a rollback.
 */
export const BatchResultSchema = z.object({
  // Total ids requested (after de-dup at the edge).
  requested: z.number().int().min(0),
  // Ids actually mutated by this batch.
  succeeded: z.array(z.cuid()),
  // Ids that were a no-op, each with a reason ("not_found" | "already_in_state").
  skipped: z.array(
    z.object({
      id: z.cuid(),
      reason: z.string(),
    }),
  ),
});

export type BatchIds = z.infer<typeof BatchIdsSchema>;
export type BatchAssetStatus = z.infer<typeof BatchAssetStatusSchema>;
export type BatchRevokeGrants = z.infer<typeof BatchRevokeGrantsSchema>;
export type BatchResult = z.infer<typeof BatchResultSchema>;
