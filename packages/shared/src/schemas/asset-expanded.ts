import { z } from "zod";
import { AssetSchema } from "./asset";
import { AssetModelSchema } from "./asset-model";
import { AssetCategorySchema } from "./asset-category";
import { LocationSchema } from "./location";
import { AssetAssignmentSchema } from "./asset-assignment";
import { UserSchema } from "./user";
import { pageSchema } from "./pagination";

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

// --- Lean list projection (GET /assets) ------------------------------------
// The list does not need the full relation graph or the `specs` jsonb (which can be large and is
// only rendered on the detail view). It ships just the columns a table row renders, with each
// relation trimmed to its label fields — see docs/03-decisions/0030-list-pagination-contract.md.
// The full shape (AssetWithRelationsSchema, incl. `specs`) is still returned by GET /assets/:id.

/** The minimal AssetModel a list row renders (no `specs`/`sku`/timestamps), with its category label. */
export const AssetModelListItemSchema = AssetModelSchema.pick({
  id: true,
  name: true,
  manufacturer: true,
}).extend({
  category: AssetCategorySchema.pick({ id: true, name: true }).nullable(),
});

/** The minimal Location a list row renders (label fields only). */
export const LocationListItemSchema = LocationSchema.pick({
  id: true,
  name: true,
  type: true,
});

/** The minimal owner a list row renders — the user's identity fields, no timestamps/flags. */
export const AssetAssignmentUserListItemSchema = AssetAssignmentSchema.pick({
  id: true,
  assetId: true,
  userId: true,
  assignedAt: true,
}).extend({
  user: UserSchema.pick({
    id: true,
    firstName: true,
    lastName: true,
    email: true,
  }),
});

/**
 * The lean Asset row returned by `GET /assets`: the asset's own columns **minus the `specs` jsonb**,
 * with `model`/`location`/`activeAssignments` trimmed to the fields a table renders. The full
 * `specs` and the complete relation graph are returned only by `GET /assets/:id`
 * ({@link AssetWithRelationsSchema}).
 */
export const AssetListItemSchema = AssetSchema.omit({ specs: true }).extend({
  model: AssetModelListItemSchema.nullable(),
  location: LocationListItemSchema.nullable(),
  activeAssignments: z.array(AssetAssignmentUserListItemSchema),
});

/** The paginated `GET /assets` response: a page of lean {@link AssetListItemSchema} rows. */
export const AssetListPageSchema = pageSchema(AssetListItemSchema);

export type AssetModelWithCategory = z.infer<
  typeof AssetModelWithCategorySchema
>;
export type AssetAssignmentWithUser = z.infer<
  typeof AssetAssignmentWithUserSchema
>;
export type AssetWithRelations = z.infer<typeof AssetWithRelationsSchema>;
export type AssetModelListItem = z.infer<typeof AssetModelListItemSchema>;
export type LocationListItem = z.infer<typeof LocationListItemSchema>;
export type AssetAssignmentUserListItem = z.infer<
  typeof AssetAssignmentUserListItemSchema
>;
export type AssetListItem = z.infer<typeof AssetListItemSchema>;
export type AssetListPage = z.infer<typeof AssetListPageSchema>;
