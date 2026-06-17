import { z } from "zod";

/**
 * Migrator import — the stateful-wizard wire shapes (ADR-0069 wave 1, #627).
 *
 * The migrator is a five-step wizard (upload → parse → map → dry-run → commit). An `ImportSession`
 * is the transient (24h-TTL) state holder; `ImportRow` holds one parsed-and-coerced source row;
 * `ImportRun` is the append-only audit ledger of a commit. These are wire shapes only — the parser,
 * resolution engine, commit worker and endpoints are LATER WAVES (ADR-0069 §10, out of scope here).
 *
 * Date fields are ISO-8601 strings (wire shape) — consistent with the rest of @lazyit/shared.
 */

/**
 * The entity an import targets. **Asset is the only member in phase 1** (ADR-0069 — the migrator is
 * proven on the pure-DB asset path before phase 2 layers on more entities). New entities are added by
 * extending this enum AND adding a descriptor to the registry (see `schemas/import/descriptor.ts`).
 */
export const ImportEntitySchema = z.enum(["asset"]);

/**
 * Lifecycle of an `ImportSession`. PENDING (created) → PARSING → PARSED (rows materialized, headers
 * known) → MAPPED (column/value/FK mappings confirmed) → DRY_RUN (plan frozen, conflicts resolved) →
 * COMMITTING → COMMITTED, or FAILED / EXPIRED (TTL swept). The state machine itself is a later wave;
 * this enum is the contract every wave agrees on.
 */
export const ImportSessionStatusSchema = z.enum([
  "PENDING",
  "PARSING",
  "PARSED",
  "MAPPED",
  "DRY_RUN",
  "COMMITTING",
  "COMMITTED",
  "FAILED",
  "EXPIRED",
]);

/**
 * Per-row lifecycle. PENDING (parsed, not yet evaluated) → COERCED (pre-pass applied) → VALID / INVALID
 * (validation outcome) → COMMITTED / FAILED / SKIPPED (commit outcome). A re-run skips `COMMITTED` rows
 * (ADR-0069 §8 keep-partial, resumable).
 */
export const ImportRowStatusSchema = z.enum([
  "PENDING",
  "COERCED",
  "VALID",
  "INVALID",
  "COMMITTED",
  "FAILED",
  "SKIPPED",
]);

/** Counts surfaced on a session / run for an at-a-glance summary (precomputed for the client). */
export const ImportCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  committed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export type ImportEntity = z.infer<typeof ImportEntitySchema>;
export type ImportSessionStatus = z.infer<typeof ImportSessionStatusSchema>;
export type ImportRowStatus = z.infer<typeof ImportRowStatusSchema>;
export type ImportCounts = z.infer<typeof ImportCountsSchema>;
