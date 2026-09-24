import { z } from "zod";
import { int4 } from "./primitives";
import { pageSchema } from "./pagination";
import { ConsumableMovementSchema } from "./consumable-movement";

/**
 * Consumable DELIVERIES (ADR-0098, #1364) — the read side of a targeted `OUT` movement. A delivery is not
 * an ownership join: it is a ledger row that recorded where some units went (a user, an asset or a
 * location). This module is the contract for `GET /consumables/deliveries`, the list the user detail,
 * the offboarding sheet / Return Act, the asset detail and the location detail read.
 */

/**
 * Query-string boolean, coerced the way the API's other list flags are (`parseBooleanQuery`): absent →
 * default, and any value other than `false`/`0`/`no`/`off` (case-insensitive) → true. A real boolean is
 * accepted as-is so a typed client can pass one.
 */
const QUERY_FALSY = new Set(["false", "0", "no", "off"]);
const queryBoolean = z.preprocess(
  (value) =>
    typeof value === "string"
      ? !QUERY_FALSY.has(value.trim().toLowerCase())
      : value,
  z.boolean(),
);

/**
 * Filters for `GET /consumables/deliveries`. EXACTLY ONE target is required — the list is always "the
 * deliveries made to THIS user / asset / location", never an estate-wide dump. `outstandingOnly` keeps
 * only returnable deliveries with units still out; `from`/`to` bound `createdAt` (inclusive ISO
 * datetimes). The ADR-0030 pagination params (`limit`/`offset`/`page`) ride alongside and are parsed by
 * `PageQuerySchema`; the order is fixed newest first.
 */
export const ConsumableDeliveryQuerySchema = z
  .object({
    targetUserId: z.uuid().optional(),
    targetAssetId: z.cuid().optional(),
    targetLocationId: z.cuid().optional(),
    outstandingOnly: queryBoolean.default(false),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
  })
  .superRefine((data, ctx) => {
    const count = [
      data.targetUserId,
      data.targetAssetId,
      data.targetLocationId,
    ].filter((value) => value !== undefined).length;
    if (count !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["targetUserId"],
        message:
          "Exactly one of targetUserId, targetAssetId or targetLocationId is required",
      });
    }
    if (
      data.from !== undefined &&
      data.to !== undefined &&
      new Date(data.from).getTime() > new Date(data.to).getTime()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["from"],
        message: "from must be on or before to",
      });
    }
  });

/**
 * The consumable a delivery drew from — a thin projection. `deletedAt` is set when the consumable has
 * since been soft-deleted: its past deliveries stay listed (history never vanishes) and the UI flags it.
 */
export const ConsumableDeliveryConsumableSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  sku: z.string().nullable(),
  unit: z.string(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * One delivery: the targeted `OUT` movement (with its resolved `target`), the consumable it drew from,
 * and its return state. `returnedQuantity` = SUM of the IN movements linked to it (`returnOfId`);
 * `outstandingQuantity` = `quantity − returnedQuantity` for a returnable delivery, and always 0 for a
 * non-returnable one (a consumed item is never "owed back").
 */
export const ConsumableDeliverySchema = ConsumableMovementSchema.extend({
  consumable: ConsumableDeliveryConsumableSchema,
  returnable: z.boolean(),
  returnedQuantity: int4({ min: 0 }),
  outstandingQuantity: int4({ min: 0 }),
});

/** Paginated `GET /consumables/deliveries` envelope (ADR-0030). Newest first. */
export const ConsumableDeliveryPageSchema = pageSchema(ConsumableDeliverySchema);

export type ConsumableDeliveryQuery = z.infer<
  typeof ConsumableDeliveryQuerySchema
>;
export type ConsumableDeliveryConsumable = z.infer<
  typeof ConsumableDeliveryConsumableSchema
>;
export type ConsumableDelivery = z.infer<typeof ConsumableDeliverySchema>;
export type ConsumableDeliveryPage = z.infer<typeof ConsumableDeliveryPageSchema>;
