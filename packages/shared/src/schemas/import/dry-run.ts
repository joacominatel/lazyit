import { z } from "zod";
import { ConflictOutcomeSchema } from "./resolution";
import { ImportRowResultSchema } from "./result";

/**
 * Migrator import — the dry-run REPORT wire shape (ADR-0069 §5/§6/§7, #631 wave 3).
 *
 * The dry-run engine validates + coerces + resolves + conflict-detects every row **writing zero domain
 * rows**, and returns this report for the operator to resolve. It carries: the per-row outcomes (the
 * wave-1 row-result schema), the DEDUPED conflict set (each distinct `(entity, field, normalizedValue)`
 * once — with counts, sample rows, candidate matches and the dependent-row blast radius), and the
 * per-row asset-tag classification (decision only — no allocation happens until commit).
 */

/**
 * One existing-row candidate for a reference conflict (ADR-0069 §5). `live` distinguishes a LIVE match
 * (→ `match` outcome) from a soft-deleted ghost (→ `restore`). For an `AssetModel` matched on
 * `(manufacturer, name)` the label carries both so the operator can disambiguate (names aren't unique,
 * so we NEVER auto-pick); `categoryName` surfaces the category resolved THROUGH the model (the asset has
 * no direct category — descriptor note). Pure data — no Prisma types leak across the contract.
 */
export const ConflictCandidateSchema = z.object({
  id: z.string(),
  label: z.string(),
  live: z.boolean(),
  /** The category resolved via the model (AssetModel only); null for other entities / no category. */
  categoryName: z.string().nullable().default(null),
});

/**
 * A distinct reference conflict, keyed by `(entity, field, normalizedValue)` and surfaced ONCE for the
 * whole import (resolved once, applied to every row that shares the value — ADR-0069 §6). `suggested` is
 * the four-outcome classification the engine computed (match when exactly one LIVE candidate; restore
 * when only ghosts; create when none) — but on AMBIGUITY (N candidates) the engine surfaces them and
 * does not pre-pick. `rowCount` + `sampleRowIndexes` are the blast radius (how many rows, and a few
 * examples) so the operator sees the impact of each decision.
 */
export const ReferenceConflictSchema = z.object({
  entity: z.string(),
  field: z.string(),
  normalizedValue: z.string(),
  /** How many rows reference this distinct value (the blast radius). */
  rowCount: z.number().int().nonnegative(),
  /** A bounded sample of the affected 0-based row indexes (for the UI preview). */
  sampleRowIndexes: z.array(z.number().int().nonnegative()),
  /** Existing matches (live + ghost) the operator may link to; empty ⇒ create-new is the only path. */
  candidates: z.array(ConflictCandidateSchema),
  /** The engine's suggested outcome; never auto-applied when `candidates.length > 1` (ambiguous). */
  suggested: ConflictOutcomeSchema,
  /** True when more than one candidate matched — the operator MUST choose (no auto-pick). */
  ambiguous: z.boolean(),
});

/**
 * The per-row asset-tag decision (ADR-0069 §7 · ADR-0068 §1) — classification only, NO allocation:
 * - `explicit`     — a tag came from the file; inserted as-is (defended by the live partial-unique index).
 * - `use-existing` — the row matches an existing asset; keep its tag (the match path).
 * - `auto-mint`    — no tag + the scheme is enabled; the commit worker will allocate the next free number.
 * - `none`         — no tag + no enabled scheme; the asset is created tagless.
 * `collision` is true for an explicit tag that already exists on a LIVE asset → surfaced as a per-row
 * conflict (never silently dropped).
 */
export const AssetTagDecisionSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  mode: z.enum(["explicit", "use-existing", "auto-mint", "none"]),
  /** The explicit tag from the file (mode `explicit`); null otherwise. */
  tag: z.string().nullable().default(null),
  collision: z.boolean().default(false),
});

/** The full dry-run report (writes nothing): per-row outcomes + the deduped conflict set + tag decisions. */
export const ImportDryRunReportSchema = z.object({
  result: ImportRowResultSchema,
  conflicts: z.array(ReferenceConflictSchema),
  tags: z.array(AssetTagDecisionSchema),
});

export type ConflictCandidate = z.infer<typeof ConflictCandidateSchema>;
export type ReferenceConflict = z.infer<typeof ReferenceConflictSchema>;
export type AssetTagDecision = z.infer<typeof AssetTagDecisionSchema>;
export type ImportDryRunReport = z.infer<typeof ImportDryRunReportSchema>;
