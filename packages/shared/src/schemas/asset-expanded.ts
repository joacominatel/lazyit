import { z } from "zod";
import { AssetSchema } from "./asset";
import { AssetModelSchema } from "./asset-model";
import { AssetCategorySchema } from "./asset-category";
import { LocationSchema } from "./location";
import { AssetAssignmentSchema } from "./asset-assignment";
import { UserSchema } from "./user";

/**
 * Expanded read shapes for Asset — the relations inlined, so the web can render a table/detail
 * without fanning out to 5–6 list endpoints. **Read-only**: the write payloads (CreateAsset /
 * UpdateAsset / asset-assignment schemas) are unchanged. Built by `.extend()` over the base
 * schemas so field definitions live in one place. Returned by `GET /assets` and `GET /assets/:id`.
 * See docs/02-domain/entities/asset.md.
 */

/** An AssetModel with its (optional) AssetCategory inlined — the category lives on the model. */
export const AssetModelWithCategorySchema = AssetModelSchema.extend({
  category: AssetCategorySchema.nullable(),
});

/**
 * An AssetAssignment with its owner ([[user]]) inlined. The user may be **soft-deleted** (its
 * `deletedAt` is non-null): an owner who left the company still shows until the assignment is
 * explicitly released — history is preserved (see docs/02-domain/entities/asset.md, ADR-0023-adjacent
 * auditability rules).
 */
export const AssetAssignmentWithUserSchema = AssetAssignmentSchema.extend({
  user: UserSchema,
});

/**
 * An Asset with `model` (+ nested `category`), `location`, and `activeAssignments` (only the
 * `releasedAt = null` owners, each with `user`) inlined. `model`/`location` are `null` when the
 * asset has no model/location; `activeAssignments` is `[]` when there are no active owners.
 */
export const AssetWithRelationsSchema = AssetSchema.extend({
  model: AssetModelWithCategorySchema.nullable(),
  location: LocationSchema.nullable(),
  activeAssignments: z.array(AssetAssignmentWithUserSchema),
});

export type AssetModelWithCategory = z.infer<
  typeof AssetModelWithCategorySchema
>;
export type AssetAssignmentWithUser = z.infer<
  typeof AssetAssignmentWithUserSchema
>;
export type AssetWithRelations = z.infer<typeof AssetWithRelationsSchema>;
