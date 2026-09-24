import { describe, expect, test } from "bun:test";
import { CreateConsumableMovementSchema } from "@lazyit/shared";
import {
  buildMovementPayload,
  buildReturnPayload,
  deliveryRangeFrom,
  deliveryReturnState,
  deliveryTargetQuery,
  resolveDeliveryTarget,
  returnedByDelivery,
} from "./deliveries";

const USER = "11111111-1111-4111-8111-111111111111";
const ASSET = "ckasset000000000000000001";
const LOCATION = "cklocation000000000000001";

describe("buildMovementPayload (ADR-0098)", () => {
  test("a plain movement carries no target and drops blank text", () => {
    expect(
      buildMovementPayload({ type: "OUT", quantity: 2, reason: "  ", notes: "" }),
    ).toEqual({ type: "OUT", quantity: 2 });
  });

  test.each([
    ["user", USER, "targetUserId"],
    ["asset", ASSET, "targetAssetId"],
    ["location", LOCATION, "targetLocationId"],
  ] as const)("an OUT to a %s sets exactly its target key", (kind, id, key) => {
    const payload = buildMovementPayload({
      type: "OUT",
      quantity: 1,
      reason: " issued ",
      target: { kind, id },
    });
    expect(payload).toEqual({ type: "OUT", quantity: 1, reason: "issued", [key]: id });
    // What the dialog sends is exactly what the shared (strict) contract accepts.
    expect(CreateConsumableMovementSchema.safeParse(payload).success).toBe(true);
  });

  test.each(["IN", "ADJUSTMENT"] as const)(
    "a target left in the form is dropped on %s (never a payload the API rejects)",
    (type) => {
      const payload = buildMovementPayload({
        type,
        quantity: 3,
        target: { kind: "user", id: USER },
      });
      expect(payload).toEqual({ type, quantity: 3 });
      expect(CreateConsumableMovementSchema.safeParse(payload).success).toBe(true);
    },
  );

  test("a kind with no picked id sends no target", () => {
    expect(
      buildMovementPayload({ type: "OUT", quantity: 1, target: { kind: "asset", id: "" } }),
    ).toEqual({ type: "OUT", quantity: 1 });
  });
});

describe("buildReturnPayload", () => {
  test("an IN linked to the delivery, notes trimmed", () => {
    const payload = buildReturnPayload({ deliveryId: 42, quantity: 2, notes: " back " });
    expect(payload).toEqual({ type: "IN", quantity: 2, returnOfId: 42, notes: "back" });
    expect(CreateConsumableMovementSchema.safeParse(payload).success).toBe(true);
  });

  test("blank notes are omitted", () => {
    expect(buildReturnPayload({ deliveryId: 7, quantity: 1, notes: "  " })).toEqual({
      type: "IN",
      quantity: 1,
      returnOfId: 7,
    });
  });
});

test("deliveryTargetQuery names the one target key", () => {
  expect(deliveryTargetQuery({ kind: "location", id: LOCATION })).toEqual({
    targetLocationId: LOCATION,
  });
});

describe("resolveDeliveryTarget", () => {
  test("untargeted → null", () => {
    expect(resolveDeliveryTarget(null)).toBeNull();
    expect(resolveDeliveryTarget(undefined)).toBeNull();
  });

  test("a live user links to their page", () => {
    expect(
      resolveDeliveryTarget({ type: "user", id: USER, displayName: "Ana Pérez", isOffboarded: false }),
    ).toEqual({ kind: "user", state: "live", label: "Ana Pérez", href: `/users/${USER}` });
  });

  test("an offboarded user is flagged and not linked", () => {
    expect(
      resolveDeliveryTarget({ type: "user", id: USER, displayName: "Ana Pérez", isOffboarded: true }),
    ).toEqual({ kind: "user", state: "gone", label: "Ana Pérez", href: null });
  });

  test("a deleted asset / archived location is flagged", () => {
    expect(
      resolveDeliveryTarget({ type: "asset", id: ASSET, label: "LT-0042", isDeleted: true }),
    ).toMatchObject({ state: "gone", label: "LT-0042" });
    expect(
      resolveDeliveryTarget({ type: "location", id: LOCATION, name: "Floor 3", isDeleted: false }),
    ).toEqual({ kind: "location", state: "live", label: "Floor 3", href: `/locations/${LOCATION}` });
  });

  test("REDACTED (null name) never exposes the id as a label", () => {
    const resolved = resolveDeliveryTarget({
      type: "user",
      id: USER,
      displayName: null,
      isOffboarded: null,
    });
    expect(resolved).toEqual({ kind: "user", state: "redacted" });
    expect(JSON.stringify(resolved)).not.toContain(USER);
  });

  test("a blank name is treated as redacted; a null flag beside a name reads as live", () => {
    expect(
      resolveDeliveryTarget({ type: "asset", id: ASSET, label: "  ", isDeleted: false }),
    ).toEqual({ kind: "asset", state: "redacted" });
    expect(
      resolveDeliveryTarget({ type: "asset", id: ASSET, label: "LT-1", isDeleted: null }),
    ).toMatchObject({ state: "live" });
  });
});

describe("returnedByDelivery / deliveryReturnState", () => {
  const ledger = [
    { id: 5, type: "IN" as const, quantity: 1, returnOfId: 2, returnable: null },
    { id: 4, type: "IN" as const, quantity: 1, returnOfId: 2, returnable: null },
    { id: 3, type: "IN" as const, quantity: 9, returnOfId: null, returnable: null },
    { id: 2, type: "OUT" as const, quantity: 3, returnOfId: null, returnable: true },
    { id: 1, type: "OUT" as const, quantity: 2, returnOfId: null, returnable: false },
  ];

  test("sums the returns linked to each delivery, ignoring plain INs", () => {
    expect([...returnedByDelivery(ledger)]).toEqual([[2, 2]]);
  });

  test("a returnable delivery shows returned / outstanding; others are null", () => {
    const returned = returnedByDelivery(ledger);
    expect(deliveryReturnState(ledger[3], returned)).toEqual({ returned: 2, outstanding: 1 });
    expect(deliveryReturnState(ledger[4], returned)).toBeNull();
    expect(deliveryReturnState(ledger[0], returned)).toBeNull();
  });

  test("outstanding never goes negative", () => {
    const returned = new Map([[2, 10]]);
    expect(deliveryReturnState(ledger[3], returned)).toEqual({ returned: 10, outstanding: 0 });
  });
});

describe("deliveryRangeFrom", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");

  test("any time has no lower bound", () => {
    expect(deliveryRangeFrom("all", now)).toBeUndefined();
  });

  test("a preset counts back whole days from now", () => {
    expect(deliveryRangeFrom("30d", now)).toBe("2026-08-25T12:00:00.000Z");
    expect(deliveryRangeFrom("365d", now)).toBe("2025-09-24T12:00:00.000Z");
  });
});
