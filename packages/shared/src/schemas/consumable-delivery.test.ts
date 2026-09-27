import { describe, expect, test } from "bun:test";
import {
  ConsumableDeliveryPageSchema,
  ConsumableDeliveryQuerySchema,
  ConsumableDeliverySchema,
} from "./consumable-delivery";

const USER = "11111111-1111-4111-8111-111111111111";
const ASSET = "ckasset000000000000000001";
const LOCATION = "cklocation000000000000001";

describe("ConsumableDeliveryQuerySchema (ADR-0098)", () => {
  test.each([
    ["targetUserId", USER],
    ["targetAssetId", ASSET],
    ["targetLocationId", LOCATION],
  ])("accepts exactly one target: %s", (key, id) => {
    const parsed = ConsumableDeliveryQuerySchema.parse({ [key]: id });
    expect(parsed).toMatchObject({ [key]: id, outstandingOnly: false });
  });

  test("requires a target", () => {
    expect(ConsumableDeliveryQuerySchema.safeParse({}).success).toBe(false);
  });

  test("rejects two targets", () => {
    expect(
      ConsumableDeliveryQuerySchema.safeParse({ targetUserId: USER, targetAssetId: ASSET })
        .success,
    ).toBe(false);
  });

  test("coerces outstandingOnly from the query string like the other list flags", () => {
    const parse = (value: string) =>
      ConsumableDeliveryQuerySchema.parse({ targetUserId: USER, outstandingOnly: value })
        .outstandingOnly;
    expect(parse("true")).toBe(true);
    expect(parse("1")).toBe(true);
    expect(parse("false")).toBe(false);
    expect(parse("0")).toBe(false);
    expect(parse("OFF")).toBe(false);
  });

  test("validates the from/to range", () => {
    expect(
      ConsumableDeliveryQuerySchema.safeParse({
        targetUserId: USER,
        from: "2026-02-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      ConsumableDeliveryQuerySchema.safeParse({ targetUserId: USER, from: "yesterday" }).success,
    ).toBe(false);
  });
});

describe("ConsumableDeliverySchema", () => {
  const DELIVERY = {
    id: 12,
    consumableId: "ckconsumable0000000000001",
    type: "OUT",
    quantity: 3,
    reason: null,
    performedById: USER,
    notes: null,
    targetUserId: USER,
    targetAssetId: null,
    targetLocationId: null,
    returnable: true,
    returnOfId: null,
    target: { type: "user", id: USER, displayName: "Ana Pérez", isOffboarded: false },
    createdAt: "2026-01-01T00:00:00.000Z",
    consumable: {
      id: "ckconsumable0000000000001",
      name: "Headset",
      sku: null,
      unit: "units",
      deletedAt: null,
    },
    returnedQuantity: 1,
    outstandingQuantity: 2,
  };

  test("reads a delivery and its page envelope", () => {
    expect(ConsumableDeliverySchema.safeParse(DELIVERY).success).toBe(true);
    expect(
      ConsumableDeliveryPageSchema.safeParse({ items: [DELIVERY], total: 1, limit: 50, offset: 0 })
        .success,
    ).toBe(true);
  });

  test("a soft-deleted consumable is flagged, not dropped", () => {
    expect(
      ConsumableDeliverySchema.safeParse({
        ...DELIVERY,
        consumable: { ...DELIVERY.consumable, deletedAt: "2026-02-01T00:00:00.000Z" },
      }).success,
    ).toBe(true);
  });

  test("outstanding can never be negative", () => {
    expect(ConsumableDeliverySchema.safeParse({ ...DELIVERY, outstandingQuantity: -1 }).success).toBe(
      false,
    );
  });
});
