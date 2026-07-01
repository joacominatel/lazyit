import { z } from "zod";
import { optionalText, requireAtLeastOneKey } from "./primitives";

/**
 * Asset — the first-class citizen: a single tracked thing, a concrete instance of an AssetModel
 * living at a Location. Single source of truth for api and web. See docs/02-domain/entities/asset.md
 * and docs/02-domain/asset-centric.md.
 *
 * Date fields are ISO-8601 strings (wire shape) — see the note in asset-category.ts.
 */

/** Lifecycle state of an Asset. */
export const AssetStatusSchema = z.enum([
  "OPERATIONAL",
  "IN_MAINTENANCE",
  "IN_STORAGE",
  "RETIRED",
  "LOST",
  "UNKNOWN",
]);

// specs stays an OPEN record here on purpose. Per-category governance (ADR-0007 amendment, #851) is
// ADVISORY: an AssetCategory can declare a `specsSchema` dictionary, but it drives soft warnings +
// hints via `validateSpecsAgainstDictionary` (asset-specs-dictionary.ts) — NOT hard validation. The
// wire schema never narrows, so legacy rows keep validating. Distinct from AssetModel.specs (per-unit
// vs type-level). See docs/03-decisions/0007-flexible-asset-specs-jsonb.md.
const AssetSpecsSchema = z.record(z.string(), z.unknown());

/** The full persisted Asset entity (API representation of the `assets` row). */
export const AssetSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  serial: z.string().nullable(),
  assetTag: z.string().nullable(),
  status: AssetStatusSchema,
  specs: AssetSpecsSchema.nullable(),
  notes: z.string().nullable(),
  // Optional GROUPING attribute (ADR-0076, #857) — a Snipe-IT-style "Company" to group/filter/report
  // assets. NOT per-record scoping (anyone with asset:read sees ALL assets; Modo B was decided against,
  // #841). ponytail: free-text + an autocomplete of already-used values — promote to a managed Company
  // entity only if governance (rename/soft-delete) is ever needed.
  company: z.string().nullable(),
  purchaseDate: z.iso.datetime().nullable(),
  warrantyEnd: z.iso.datetime().nullable(),
  modelId: z.cuid().nullable(),
  locationId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * Payload to create an Asset. `status` is required (no default — every asset is classified,
 * consistent with Location.type). `serial`/`assetTag` are unique when present; FKs are optional.
 */
export const CreateAssetSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  serial: z.string().trim().min(1).max(200).optional(),
  assetTag: z.string().trim().min(1).max(200).optional(),
  status: AssetStatusSchema,
  specs: AssetSpecsSchema.optional(),
  notes: optionalText(2000),
  // Optional grouping value (ADR-0076). Mirrors `notes` — optional free text, empty coerced to absent.
  company: optionalText(200),
  purchaseDate: z.iso.datetime().optional(),
  warrantyEnd: z.iso.datetime().optional(),
  modelId: z.cuid().optional(),
  locationId: z.cuid().optional(),
});

/** Partial update; any subset of the editable fields (an empty body is rejected). */
export const UpdateAssetSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      serial: z.string().trim().min(1).max(200),
      assetTag: z.string().trim().min(1).max(200),
      status: AssetStatusSchema,
      specs: AssetSpecsSchema,
      notes: z.string().trim().min(1).max(2000),
      // Optional grouping value (ADR-0076) — mirrors `notes` in the partial update shape.
      company: z.string().trim().min(1).max(200),
      purchaseDate: z.iso.datetime(),
      warrantyEnd: z.iso.datetime(),
      modelId: z.cuid(),
      locationId: z.cuid(),
    })
    .partial(),
);

export type AssetStatus = z.infer<typeof AssetStatusSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type CreateAsset = z.infer<typeof CreateAssetSchema>;
export type UpdateAsset = z.infer<typeof UpdateAssetSchema>;
