import { z } from "zod";
import { AssetStatusSchema } from "./asset";
import { int4, requireAtLeastOneKey } from "./primitives";

/**
 * AssetStatusLabel — a CUSTOM asset status (ADR-0101, #1524): an operator-defined name ("In repair at
 * vendor", "Loaner pool") mapped to exactly ONE built-in {@link AssetStatusSchema} value, its `kind`.
 * Single source of truth for api and web. See docs/02-domain/entities/asset-status-label.md.
 *
 * Optional configuration: no asset needs one, and every rule (dashboard, filters, defaults, imports, the AI)
 * reads the asset's built-in `status`. Setting a custom status on an asset sets its `status` to the label's
 * `kind`. Managed under the category permissions (`category:read` / `category:write` / `category:delete`) —
 * taxonomy data, no permission of its own.
 *
 * Date fields are ISO-8601 strings (wire shape).
 */

/** The longest custom status name. */
export const ASSET_STATUS_LABEL_NAME_MAX = 100;
/** The longest custom status description. */
export const ASSET_STATUS_LABEL_DESCRIPTION_MAX = 1000;
/** The highest sort position a custom status takes (lower sorts first). */
export const ASSET_STATUS_LABEL_ORDER_MAX = 100_000;

/** A badge colour: `#RRGGBB`, case-insensitive. Validated on write only; the read shape stays a string. */
export const AssetStatusLabelColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, { message: "Use a #RRGGBB colour, e.g. #3B82F6" });

const name = z.string().trim().min(1).max(ASSET_STATUS_LABEL_NAME_MAX);
const description = z.string().trim().min(1).max(ASSET_STATUS_LABEL_DESCRIPTION_MAX);
const order = int4({ min: 0, max: ASSET_STATUS_LABEL_ORDER_MAX });

/**
 * The persisted custom status (API representation of the `asset_status_labels` row). `assetCount` is the
 * number of LIVE assets carrying it, present on the list and detail reads (absent on write responses).
 * The read shape is tolerant on purpose: `color` and `name` are plain strings, not the write rules.
 */
export const AssetStatusLabelSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  kind: AssetStatusSchema,
  color: z.string().nullable(),
  description: z.string().nullable(),
  order: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  assetCount: z.number().int().min(0).optional(),
});

/**
 * The response of `DELETE /asset-status-labels/:id`: the archived custom status plus how many assets (live
 * and archived) were moved off it to the chosen target.
 */
export const DeleteAssetStatusLabelResultSchema = AssetStatusLabelSchema.extend({
  movedAssetCount: z.number().int().min(0),
});

/** Payload to create a custom status. The name is unique among live custom statuses (409 otherwise). */
export const CreateAssetStatusLabelSchema = z.strictObject({
  name,
  kind: AssetStatusSchema,
  color: AssetStatusLabelColorSchema.optional(),
  description: description.optional(),
  order: order.optional(),
});

/**
 * Partial update (an empty body is rejected). `color` / `description` / `order` take `null` to clear.
 * Changing `kind` while ANY asset (live or archived) carries the custom status is a 409: its assets would
 * silently change built-in status. Move them off it first, or create a new custom status.
 */
export const UpdateAssetStatusLabelSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name,
      kind: AssetStatusSchema,
      color: AssetStatusLabelColorSchema.nullable(),
      description: description.nullable(),
      order: order.nullable(),
    })
    .partial(),
);

/**
 * The query of `DELETE /asset-status-labels/:id`: where the assets carrying the custom status go. When any
 * asset (live or archived) carries it, exactly ONE target is required — another live custom status
 * (`reassignLabelId`) or a bare built-in status (`reassignStatus`) — and the move, its history and the
 * soft delete happen in one transaction. An unused custom status needs none. Both at once is a 400.
 */
export const DeleteAssetStatusLabelQuerySchema = z
  .object({
    reassignLabelId: z.cuid().optional(),
    reassignStatus: AssetStatusSchema.optional(),
  })
  .refine((q) => q.reassignLabelId === undefined || q.reassignStatus === undefined, {
    message: "Give reassignLabelId or reassignStatus, not both",
    path: ["reassignLabelId"],
  });

/** The query of `GET /asset-status-labels`: `deleted=only` lists the archived ones (ADMIN only, ADR-0041). */
export const AssetStatusLabelListQuerySchema = z.object({
  deleted: z.enum(["active", "only"]).default("active"),
});

export type AssetStatusLabel = z.infer<typeof AssetStatusLabelSchema>;
export type CreateAssetStatusLabel = z.infer<typeof CreateAssetStatusLabelSchema>;
export type UpdateAssetStatusLabel = z.infer<typeof UpdateAssetStatusLabelSchema>;
export type DeleteAssetStatusLabelResult = z.infer<typeof DeleteAssetStatusLabelResultSchema>;
export type DeleteAssetStatusLabelQuery = z.infer<typeof DeleteAssetStatusLabelQuerySchema>;
export type AssetStatusLabelListQuery = z.infer<typeof AssetStatusLabelListQuerySchema>;
