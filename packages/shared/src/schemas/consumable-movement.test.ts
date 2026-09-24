import { describe, expect, test } from "bun:test";
import { CreateConsumableSchema, UpdateConsumableSchema } from "./consumable";
import {
  ConsumableDeliveryTargetSchema,
  ConsumableMovementQuerySchema,
  ConsumableMovementSchema,
  CreateConsumableMovementSchema,
} from "./consumable-movement";

// Cross-field refine (round-2 correctness): an inverted from/to range is a 400, not a silent
// empty result.
describe("ConsumableMovementQuerySchema — from <= to", () => {
  test("accepts an empty query (no bounds)", () => {
    expect(ConsumableMovementQuerySchema.safeParse({}).success).toBe(true);
  });

  test("accepts from before to", () => {
    expect(
      ConsumableMovementQuerySchema.safeParse({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  test("accepts from EQUAL to to", () => {
    const t = "2026-01-01T00:00:00.000Z";
    expect(
      ConsumableMovementQuerySchema.safeParse({ from: t, to: t }).success,
    ).toBe(true);
  });

  test("rejects from AFTER to (inverted range)", () => {
    expect(
      ConsumableMovementQuerySchema.safeParse({
        from: "2026-06-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("accepts an open-ended range (only one bound)", () => {
    expect(
      ConsumableMovementQuerySchema.safeParse({
        from: "2026-06-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      ConsumableMovementQuerySchema.safeParse({
        to: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

// ── Deliveries and returns (ADR-0098, #1364) ────────────────────────────────────────────────────────

const USER = "11111111-1111-4111-8111-111111111111";
const ASSET = "ckasset000000000000000001";
const LOCATION = "cklocation000000000000001";

/** The paths of the issues a failed parse reported. */
function issuePaths(input: unknown): string[] {
  const result = CreateConsumableMovementSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("CreateConsumableMovementSchema — delivery targets", () => {
  test("a plain movement (the quick −1/+1) still parses unchanged", () => {
    expect(CreateConsumableMovementSchema.parse({ type: "OUT", quantity: 1 })).toEqual({
      type: "OUT",
      quantity: 1,
    });
  });

  test.each([
    ["targetUserId", USER],
    ["targetAssetId", ASSET],
    ["targetLocationId", LOCATION],
  ])("accepts an OUT with a single %s", (key, id) => {
    expect(
      CreateConsumableMovementSchema.safeParse({ type: "OUT", quantity: 2, [key]: id }).success,
    ).toBe(true);
  });

  test("rejects two targets, flagging the second one", () => {
    expect(
      issuePaths({ type: "OUT", quantity: 1, targetUserId: USER, targetAssetId: ASSET }),
    ).toEqual(["targetAssetId"]);
  });

  test("rejects three targets, flagging every one after the first", () => {
    expect(
      issuePaths({
        type: "OUT",
        quantity: 1,
        targetUserId: USER,
        targetAssetId: ASSET,
        targetLocationId: LOCATION,
      }),
    ).toEqual(["targetAssetId", "targetLocationId"]);
  });

  test.each(["IN", "ADJUSTMENT"] as const)("rejects a target on %s", (type) => {
    expect(issuePaths({ type, quantity: 1, targetUserId: USER })).toEqual(["targetUserId"]);
  });

  test("validates the id format of each target (uuid user, cuid asset/location)", () => {
    expect(issuePaths({ type: "OUT", quantity: 1, targetUserId: ASSET })).toEqual([
      "targetUserId",
    ]);
    expect(issuePaths({ type: "OUT", quantity: 1, targetAssetId: "not a cuid" })).toEqual([
      "targetAssetId",
    ]);
  });

  test("stays strict: an unknown key is rejected", () => {
    expect(
      CreateConsumableMovementSchema.safeParse({ type: "OUT", quantity: 1, targetTeamId: "x" })
        .success,
    ).toBe(false);
  });
});

describe("CreateConsumableMovementSchema — returns", () => {
  test("accepts an IN with a returnOfId", () => {
    expect(
      CreateConsumableMovementSchema.safeParse({ type: "IN", quantity: 1, returnOfId: 7 }).success,
    ).toBe(true);
  });

  test.each(["OUT", "ADJUSTMENT"] as const)("rejects returnOfId on %s", (type) => {
    expect(issuePaths({ type, quantity: 1, returnOfId: 7 })).toEqual(["returnOfId"]);
  });

  test("a return cannot also name a target (the target is not on an OUT)", () => {
    expect(issuePaths({ type: "IN", quantity: 1, returnOfId: 7, targetUserId: USER })).toEqual([
      "targetUserId",
    ]);
  });

  test("returnOfId must be a positive int4", () => {
    expect(issuePaths({ type: "IN", quantity: 1, returnOfId: 0 })).toEqual(["returnOfId"]);
    expect(issuePaths({ type: "IN", quantity: 1, returnOfId: 2_147_483_648 })).toEqual([
      "returnOfId",
    ]);
    expect(issuePaths({ type: "IN", quantity: 1, returnOfId: 1.5 })).toEqual(["returnOfId"]);
  });
});

describe("ConsumableMovementSchema — tolerant read", () => {
  const LEGACY = {
    id: 1,
    consumableId: "ckconsumable0000000000001",
    type: "OUT",
    quantity: 2,
    reason: null,
    performedById: null,
    notes: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  test("a row without any delivery field (older API) still reads", () => {
    expect(ConsumableMovementSchema.safeParse(LEGACY).success).toBe(true);
  });

  test("a delivery row with a resolved target reads", () => {
    expect(
      ConsumableMovementSchema.safeParse({
        ...LEGACY,
        targetUserId: USER,
        targetAssetId: null,
        targetLocationId: null,
        returnable: true,
        returnOfId: null,
        target: { type: "user", id: USER, displayName: "Ana Pérez", isOffboarded: false },
      }).success,
    ).toBe(true);
  });
});

describe("ConsumableDeliveryTargetSchema", () => {
  test("accepts each kind, live and soft-deleted", () => {
    for (const target of [
      { type: "user", id: USER, displayName: "Ana Pérez", isOffboarded: true },
      { type: "asset", id: ASSET, label: "LT-0042", isDeleted: false },
      { type: "location", id: LOCATION, name: "Floor 3", isDeleted: true },
    ]) {
      expect(ConsumableDeliveryTargetSchema.safeParse(target).success).toBe(true);
    }
  });

  test("accepts a REDACTED descriptor (null display fields)", () => {
    expect(
      ConsumableDeliveryTargetSchema.safeParse({
        type: "user",
        id: USER,
        displayName: null,
        isOffboarded: null,
      }).success,
    ).toBe(true);
  });

  test("rejects an unknown kind and a user id that is not a uuid", () => {
    expect(ConsumableDeliveryTargetSchema.safeParse({ type: "team", id: USER }).success).toBe(
      false,
    );
    expect(
      ConsumableDeliveryTargetSchema.safeParse({
        type: "user",
        id: ASSET,
        displayName: "x",
        isOffboarded: false,
      }).success,
    ).toBe(false);
  });
});

describe("Consumable returnable flag (ADR-0098)", () => {
  test("create: optional, a boolean when present", () => {
    expect(CreateConsumableSchema.parse({ name: "Headset" }).returnable).toBeUndefined();
    expect(CreateConsumableSchema.parse({ name: "Headset", returnable: true }).returnable).toBe(
      true,
    );
    expect(CreateConsumableSchema.safeParse({ name: "Headset", returnable: "yes" }).success).toBe(
      false,
    );
  });

  test("update: may toggle returnable alone", () => {
    expect(UpdateConsumableSchema.safeParse({ returnable: false }).success).toBe(true);
  });
});
