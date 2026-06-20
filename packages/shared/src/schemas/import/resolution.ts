import { z } from "zod";

/**
 * Migrator import — the persisted resolution plan (ADR-0069 §6, #627).
 *
 * After the dry-run, every DISTINCT conflict `(entity, field, normalizedValue)` is resolved ONCE by
 * the operator into one of four outcomes; the set is frozen into an append-only plan that the commit
 * worker replays (immutable once commit starts). Wire shapes only — the conflict-detection and replay
 * logic are later waves.
 */

/**
 * The four conflict outcomes (ADR-0069 §6 — never wipe, additive only):
 * - `match`   — link to an existing LIVE row.
 * - `restore` — un-soft-delete a ghost (soft-deleted) match and link to it.
 * - `create`  — make a new row (only valid when no live match exists).
 * - `skip`    — do not resolve; the operator separately chooses to drop the link or skip the rows.
 */
export const ConflictOutcomeSchema = z.enum(["match", "restore", "create", "skip"]);

/**
 * One resolved conflict, keyed by its distinct `(entity, field, normalizedValue)`. `targetId` points at
 * the chosen existing row for `match`/`restore`; it is null for `create`/`skip`. Resolved once per
 * normalized value, applied to every row that shares it.
 */
export const ConflictResolutionSchema = z.object({
  /** The referenced entity this conflict is about (e.g. `category`, `model`, `location`). */
  entity: z.string().min(1),
  /** The field/natural-key dimension (e.g. `name`, `sku`). */
  field: z.string().min(1),
  /** The normalized natural-key value (trim-only — see `normalizeMatchKey`). */
  normalizedValue: z.string(),
  outcome: ConflictOutcomeSchema,
  /** Existing row id for match/restore; null for create/skip. */
  targetId: z.string().nullable().default(null),
});

/** The full resolution plan persisted on an `ImportSession` after the dry-run (immutable at commit). */
export const ImportResolutionPlanSchema = z.object({
  conflicts: z.array(ConflictResolutionSchema),
});

export type ConflictOutcome = z.infer<typeof ConflictOutcomeSchema>;
export type ConflictResolution = z.infer<typeof ConflictResolutionSchema>;
export type ImportResolutionPlan = z.infer<typeof ImportResolutionPlanSchema>;
