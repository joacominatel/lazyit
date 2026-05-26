import { z } from "zod";

/**
 * ConsumableCategory — user-managed grouping for Consumables (Cables, Adapters, Peripherals, …).
 * Created, edited and soft-deleted from the app, like AssetCategory / ApplicationCategory. Single
 * source of truth for both api and web. See docs/02-domain/entities/consumable-category.md.
 *
 * Date fields are ISO-8601 strings (the wire shape): the API serializes Prisma `DateTime`s to
 * strings, and `z.date()` cannot be represented in JSON Schema / OpenAPI ([[0018]]).
 */

/** The full persisted ConsumableCategory entity (API representation of `consumable_categories`). */
export const ConsumableCategorySchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  // Free string: a heroicon name for the web UI (e.g. "CpuChipIcon"). Not validated.
  icon: z.string().nullable(),
  // Optional sort key for the listing (lower first); null sorts last.
  order: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create a ConsumableCategory. `name` is unique (enforced by the DB). */
export const CreateConsumableCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000).optional(),
  icon: z.string().trim().min(1).max(100).optional(),
  order: z.number().int().optional(),
});

/** Partial update; any subset of the editable fields. */
export const UpdateConsumableCategorySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1000),
    icon: z.string().trim().min(1).max(100),
    order: z.number().int(),
  })
  .partial();

export type ConsumableCategory = z.infer<typeof ConsumableCategorySchema>;
export type CreateConsumableCategory = z.infer<
  typeof CreateConsumableCategorySchema
>;
export type UpdateConsumableCategory = z.infer<
  typeof UpdateConsumableCategorySchema
>;
