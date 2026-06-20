import { z } from "zod";
import { ImportCountsSchema } from "./session";

/**
 * Migrator import — the row-index-keyed result schema (ADR-0069 §8/§9, #627).
 *
 * New imported rows have NO id yet, so neither `BatchResultSchema` (keys by cuid) nor `ZipImportResult`
 * (keys by path) fits — outcomes are keyed by the source ROW INDEX (0-based, stable across dry-run and
 * commit). Used both for the dry-run preview (validate/coerce/conflict outcomes, writing nothing) and
 * the commit report (per-row P2002/P2003 keep-partial outcomes).
 */

/**
 * A single field-level validation failure (the failure arm). `field` is the target create-schema key
 * (or null for a whole-row error); `message` is the human-readable reason (PII-free in logs, ADR-0069 §11).
 */
export const RowFieldErrorSchema = z.object({
  field: z.string().nullable().default(null),
  message: z.string(),
});

/**
 * The outcome of a single source row, keyed by `rowIndex`:
 * - `valid`     — coerced + validated, ready to commit (dry-run).
 * - `invalid`   — failed coercion/validation; see `errors` (field-level).
 * - `committed` — written (commit).
 * - `failed`    — a write-time failure, e.g. a unique value taken since preview (P2002/P2003).
 * - `skipped`   — intentionally not imported (a skip-cascade decision).
 * `entityId` is the created/matched row id once known (commit), else null.
 */
export const RowResultSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  status: z.enum(["valid", "invalid", "committed", "failed", "skipped"]),
  /** Field-level failures for `invalid`/`failed`; empty otherwise. */
  errors: z.array(RowFieldErrorSchema).default([]),
  /** The resulting entity id once written/matched (commit); null in the dry-run or on failure. */
  entityId: z.string().nullable().default(null),
});

/** The full row-keyed result of a dry-run or a commit, plus the precomputed counts. */
export const ImportRowResultSchema = z.object({
  counts: ImportCountsSchema,
  rows: z.array(RowResultSchema),
});

export type RowFieldError = z.infer<typeof RowFieldErrorSchema>;
export type RowResult = z.infer<typeof RowResultSchema>;
export type ImportRowResult = z.infer<typeof ImportRowResultSchema>;
