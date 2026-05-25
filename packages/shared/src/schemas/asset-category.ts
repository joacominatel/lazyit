import { z } from "zod";

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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create an AssetCategory. `name` is unique (enforced by the DB). */
export const CreateAssetCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000).optional(),
  icon: z.string().trim().min(1).max(100).optional(),
});

/** Partial update; any subset of the editable fields. */
export const UpdateAssetCategorySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1000),
    icon: z.string().trim().min(1).max(100),
  })
  .partial();

export type AssetCategory = z.infer<typeof AssetCategorySchema>;
export type CreateAssetCategory = z.infer<typeof CreateAssetCategorySchema>;
export type UpdateAssetCategory = z.infer<typeof UpdateAssetCategorySchema>;
