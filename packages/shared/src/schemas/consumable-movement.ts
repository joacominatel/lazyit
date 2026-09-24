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

/**
 * The resolved, redaction-safe DESTINATION of a delivery (ADR-0098, #1364) — never the raw FK alone. A
 * discriminated union over `type`, resolved server-side through the soft-delete escape hatch so a target
 * that has since been offboarded / retired / archived is FLAGGED, never dangling:
 *   - `{ type: "user", id, displayName, isOffboarded }`  — a person (display name only, no email/PII).
 *   - `{ type: "asset", id, label, isDeleted }`         — `label` = assetTag ?? name ?? serial.
 *   - `{ type: "location", id, name, isDeleted }`       — a place the units were LEFT (a destination,
 *     not per-location stock).
 *
 * REDACTION: the display fields (`displayName`/`label`/`name`) and the lifecycle flag are `null` when the
 * caller does not hold the target domain's read permission (`user:read` / `asset:read` /
 * `location:read`) — e.g. a VIEWER (who lacks `user:read`, ADR-0046 P3) sees THAT a unit went to a user,
 * by id, but not who. A UI renders a neutral placeholder for `null`, as it does for an unresolvable
 * actor elsewhere.
 */
export const ConsumableDeliveryTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    id: z.uuid(),
    // `${firstName} ${lastName}`; null = redacted (caller lacks user:read).
    displayName: z.string().nullable(),
    // TRUE when the recipient is soft-deleted (offboarded); null = redacted.
    isOffboarded: z.boolean().nullable(),
  }),
  z.object({
    type: z.literal("asset"),
    id: z.cuid(),
    // assetTag ?? name ?? serial; null = redacted (caller lacks asset:read).
    label: z.string().nullable(),
    // TRUE when the asset is soft-deleted (retired); null = redacted.
    isDeleted: z.boolean().nullable(),
  }),
  z.object({
    type: z.literal("location"),
    id: z.cuid(),
    // null = redacted (caller lacks location:read).
    name: z.string().nullable(),
    // TRUE when the location is soft-deleted (archived); null = redacted.
    isDeleted: z.boolean().nullable(),
  }),
]);

/** A single ConsumableMovement row (API representation of the `consumable_movements` row). */
export const ConsumableMovementSchema = z.object({
  id: int4(),
  consumableId: z.cuid(),
  type: ConsumableMovementTypeSchema,
  quantity: int4({ min: 1 }),
  reason: z.string().nullable(),
  performedById: z.uuid().nullable(),
  notes: z.string().nullable(),
  // ── Delivery / return (ADR-0098, #1364). All `.nullish()` per the shared-package "new read field"
  // rule: every pre-existing row reads null / false, and a consumer built against the older shape keeps
  // compiling. At most one target is set, and only on an OUT.
  targetUserId: z.uuid().nullish(),
  targetAssetId: z.cuid().nullish(),
  targetLocationId: z.cuid().nullish(),
  // Snapshot of Consumable.returnable at delivery time; only ever true on a targeted OUT.
  returnable: z.boolean().nullish(),
  // On an IN that RETURNS a delivery: the delivery (OUT) movement id it gives back.
  returnOfId: int4({ min: 1 }).nullish(),
  // The resolved destination (see ConsumableDeliveryTargetSchema); null for an untargeted movement.
  target: ConsumableDeliveryTargetSchema.nullish(),
  createdAt: z.iso.datetime(),
});

/** The three delivery-target keys of the create payload, in a stable order. */
export const CONSUMABLE_DELIVERY_TARGET_KEYS = [
  "targetUserId",
  "targetAssetId",
  "targetLocationId",
] as const;
export type ConsumableDeliveryTargetKey =
  (typeof CONSUMABLE_DELIVERY_TARGET_KEYS)[number];

/**
 * Payload to record a movement against a consumable. `consumableId` comes from the route and the actor
 * from the authenticated principal — neither is part of the body. `quantity` is always positive (the
 * direction is carried by `type`).
 *
 * Delivery (ADR-0098): an `OUT` may name ONE optional destination — `targetUserId` (uuid) |
 * `targetAssetId` (cuid) | `targetLocationId` (cuid). A return: an `IN` may carry `returnOfId`, the id of
 * the returnable delivery it gives back. The rules, enforced here (→ 400 at the API) and backstopped by
 * DB CHECKs:
 *   - at most one target;
 *   - a target only with `type: "OUT"`;
 *   - `returnOfId` only with `type: "IN"` (so it is mutually exclusive with a target by construction).
 * A plain movement (the quick −1/+1) sends none of them and behaves exactly as before.
 */
export const CreateConsumableMovementSchema = z
  .strictObject({
    type: ConsumableMovementTypeSchema,
    quantity: int4({ min: 1, example: 1 }),
    reason: optionalText(500),
    notes: optionalText(2000),
    targetUserId: z.uuid().optional(),
    targetAssetId: z.cuid().optional(),
    targetLocationId: z.cuid().optional(),
    returnOfId: int4({ min: 1, example: 42 }).optional(),
  })
  .superRefine((data, ctx) => {
    const present = CONSUMABLE_DELIVERY_TARGET_KEYS.filter(
      (key) => data[key] !== undefined,
    );
    // Every target after the first is the offending one.
    for (const key of present.slice(1)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message:
          "A delivery takes at most one target: targetUserId, targetAssetId or targetLocationId",
      });
    }
    if (data.type !== "OUT") {
      for (const key of present) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "A delivery target is only allowed on an OUT movement",
        });
      }
    }
    if (data.returnOfId !== undefined && data.type !== "IN") {
      ctx.addIssue({
        code: "custom",
        path: ["returnOfId"],
        message: "returnOfId (a return) is only allowed on an IN movement",
      });
    }
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

export type ConsumableDeliveryTarget = z.infer<
  typeof ConsumableDeliveryTargetSchema
>;
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
