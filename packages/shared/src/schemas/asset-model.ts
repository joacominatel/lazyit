import { z } from "zod";
import { requireAtLeastOneKey } from "./primitives";

/**
 * AssetModel — the generic make/model an Asset is an instance of (e.g. "Dell Latitude 5520").
 * Holds type-level facts; per-unit facts live on Asset. Single source of truth for api and web.
 * See docs/02-domain/entities/asset-model.md.
 *
 * Date fields are ISO-8601 strings (wire shape) — see the note in asset-category.ts.
 */

// TODO(specs): once an AssetCategory can declare a `specsSchema`, validate model specs against
// it dynamically. For now any JSON object is accepted. See docs/03-decisions/0007-flexible-asset-specs-jsonb.md.
const ModelSpecsSchema = z.record(z.string(), z.unknown());

/** The full persisted AssetModel entity (API representation of the `asset_models` row). */
export const AssetModelSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  manufacturer: z.string().min(1),
  sku: z.string().nullable(),
  description: z.string().nullable(),
  // Model-level default specs (e.g. "this model ships with 16GB"). Distinct from Asset.specs.
  specs: ModelSpecsSchema.nullable(),
  categoryId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create an AssetModel. `sku` is unique when present; `categoryId` is optional. */
export const CreateAssetModelSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  manufacturer: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(2000).optional(),
  specs: ModelSpecsSchema.optional(),
  categoryId: z.cuid().optional(),
});

/** Partial update; any subset of the editable fields (an empty body is rejected). */
export const UpdateAssetModelSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      manufacturer: z.string().trim().min(1).max(200),
      sku: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(2000),
      specs: ModelSpecsSchema,
      categoryId: z.cuid(),
    })
    .partial(),
);

export type AssetModel = z.infer<typeof AssetModelSchema>;
export type CreateAssetModel = z.infer<typeof CreateAssetModelSchema>;
export type UpdateAssetModel = z.infer<typeof UpdateAssetModelSchema>;
