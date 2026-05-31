import { z } from "zod";
import { AssetSchema } from "./asset";
import { pageSchema } from "./pagination";

/**
 * Lean read shapes for the asset list (`GET /assets`). The list is the inventory pillar's heaviest
 * endpoint, so the row is trimmed two ways versus the detail read ({@link AssetWithRelationsSchema}):
 *
 *  1. The asset's own `specs` jsonb blob is **omitted** (unbounded per-unit attributes the table
 *     never renders).
 *  2. Each joined relation (`model` + its `category`, `location`, and the active-assignment owners)
 *     is trimmed to only the fields the list actually shows — not the full related rows.
 *
 * The detail reads (`GET /assets/:id`) still return the full graph incl. `specs`. See
 * docs/03-decisions/0030-list-pagination-contract.md and the backend-performance-optimization
 * analysis (#2: "GET /assets eager-loads a deep relation graph for every row with no cap").
 */

/** The lean asset core: the full Asset row **minus the `specs` jsonb**. */
const AssetListCoreSchema = AssetSchema.omit({ specs: true });

/** Trimmed AssetCategory for the list — only what a model badge shows. */
const AssetListCategorySchema = z.object({
  id: z.cuid(),
  name: z.string(),
});

/** Trimmed AssetModel (+ its category) for the list. */
const AssetListModelSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  manufacturer: z.string(),
  category: AssetListCategorySchema.nullable(),
});

/** Trimmed Location for the list — name + type are enough for a cell/badge. */
const AssetListLocationSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  type: z.string(),
});

/** Trimmed owner ([[user]]) for an active assignment — identity only, no audit/IdP fields. */
const AssetListAssignmentSchema = z.object({
  id: z.cuid(),
  userId: z.uuid(),
  user: z.object({
    id: z.uuid(),
    firstName: z.string(),
    lastName: z.string(),
    email: z.email(),
  }),
});

/**
 * One row of `GET /assets`: the lean asset core plus the trimmed `model` (+ `category`), `location`,
 * and `activeAssignments` (only `releasedAt = null` owners). `model`/`location` are `null` when the
 * asset has none; `activeAssignments` is `[]` when there are no active owners.
 */
export const AssetListItemSchema = AssetListCoreSchema.extend({
  model: AssetListModelSchema.nullable(),
  location: AssetListLocationSchema.nullable(),
  activeAssignments: z.array(AssetListAssignmentSchema),
});

/** The paginated `GET /assets` envelope: `{ items: AssetListItem[], total, limit, offset }`. */
export const AssetListPageSchema = pageSchema(AssetListItemSchema);

export type AssetListItem = z.infer<typeof AssetListItemSchema>;
export type AssetListPage = z.infer<typeof AssetListPageSchema>;
