import { z } from "zod";

/**
 * Consumable — a stock-counted supply item (cables, adapters, toner, …). Distinct from Asset, which
 * is tracked individually (ADR-0008). `currentStock` is a cache maintained transactionally by
 * ConsumableMovement (ADR-0034) — it starts at 0 and is NEVER set directly through create/update,
 * only through movements. Single source of truth for api and web. See
 * docs/02-domain/entities/consumable.md.
 *
 * Date fields are ISO-8601 strings (wire shape) — see the note in asset-category.ts.
 */

/** The full persisted Consumable entity (API representation of the `consumables` row). */
export const ConsumableSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  sku: z.string().nullable(),
  categoryId: z.cuid().nullable(),
  description: z.string().nullable(),
  // Cached on-hand quantity (ADR-0034). Maintained only through movements.
  currentStock: z.number().int(),
  // Optional reorder threshold for low-stock alerts (currentStock <= minStock).
  minStock: z.number().int().nullable(),
  // Free-form unit of measure ("units", "meters", "boxes", …). Not an enum on purpose.
  unit: z.string(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * Payload to create a Consumable. `sku` is unique when present; `categoryId` is optional.
 * `currentStock` is intentionally absent — it starts at 0 and is only changed via movements.
 */
export const CreateConsumableSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().min(1).max(100).optional(),
  categoryId: z.cuid().optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  minStock: z.number().int().min(0).optional(),
  unit: z.string().trim().min(1).max(50).default("units"),
  notes: z.string().trim().min(1).max(2000).optional(),
});

/** Partial update; any subset of the editable fields. `currentStock` is NOT updatable here. */
export const UpdateConsumableSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200),
    sku: z.string().trim().min(1).max(100),
    categoryId: z.cuid(),
    description: z.string().trim().min(1).max(1000),
    minStock: z.number().int().min(0),
    unit: z.string().trim().min(1).max(50),
    notes: z.string().trim().min(1).max(2000),
  })
  .partial();

export type Consumable = z.infer<typeof ConsumableSchema>;
export type CreateConsumable = z.infer<typeof CreateConsumableSchema>;
export type UpdateConsumable = z.infer<typeof UpdateConsumableSchema>;
