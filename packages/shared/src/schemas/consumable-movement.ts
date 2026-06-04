import { z } from "zod";
import { int4, optionalText } from "./primitives";

/**
 * ConsumableMovement — an append-only ledger of stock changes for a Consumable (ADR-0034). Each row
 * adjusts the cached `Consumable.currentStock` transactionally; rows are never updated or deleted.
 * Single source of truth for api and web. See docs/02-domain/entities/consumable-movement.md.
 *
 * Date fields are ISO-8601 strings (wire shape). `id` is a numeric autoincrement (a ledger id).
 */

/**
 * Stock movement direction. IN adds, OUT subtracts (rejected if it would go negative), ADJUSTMENT
 * sets `currentStock` to the movement's `quantity` (an absolute recount). See ADR-0034.
 */
export const ConsumableMovementTypeSchema = z.enum(["IN", "OUT", "ADJUSTMENT"]);

/** A single ConsumableMovement row (API representation of the `consumable_movements` row). */
export const ConsumableMovementSchema = z.object({
  id: int4(),
  consumableId: z.cuid(),
  type: ConsumableMovementTypeSchema,
  quantity: int4({ min: 1 }),
  reason: z.string().nullable(),
  performedById: z.uuid().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * Payload to record a movement against a consumable. `consumableId` comes from the route and
 * `performedById` from the X-User-Id shim (ADR-0022) — neither is part of the body. `quantity` is
 * always positive (the direction is carried by `type`).
 */
export const CreateConsumableMovementSchema = z.strictObject({
  type: ConsumableMovementTypeSchema,
  quantity: int4({ min: 1, example: 1 }),
  reason: optionalText(500),
  notes: optionalText(2000),
});

/**
 * Query params for `GET /consumables/:id/movements` — optional type filter and a `createdAt` range
 * (`from`/`to`, ISO datetimes). Newest first is enforced by the service, not here.
 */
export const ConsumableMovementQuerySchema = z
  .object({
    type: ConsumableMovementTypeSchema.optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  // Reject an inverted range. Only checked when BOTH bounds are supplied; an open-ended range
  // (only one bound) is valid. ISO-8601 strings parse to Date for a timezone-correct comparison.
  .refine(
    (data) =>
      data.from === undefined ||
      data.to === undefined ||
      new Date(data.from).getTime() <= new Date(data.to).getTime(),
    {
      error: "from must be on or before to",
      path: ["from"],
    },
  );

export type ConsumableMovementType = z.infer<
  typeof ConsumableMovementTypeSchema
>;
export type ConsumableMovement = z.infer<typeof ConsumableMovementSchema>;
export type CreateConsumableMovement = z.infer<
  typeof CreateConsumableMovementSchema
>;
export type ConsumableMovementQuery = z.infer<
  typeof ConsumableMovementQuerySchema
>;
