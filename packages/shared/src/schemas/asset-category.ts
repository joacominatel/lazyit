import { z } from "zod";
import { AssetSpecsDictionarySchema } from "./asset-specs-dictionary";
import { requireAtLeastOneKey } from "./primitives";

/**
 * AssetCategory — classification for AssetModels (Laptop, Server, Switch, …). User-managed:
 * created, edited and soft-deleted from the app. Single source of truth for both api and web.
 * See docs/02-domain/entities/asset-category.md.
 *
 * Date fields are ISO-8601 strings (the wire shape): the API serializes Prisma `DateTime`s to
 * strings, and `z.date()` cannot be represented in JSON Schema / OpenAPI ([[0018]]).
 */

/** The full persisted AssetCategory entity (API representation of the `asset_categories` row). */
export const AssetCategorySchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  // Free string: a heroicon name for the web UI (e.g. "ServerStackIcon"). Not validated.
  icon: z.string().nullable(),
  // ADVISORY specs dictionary (ADR-0007 amendment, #851): a declarative field list that drives
  // hints + soft warnings for Asset.specs of this category's models. `null` = no governance (any
  // jsonb object accepted, the ADR-0007 default). See asset-specs-dictionary.ts.
  specsSchema: AssetSpecsDictionarySchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create an AssetCategory. `name` is unique (enforced by the DB). */
export const CreateAssetCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000).optional(),
  icon: z.string().trim().min(1).max(100).optional(),
  // Optional declarative specs dictionary (advisory — see AssetCategorySchema). Omit for none.
  specsSchema: AssetSpecsDictionarySchema.optional(),
});

/** Partial update; any subset of the editable fields (an empty body is rejected). */
export const UpdateAssetCategorySchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(1000),
      icon: z.string().trim().min(1).max(100),
      // Replace the whole dictionary; send `[]` to clear it (no governance).
      specsSchema: AssetSpecsDictionarySchema,
    })
    .partial(),
);

export type AssetCategory = z.infer<typeof AssetCategorySchema>;
export type CreateAssetCategory = z.infer<typeof CreateAssetCategorySchema>;
export type UpdateAssetCategory = z.infer<typeof UpdateAssetCategorySchema>;
