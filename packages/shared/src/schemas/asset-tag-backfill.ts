import { z } from "zod";

/**
 * Asset-tag estate-awareness contract (ADR-0068, #547). The single source of truth for api and web
 * over the THREE surfaces the ADR adds on top of the shipped scheme (ADR-0063):
 *
 *   - **seed suggestion** — `GET /config/asset-tag-scheme/seed-suggestion`: from the in-progress
 *     affixes the admin is editing, parse the numeric body out of LIVE tags that match
 *     `prefix … suffix` and suggest `max + 1` as the `startNumber` (so the counter is seeded ABOVE
 *     the occupied range, ADR-0068 §2). Read-only — touches no counter, writes nothing.
 *   - **backfill preview** — `GET /config/asset-tag-scheme/backfill/preview`: a paginated, read-only
 *     projection of exactly the live assets a given mode/scope would retag. `proposedTag` is an
 *     INDICATIVE projection (a what-if walk from the current counter under the skip-existing
 *     invariant), NOT a promise — the counter is not consumed (ADR-0068 §4).
 *   - **backfill apply** — `POST /config/asset-tag-scheme/backfill/apply`: the deliberate, audited
 *     bulk retag (each row allocated for real under the skip-existing invariant + an AssetHistory
 *     row). Forward-only, no undo; partial completion is acceptable (counts returned, ADR-0068 §3).
 *
 * The two MODES (ADR-0068 §3):
 *   - `untagged-only` (default, safe) — only live assets with NO `assetTag`.
 *   - `normalize-non-conforming` (opt-in, destructive — behind a frontend warning) — additionally
 *     retag live assets whose tag does NOT match the active scheme pattern. CONFORMING manual tags
 *     are NEVER touched.
 */

/** Which slice of the live estate a backfill targets (ADR-0068 §3). */
export const AssetTagBackfillModeSchema = z.enum([
  "untagged-only",
  "normalize-non-conforming",
]);
export type AssetTagBackfillMode = z.infer<typeof AssetTagBackfillModeSchema>;

/**
 * `GET /config/asset-tag-scheme/seed-suggestion` query — the IN-PROGRESS affixes the admin is
 * editing (not yet saved). The endpoint parses live tags matching these and returns `max + 1`.
 */
export const AssetTagSeedSuggestionQuerySchema = z.object({
  prefix: z.string().optional(),
  suffix: z.string().optional(),
  width: z.coerce.number().int().min(0).optional(),
});
export type AssetTagSeedSuggestionQuery = z.infer<
  typeof AssetTagSeedSuggestionQuerySchema
>;

/**
 * `GET /config/asset-tag-scheme/seed-suggestion` response. `suggestedStartNumber` = `max + 1` (or 1
 * when nothing matched); `matchedCount` = how many live tags matched the affixes; `maxExistingNumber`
 * = the largest parsed body number (null when nothing matched).
 */
export const AssetTagSeedSuggestionSchema = z.object({
  suggestedStartNumber: z.number().int(),
  matchedCount: z.number().int(),
  maxExistingNumber: z.number().int().nullable(),
});
export type AssetTagSeedSuggestion = z.infer<
  typeof AssetTagSeedSuggestionSchema
>;

/**
 * `GET /config/asset-tag-scheme/backfill/preview` query. `mode` selects the slice; `modelId` is an
 * optional AssetModel filter; `page`/`pageSize` paginate (page 1-based, pageSize ≤ 100).
 */
export const AssetTagBackfillPreviewQuerySchema = z.object({
  mode: AssetTagBackfillModeSchema.default("untagged-only"),
  modelId: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type AssetTagBackfillPreviewQuery = z.infer<
  typeof AssetTagBackfillPreviewQuerySchema
>;

/**
 * One row of a backfill preview. `currentTag` is the existing tag (null for an untagged asset);
 * `proposedTag` is the INDICATIVE projection (not consumed). `name` is the best display label.
 */
export const AssetTagBackfillItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  currentTag: z.string().nullable(),
  proposedTag: z.string(),
  modelId: z.string().nullable(),
  modelName: z.string().nullable(),
});
export type AssetTagBackfillItem = z.infer<typeof AssetTagBackfillItemSchema>;

/** A page of preview rows + the total matching the scope (so the UI can size the wizard). */
export const AssetTagBackfillPreviewSchema = z.object({
  items: z.array(AssetTagBackfillItemSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  mode: AssetTagBackfillModeSchema,
});
export type AssetTagBackfillPreview = z.infer<
  typeof AssetTagBackfillPreviewSchema
>;

/**
 * `POST /config/asset-tag-scheme/backfill/apply` body. `mode`/`modelId` re-state the scope;
 * `excludeIds` is the per-row deselection from the preview (apply acts on `matching − excludeIds`).
 */
export const AssetTagBackfillApplySchema = z.object({
  mode: AssetTagBackfillModeSchema,
  modelId: z.string().optional(),
  excludeIds: z.array(z.string()).default([]),
});
export type AssetTagBackfillApply = z.infer<typeof AssetTagBackfillApplySchema>;

/** Apply result: how many assets got a fresh tag (`tagged`) and how many were skipped (`skipped`). */
export const AssetTagBackfillResultSchema = z.object({
  tagged: z.number().int(),
  skipped: z.number().int(),
});
export type AssetTagBackfillResult = z.infer<
  typeof AssetTagBackfillResultSchema
>;
